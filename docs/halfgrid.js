/* 「背驰50%」策略屏：多级别 + 缠论笔 + 50% 分位。
 *
 * 级别：3-15 / 5-30 / 10-1 / 15-2 / 30-3 / 1-6
 * 方向：主级别零轴上→做多（找向下一笔的反弹），零轴下→做空（找向上一笔的回落）
 * 提醒：① 背驰最后一笔突破 50%  ② 次级别反弹到 50%
 * 只在本页看，不推钉钉。卡片样式复用 pgrid.js 的 buildPgCard()。
 */
'use strict';

const HG = {
  cols: 4,
  limit: 200,
  axis: 'all',      // all | above | below
  mode: 'all',      // all | 1 | 2
  items: [],
  entries: [],
  timer: null,
  hidden: new Set(),
  loading: false,
};

/* ---------------- 卡片 ---------------- */

function hgFmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(5);
  return n.toPrecision(4);
}

function hgUpdateCard(e, it) {
  const pr = it.pair || {};
  const up = pr.dir !== 'short';
  const card = e.card;

  card.dataset.sym = it.symbol;
  card.dataset.hgId = 'h|' + it.symbol + '|' + pr.sub + '-' + pr.main;
  card.classList.toggle('pg-long', up);
  card.classList.toggle('pg-short', !up);
  if (typeof isPinned === 'function') card.classList.toggle('pinned', isPinned(card.dataset.hgId));

  card.querySelector('.pg-sym').textContent = it.symbol;
  card.querySelector('.pg-price').textContent = pgFmtPrice(pr.price);
  const pct = Number(pr.changePct);
  const pctEl = card.querySelector('.pg-pct');
  pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  pctEl.className = 'pg-pct ' + (pct >= 0 ? 'up' : 'dn');

  const st = pr.stroke || {};
  const isDiv = !!pr.mode1;
  card.querySelector('.pg-info').innerHTML =
    `<span class="pg-vol" title="24小时成交额">额 ${pgFmtVol(pr.quoteVolume)}</span>`
    + `<span class="pg-pair">${pr.subLabel}→${pr.mainLabel}</span>`
    + `<span class="pg-dir ${up ? 'up' : 'dn'}">${up ? '看多' : '看空'}</span>`
    + `<span class="hg-mode ${isDiv ? 'div' : ''}">${isDiv ? '背驰50%' : (up ? '反弹50%' : '回落50%')}</span>`
    + `<span title="最后一笔高点到低点的根数">笔 <b>${st.bars}</b> 根</span>`
    + `<span title="最后一笔高点到低点的一半">50% ${hgFmt(st.mid)}</span>`
    + (pr.divergence ? `<span class="hg-ratio" title="本笔 MACD 面积 / 前一同向笔">面积 ${pr.divergence.areaRatio}</span>` : '');

  /* ---- K线 ---- */
  const cs = it.candles;
  if (!cs || !cs.length) return;
  const T = i => Math.floor(cs[i][0] / 1000);
  syncSeries(e.candle, cs.map((c, i) => ({ time: T(i), open: c[1], high: c[2], low: c[3], close: c[4] })));
  const line = arr => { const o = []; if (!Array.isArray(arr)) return o; for (let i = 0; i < arr.length; i++) if (arr[i] != null) o.push({ time: T(i), value: arr[i] }); return o; };
  syncSeries(e.ma7, line(it.ma7));
  syncSeries(e.ema7, line(it.ema7));
  syncSeries(e.ma25, []);
  syncSeries(e.pen, line(it.pen || it.strokes));   // 有笔就画，没有就清空

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
  }
  e.chart.priceScale('vol').applyOptions({ visible: false });
  syncSeries(e.vol, []);

  /* ---- 50% 价位线 + 价位标签 ---- */
  if (e.midLine) { try { e.candle.removePriceLine(e.midLine); } catch { /* 忽略 */ } e.midLine = null; }
  const mid = Number(st.mid);
  const chipEl = e.card.querySelector('.hg-mid');
  if (!Number.isFinite(mid) || mid <= 0) {
    if (chipEl) chipEl.style.display = 'none';
  } else {
    try {
      // 50% 线做成半透明，只当参考，不抢K线的视觉重心
      e.midLine = e.candle.createPriceLine({
        price: mid,
        color: isDiv ? 'rgba(240,185,11,0.26)' : 'rgba(139,160,189,0.22)',
        lineWidth: 1,
        lineStyle: 2,          // 虚线
        axisLabelVisible: true,
        axisLabelColor: isDiv ? 'rgba(240,185,11,0.22)' : 'rgba(139,160,189,0.18)',
        axisLabelTextColor: isDiv ? 'rgba(240,185,11,0.62)' : 'rgba(139,160,189,0.55)',
        title: '',
      });
    } catch { /* 忽略 */ }

    // 在「价格位」上标出 50%：一个小标签跟着该价位上下移动
    e._mid = mid;
    if (chipEl) {
      chipEl.style.display = '';
      chipEl.textContent = '50% ' + hgFmt(mid);
      chipEl.classList.toggle('div', isDiv);
      try { e.positionMid?.(); } catch { /* 忽略 */ }
    }
  }

  e.candle.setMarkers([]);
}

function ensureHgCards(items) {
  const grid = document.querySelector('#halfgrid');
  if (!grid) return [];
  while (HG.entries.length > items.length) {
    const e = HG.entries.pop();
    e.chart.remove();
    e.card.remove();
  }
  while (HG.entries.length < items.length) {
    const it = items[HG.entries.length];
    const card = buildPgCard();
    grid.appendChild(card);
    const e = initChart(card, it.minutes ?? 15);
    e.card = card;
    {
      const chip = document.createElement('div');
      chip.className = 'hg-mid';
      chip.style.display = 'none';
      card.appendChild(chip);
    }
    // 50% 标签：按 priceToCoordinate 定位，图表缩放/拖动后重新算
    e.positionMid = () => {
      const chip = card.querySelector('.hg-mid');
      if (!chip) return;
      const mid = Number(e._mid);
      if (!Number.isFinite(mid) || mid <= 0) { chip.style.display = 'none'; return; }
      const y = e.candle.priceToCoordinate(mid);
      if (y == null || !Number.isFinite(y)) { chip.style.display = 'none'; return; }
      const chartEl = card.querySelector('.pg-chart');
      chip.style.display = '';
      chip.style.top = Math.round((chartEl?.offsetTop || 0) + y) + 'px';
    };
    try {
      e.chart.timeScale().subscribeVisibleLogicalRangeChange(() => { try { e.positionMid(); } catch { /* 忽略 */ } });
    } catch { /* 忽略 */ }
    HG.entries.push(e);
    card.querySelector('.pg-acts').addEventListener('click', ev => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      ev.stopPropagation();
      const act = b.dataset.act;
      const id = card.dataset.hgId;
      if (act === 'pin' && typeof togglePin === 'function') {
        togglePin(id);
        card.classList.toggle('pinned', isPinned(id));
        const pb = card.querySelector('.pg-act[data-act="pin"]');
        if (pb) pb.title = isPinned(id) ? '已固定（固定的始终排在最前）' : '固定到最前';
      } else if (act === 'detail') {
        if (typeof openDetail === 'function') openDetail(card.dataset.sym);
      } else if (act === 'close') {
        HG.hidden.add(card.dataset.sym);
        loadHalf();
      }
    });
    card.addEventListener('click', () => {
      if (typeof openDetail === 'function') openDetail(card.dataset.sym);
    });
  }
  if (typeof syncCardOrder === 'function') syncCardOrder(grid, HG.entries.map(e => e.card));
  return HG.entries;
}

function applyHgCols() {
  const grid = document.querySelector('#halfgrid');
  if (grid) grid.style.setProperty('--pgcols', HG.cols);
}

/* ---------------- 数据 ---------------- */

async function loadHalf() {
  if (HG.loading) return;
  const grid = document.querySelector('#halfgrid');
  if (!grid) return;
  HG.loading = true;
  try {
    const qs = [`bars=120`, `limit=${HG.limit}`];
    if (HG.axis !== 'all') qs.push('axis=' + HG.axis);
    if (HG.mode !== 'all') qs.push('mode=' + HG.mode);
    const r = await fetch('/api/chanhalf?' + qs.join('&'));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();

    let items = (d.items || []).filter(it => !HG.hidden.has(it.symbol));
    items = items.map(it => ({ ...it, kind: 'half' }));
    if (typeof anchorPinned === 'function') items = anchorPinned(HG.items, items);
    if (typeof sortPinnedFirst === 'function') items = sortPinnedFirst(items);

    HG.items = items;
    applyHgCols();
    const entries = ensureHgCards(items);
    entries.forEach((e, i) => {
      if (!items[i]) return;
      try { hgUpdateCard(e, items[i]); } catch (err) { console.warn('half card 更新失败', items[i].symbol, err); }
    });

    const empty = document.querySelector('#half-empty');
    if (empty) empty.style.display = items.length ? 'none' : '';
    const live = document.querySelector('#half-live');
    if (live) {
      const n = items.length;
      live.textContent = n
        ? `共 ${d.total} 条（多 ${d.longs} / 空 ${d.shorts}，背驰 ${d.mode1}）· 展示 ${n} 张`
          + ` · 笔 ≥${(d.options || {}).minBars ?? 5} 根 + 回调 ≥${(d.options || {}).minPullBars ?? 5} 根 + 越过 50%`
          + ` · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
        : '暂无符合条件的信号';
    }
  } catch (e) {
    const live = document.querySelector('#half-live');
    if (live) live.textContent = '加载失败：' + e.message;
  } finally {
    HG.loading = false;
  }
}

function startHalfPoll() {
  if (HG.timer) return;
  loadHalf();
  HG.timer = setInterval(() => { if (!document.hidden) loadHalf(); }, 5000);
}

function stopHalfPoll() {
  if (HG.timer) { clearInterval(HG.timer); HG.timer = null; }
}

/* ---------------- 初始化 ---------------- */

(function initHalf() {
  const grid = document.querySelector('#halfgrid');
  if (!grid) return;

  const axisSeg = document.querySelector('#half-axis');
  if (axisSeg) {
    axisSeg.addEventListener('click', ev => {
      const b = ev.target.closest('[data-axis]');
      if (!b) return;
      HG.axis = b.dataset.axis;
      [...axisSeg.querySelectorAll('[data-axis]')].forEach(x => x.classList.toggle('on', x === b));
      loadHalf();
    });
  }

  const modeSeg = document.querySelector('#half-mode');
  if (modeSeg) {
    modeSeg.addEventListener('click', ev => {
      const b = ev.target.closest('[data-mode]');
      if (!b) return;
      HG.mode = b.dataset.mode;
      [...modeSeg.querySelectorAll('[data-mode]')].forEach(x => x.classList.toggle('on', x === b));
      loadHalf();
    });
  }

  const limSel = document.querySelector('#half-limit');
  if (limSel) limSel.addEventListener('change', () => {
    HG.limit = Math.max(20, Math.min(400, Number(limSel.value) || 200));
    loadHalf();
  });

  const rf = document.querySelector('#half-refresh');
  if (rf) rf.addEventListener('click', () => loadHalf());

  const reset = document.querySelector('#half-reset');
  if (reset) reset.addEventListener('click', () => { HG.hidden.clear(); loadHalf(); });
})();
