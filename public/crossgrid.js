/* 「阳线反包」屏：多级别 + 反包后回踩阴线提醒。卡片样式复用 pgrid.js 的 buildPgCard()。 */
'use strict';

const LV_LABEL = { '15m': '15分', '30m': '30分', '1h': '1小时', '2h': '2小时', '3h': '3小时', '6h': '6小时', '12h': '12小时' };

const CG = {
  cols: 4,
  limit: 200,
  axis: 'all',      // all | above | below
  depth: 0,         // 0=包覆当根 | 1 | 2 根回踩
  level: 'all',     // all | 15m | 30m | ...
  items: [],
  entries: [],
  timer: null,
  hidden: new Set(),
  loading: false,
};

function cgUpdateCard(e, it) {
  const pr = it.pair || {};
  const up = pr.dir !== 'short';
  const card = e.card;

  card.dataset.sym = it.symbol;
  card.dataset.cgId = 'c|' + it.symbol + '|' + pr.sub + '|' + pr.dir;
  card.classList.toggle('pg-long', up);
  card.classList.toggle('pg-short', !up);
  if (typeof isPinned === 'function') card.classList.toggle('pinned', isPinned(card.dataset.cgId));

  card.querySelector('.pg-sym').textContent = it.symbol;
  card.querySelector('.pg-price').textContent = pgFmtPrice(pr.price);
  const pct = Number(pr.changePct);
  const pctEl = card.querySelector('.pg-pct');
  pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  pctEl.className = 'pg-pct ' + (pct >= 0 ? 'up' : 'dn');

  const axisTxt = pr.axisSide === 'above' ? '零轴上' : '零轴下';   // 按 DIF 判，只有两种
  card.querySelector('.pg-info').innerHTML =
    `<span class="pg-vol" title="24小时成交额">额 ${pgFmtVol(pr.quoteVolume)}</span>`
    + `<span class="pg-pair">${pr.levelLabel || pr.subLabel || pr.sub}</span>`
    + `<span class="pg-dir ${up ? 'up' : 'dn'}">${up ? '看多' : '看空'}</span>`
    + `<span class="cg-axis ${pr.axisSide}" title="反包那一刻 DIF 在零轴哪一侧">${axisTxt}（DIF ${Number(pr.crossDif).toPrecision(3)}）</span>`
    + `<span class="cg-engulf">${pr.variantLabel || '反包'}</span>`
    + `<span class="cg-depth">${pr.depthLabel || ('回踩 ' + pr.depth + ' 根')}</span>`
    + (pr.surge ? `<span class="cg-surge" title="包覆那根的放量程度">放量 ${pr.surge.gainPct >= 0 ? '+' : ''}${pr.surge.gainPct}%（量 ${pr.surge.volRatio}×）</span>` : '')
    + `<span title="交叉那一刻">DIF ${Number(pr.crossDif).toPrecision(3)} / DEA ${Number(pr.crossDea).toPrecision(3)}</span>`;

  const cs = it.candles;
  if (!cs || !cs.length) return;
  const T = i => Math.floor(cs[i][0] / 1000);
  syncSeries(e.candle, cs.map((c, i) => ({ time: T(i), open: c[1], high: c[2], low: c[3], close: c[4] })));
  const line = arr => { const o = []; if (!Array.isArray(arr)) return o; for (let i = 0; i < arr.length; i++) if (arr[i] != null) o.push({ time: T(i), value: arr[i] }); return o; };
  syncSeries(e.ma7, line(it.ma7));
  syncSeries(e.ema7, line(it.ema7));
  syncSeries(e.ma25, []);
  syncSeries(e.pen, []);

  const m = it.macd;
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
    // MACD 零轴：一条虚线，用来核对「零轴上 / 零轴下」
    if (e.zeroLine) { try { e.macdHist.removePriceLine(e.zeroLine); } catch (err) { /* 忽略 */ } e.zeroLine = null; }
    try {
      e.zeroLine = e.macdHist.createPriceLine({
        price: 0,
        color: 'rgba(139,160,189,.55)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: false,
        title: '',
      });
    } catch (err) { /* 忽略 */ }
  }
  e.chart.priceScale('vol').applyOptions({ visible: false });
  syncSeries(e.vol, []);

  // 在图上标出「交叉」那一根
  const markers = [];
  const ct = pr.crossT ? Math.floor(pr.crossT / 1000) : null;
  const firstT = cs.length ? T(0) : 0, lastT = cs.length ? T(cs.length - 1) : 0;
  if (ct && ct >= firstT && ct <= lastT) {
    markers.push({ time: ct, position: 'aboveBar', color: '#f0b90b', shape: 'square', text: '反包' });
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
      const id = card.dataset.cgId;
      if (act === 'pin' && typeof togglePin === 'function') {
        togglePin(id);
        card.classList.toggle('pinned', isPinned(id));
      } else if (act === 'detail') {
        if (typeof openDetail === 'function') openDetail(card.dataset.sym);
      } else if (act === 'close') {
        CG.hidden.add(card.dataset.sym);
        loadCrossPb();
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
    const qs = ['bars=120', 'limit=' + CG.limit, 'depth=' + CG.depth];
    if (CG.level !== 'all') qs.push('level=' + CG.level);
    if (CG.axis !== 'all') qs.push('axis=' + CG.axis);
    const r = await fetch('/api/crosspb?' + qs.join('&'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();

    let items = (d.items || []).filter(it => !CG.hidden.has(it.symbol));
    items = items.map(it => ({ ...it, kind: 'crosspb' }));
    if (typeof anchorPinned === 'function') items = anchorPinned(CG.items, items);
    if (typeof sortPinnedFirst === 'function') items = sortPinnedFirst(items);

    CG.items = items;
    applyCgCols();
    const entries = ensureCgCards(items);
    entries.forEach((e, i) => {
      if (!items[i]) return;
      try { cgUpdateCard(e, items[i]); } catch (err) { console.warn('crosspb card', items[i].symbol, err); }
    });

    const empty = document.querySelector('#cg-empty');
    if (empty) empty.style.display = items.length ? 'none' : '';
    const live = document.querySelector('#cg-live');
    if (live) {
      live.textContent = items.length
        ? `共 ${d.total} 条（多 ${d.longs} / 空 ${d.shorts}）· 展示 ${items.length} 张`
          + ` · ${(d.options || {}).depth === 0 ? '包覆当根' : ((d.options || {}).depth ?? 0) + ' 根回踩'}`
          + ` · ${(d.options || {}).level === 'all' ? '全部级别' : (LV_LABEL[(d.options || {}).level] || (d.options || {}).level || '')}`
          + ` · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
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
  CG.timer = setInterval(() => { if (!document.hidden) loadCrossPb(); }, 5000);
}
function stopCgPoll() {
  if (CG.timer) { clearInterval(CG.timer); CG.timer = null; }
}

(function initCrossPb() {
  const grid = document.querySelector('#cggrid');
  if (!grid) return;

  const axisSeg = document.querySelector('#cg-axis');
  if (axisSeg) axisSeg.addEventListener('click', ev => {
    const b = ev.target.closest('[data-axis]');
    if (!b) return;
    CG.axis = b.dataset.axis;
    [...axisSeg.querySelectorAll('[data-axis]')].forEach(x => x.classList.toggle('on', x === b));
    loadCrossPb();
  });

  const depthSeg = document.querySelector('#cg-depth');
  if (depthSeg) depthSeg.addEventListener('click', ev => {
    const b = ev.target.closest('[data-depth]');
    if (!b) return;
    CG.depth = Number(b.dataset.depth);   // 0 也要能选中
    [...depthSeg.querySelectorAll('[data-depth]')].forEach(x => x.classList.toggle('on', x === b));
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
  const reset = document.querySelector('#cg-reset');
  if (reset) reset.addEventListener('click', () => { CG.hidden.clear(); loadCrossPb(); });
})();
