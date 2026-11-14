/* 「阳内阴回踩」屏：多级别 + 阳线后一根被包含的阴线。卡片样式复用 pgrid.js 的 buildPgCard()。 */
'use strict';

const CG = {
  cols: 4,
  limit: 200,
  axis: 'all',      // all | above | below
  level: 'all',     // all | 15m | 30m | 1h | 2h | 3h | 4h | 6h | 12h
  dir: 'all',       // all | long（阳内阴）| short（阴内阳）
  items: [],
  entries: [],
  timer: null,
  loading: false,
};

function cgUpdateCard(e, it) {
  const pr = it.pair || {};
  const card = e.card;

  card.dataset.sym = it.symbol;
  card.dataset.cgId = 'c|' + it.symbol + '|' + pr.sub;
  const isShort = pr.dir === 'short';
  card.classList.toggle('pg-short', isShort);
  card.classList.toggle('pg-long', !isShort);
  if (typeof isPinned === 'function') card.classList.toggle('pinned', isPinned(card.dataset.cgId));

  card.querySelector('.pg-sym').textContent = it.symbol;
  card.querySelector('.pg-price').textContent = pgFmtPrice(pr.price);
  const pct = Number(pr.changePct);
  const pctEl = card.querySelector('.pg-pct');
  pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  pctEl.className = 'pg-pct ' + (pct >= 0 ? 'up' : 'dn');

  const axisTxt = pr.axisSide === 'above' ? '零轴上' : '零轴下';
  card.querySelector('.pg-info').innerHTML =
    `<span class="pg-vol" title="24小时成交额">额 ${pgFmtVol(pr.quoteVolume)}</span>`
    + `<span class="pg-pair">${pr.levelLabel || pr.subLabel || pr.sub}</span>`
    + `<span class="pg-dir ${pr.dir === 'short' ? 'dn' : 'up'}">${pr.dir === 'short' ? '看空' : '看多'}</span>`
    + `<span class="cg-axis ${pr.axisSide}" title="当前K收盘时的 DIF 在零轴哪一侧">${axisTxt}（DIF ${Number(pr.crossDif).toPrecision(3)}）</span>`
    + `<span class="cg-engulf">${pr.variantLabel || '阳内阴'}</span>`
    + `<span class="cg-depth" title="阴线实体跌幅">阴 ${pr.surge.gainPct}%</span>`
    + `<span title="这根阴线的收盘时间（信号时间）">收盘 ${new Date(it.at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)}</span>`
    + `<span title="这根阴线：开 → 收">阴 ${Number(pr.open).toPrecision(4)} → ${Number(pr.close).toPrecision(4)}</span>`
    + `<span title="包含它的那根阳线：开 → 收">阳 ${Number(pr.pivot.o).toPrecision(4)} → ${Number(pr.pivot.c).toPrecision(4)}</span>`;

  // 照常画到当前（含正在走的那根）—— 右边必须顶到「现在」，
  // 否则图表会停在上一根，看起来像数据没跟上。信号箭头标在左边那根确认K上。
  const cs = it.candles;
  if (!cs || !cs.length) return;
  const cut = arr => arr;
  const ms = (it.minutes || 15) * 60000;
  const T = i => Math.floor(cs[i][0] / 1000);
  syncSeries(e.candle, cs.map((c, i) => ({ time: T(i), open: c[1], high: c[2], low: c[3], close: c[4] })));
  const line = arr => { const o = []; if (!Array.isArray(arr)) return o; for (let i = 0; i < arr.length; i++) if (arr[i] != null) o.push({ time: T(i), value: arr[i] }); return o; };
  syncSeries(e.ma7, line(cut(it.ma7)));
  syncSeries(e.ema7, line(cut(it.ema7)));
  syncSeries(e.ma25, []);
  syncSeries(e.pen, []);

  const m = it.macd ? { hist: cut(it.macd.hist), dif: cut(it.macd.dif), dea: cut(it.macd.dea) } : null;
  if (m) {
    const hist = [], dif = [], dea = [];
    for (let i = 0; i < cs.length; i++) {
      const hv = m.hist[i];
      if (hv != null) hist.push({ time: T(i), value: hv, color: hv >= 0 ? 'rgba(246,70,93,.75)' : 'rgba(14,203,129,.75)' });
      const dv = m.dif[i];
      if (dv != null) dif.push({ time: T(i), value: dv });
      const ev = m.dea[i];
      if (ev != null) dea.push({ time: T(i), value: ev });
    }
    syncSeries(e.macdHist, hist);
    syncSeries(e.macdDif, dif);
    syncSeries(e.macdDea, dea);
    e.chart.priceScale('macd').applyOptions({ visible: true, scaleMargins: { top: 0.74, bottom: 0.02 } });
    if (e.zeroLine) { try { e.macdHist.removePriceLine(e.zeroLine); } catch (err) { /* 忽略 */ } e.zeroLine = null; }
    try {
      e.zeroLine = e.macdHist.createPriceLine({
        price: 0, color: 'rgba(139,160,189,.55)', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: false, title: '',
      });
    } catch (err) { /* 忽略 */ }
  }
  e.chart.priceScale('vol').applyOptions({ visible: false });
  syncSeries(e.vol, []);

  // 在图上标出「被包含的那根阴线」
  // 信号那根 = 最新一根**已收盘**的K（数组最后一根可能是正在走的）
  const markers = [];
  const nowMs = Date.now();
  let sigIdx = cs.length - 1;
  while (sigIdx >= 0 && cs[sigIdx][0] + ms > nowMs) sigIdx--;
  if (sigIdx >= 0) {
    // 做多标在下方向上箭头（青色），做空标在上方向下箭头（橙红）
    const isShortBar = pr.dir === 'short';
    markers.push({
      time: T(sigIdx),
      position: isShortBar ? 'aboveBar' : 'belowBar',
      color: isShortBar ? '#f6465d' : '#4aa8ff',
      shape: isShortBar ? 'arrowDown' : 'arrowUp',
      text: isShortBar ? '阴内阳' : '阳内阴',
    });
  }
  e.candle.setMarkers(markers.sort((a, b) => a.time - b.time));
}

function ensureCgCards(items) {
  const grid = document.querySelector('#cggrid');
  if (!grid) return [];
  while (CG.entries.length > items.length) {
    const e = CG.entries.pop();
    e.chart.remove();
    e.card.remove();
  }
  while (CG.entries.length < items.length) {
    const it = items[CG.entries.length];
    const card = buildPgCard();
    grid.appendChild(card);
    const e = initChart(card, it.minutes ?? 15);
    e.card = card;
    CG.entries.push(e);
    card.querySelector('.pg-acts').addEventListener('click', ev => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      ev.stopPropagation();
      const act = b.dataset.act;
      if (act === 'pin' && typeof togglePin === 'function') {
        togglePin(card.dataset.cgId);
        card.classList.toggle('pinned', isPinned(card.dataset.cgId));
      } else if (act === 'detail') {
        if (typeof openDetail === 'function') openDetail(card.dataset.sym);
      } else if (act === 'close') {
        card.style.display = 'none';
      }
    });
    card.addEventListener('click', () => { if (typeof openDetail === 'function') openDetail(card.dataset.sym); });
  }
  if (typeof syncCardOrder === 'function') syncCardOrder(grid, CG.entries.map(e => e.card));
  return CG.entries;
}

function applyCgCols() {
  const grid = document.querySelector('#cggrid');
  if (grid) grid.style.setProperty('--pgcols', CG.cols);
}

async function loadCrossPb() {
  if (CG.loading) return;
  const grid = document.querySelector('#cggrid');
  if (!grid) return;
  CG.loading = true;
  try {
    const qs = ['bars=120', 'limit=' + CG.limit];
    if (CG.axis !== 'all') qs.push('axis=' + CG.axis);
    if (CG.level !== 'all') qs.push('level=' + CG.level);
    if (CG.dir === 'yangyin') { qs.push('pattern=inner'); qs.push('side=long'); }
    else if (CG.dir === 'yinyang') { qs.push('pattern=inner'); qs.push('side=short'); }
    else if (CG.dir === 'dbl-long') { qs.push('pattern=dbl'); qs.push('side=long'); }
    else if (CG.dir === 'dbl-short') { qs.push('pattern=dbl'); qs.push('side=short'); }
    const r = await fetch('/api/crosspb?' + qs.join('&'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();

    let items = (d.items || []).map(it => ({ ...it, kind: 'crosspb' }));
    if (typeof anchorPinned === 'function') items = anchorPinned(CG.items, items);
    if (typeof sortPinnedFirst === 'function') items = sortPinnedFirst(items);

    CG.items = items;
    applyCgCols();
    const entries = ensureCgCards(items);
    entries.forEach((e, i) => {
      e.card.style.display = '';
      if (!items[i]) return;
      try { cgUpdateCard(e, items[i]); } catch (err) { console.warn('crosspb card', items[i].symbol, err); }
    });

    const empty = document.querySelector('#cg-empty');
    if (empty) empty.style.display = items.length ? 'none' : '';
    const live = document.querySelector('#cg-live');
    if (live) {
      live.textContent = items.length
        ? `共 ${d.total} 条 · 展示 ${items.length} 张 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
        : '暂无符合条件的信号';
    }
  } catch (e) {
    const live = document.querySelector('#cg-live');
    if (live) live.textContent = '加载失败：' + e.message;
  } finally {
    CG.loading = false;
  }
}

function startCgPoll() {
  if (CG.timer) return;
  loadCrossPb();
  CG.timer = setInterval(() => { if (!document.hidden) loadCrossPb(); }, 3000);
}
function stopCgPoll() {
  if (CG.timer) { clearInterval(CG.timer); CG.timer = null; }
}

(function initCrossPb() {
  const grid = document.querySelector('#cggrid');
  if (!grid) return;

  const dirSeg = document.querySelector('#cg-dir');
  if (dirSeg) dirSeg.addEventListener('click', ev => {
    const b = ev.target.closest('[data-dir]');
    if (!b) return;
    CG.dir = b.dataset.dir;
    [...dirSeg.querySelectorAll('[data-dir]')].forEach(x => x.classList.toggle('on', x === b));
    loadCrossPb();
  });

  const axisSeg = document.querySelector('#cg-axis');
  if (axisSeg) axisSeg.addEventListener('click', ev => {
    const b = ev.target.closest('[data-axis]');
    if (!b) return;
    CG.axis = b.dataset.axis;
    [...axisSeg.querySelectorAll('[data-axis]')].forEach(x => x.classList.toggle('on', x === b));
    loadCrossPb();
  });

  const lvSel = document.querySelector('#cg-level');
  if (lvSel) lvSel.addEventListener('change', () => { CG.level = lvSel.value || 'all'; loadCrossPb(); });

  const limSel = document.querySelector('#cg-limit');
  if (limSel) limSel.addEventListener('change', () => {
    CG.limit = Math.max(20, Math.min(400, Number(limSel.value) || 200));
    loadCrossPb();
  });

  const rf = document.querySelector('#cg-refresh');
  if (rf) rf.addEventListener('click', () => loadCrossPb());
})();
