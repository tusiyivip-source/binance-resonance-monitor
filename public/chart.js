/* K 线图视图 —— 基于 TradingView Lightweight Charts（已本地化，不走 CDN）
 *
 * 两个视图共用同一套建图/绘制代码：
 *   multi  多级别视图：当前币种的 14 个级别按周期升序铺开
 *   alert  报警视图：右侧每条报警取它**组合里的确认级别**画一张，按报警顺序排列
 *
 * 配色与交互：
 *   涨 = 红 #f6465d，跌 = 绿 #0ecb81（币安习惯）
 *   MA7 = 金 #f0b90b，EMA7 = 青 #0ef0f0，MA25 = 紫
 *   十字光标磁吸、金黄标签、滚轮缩放、拖拽平移
 *   副图：MACD（柱 + DIF/DEA）；叠加：缠论笔折线 + 顶/底分型标记
 */
'use strict';

const LC = window.LightweightCharts;

const C = {
  up: '#f6465d', down: '#0ecb81',
  ma7: '#f0b90b', ema7: '#0ef0f0', ma25: '#a78bfa',
  text: '#848e9c', grid: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.1)',
  gold: '#f0b90b', pen: '#94a3b8',
};

const COL_H = { 1: 480, 2: 360, 3: 300, 4: 250, 5: 210, 7: 170 };
const HEAD_H = 28, CARD_BORDER = 2, GAP = 10, GRID_PAD = 10;
const TARGET_RATIO = 1.6;          // 绘图区目标宽高比
const MIN_CH = 95, MIN_CW = 165;   // 多级别视图：尽量塞进一屏，允许缩到这个下限
const PX_PER_CANDLE = 5.5;

/* 报警视图：不硬塞一屏，优先保证可读尺寸，放不下就滚动 */
const ALERT_MIN_H = { compact: 0, normal: 220, large: 300, xl: 420 };
const ALERT_MIN_W = 300;
function alertMinH() {
  const v = document.querySelector('#alert-size')?.value ?? 'normal';
  return ALERT_MIN_H[v] ?? ALERT_MIN_H.normal;
}

/* ---------------- 视图状态 ---------------- */
const VIEWS = {
  alert: { kind: 'alert', grid: null, entries: [], items: [], roles: {}, cols: 4 },
  zero: { kind: 'zero', grid: null, entries: [], items: [], roles: {}, cols: 4, minBars: 120 },
  single: { kind: 'single', grid: null, entries: [], items: [], roles: {}, cols: 4, minBars: 100 },
  pair: { kind: 'pair', grid: null, entries: [], items: [], roles: {}, cols: 2, minBars: 100 },
};
let activeView = 'matrix';         // 'matrix' | 'alert' | 'zero'
let viewTimer = null;

/* ---------------- 视图切换 ---------------- */
function setView(mode) {
  for (const view of Object.values(VIEWS)) view.controller?.abort();
  activeView = mode;
  const isChart = mode === 'alert' || mode === 'zero' || mode === 'single';
  const isPair = mode === 'pair';
  document.body.classList.toggle('chartmode', isChart);
  document.body.classList.toggle('alertchartmode', mode === 'alert');
  document.body.classList.toggle('zerochartmode', mode === 'zero');
  document.body.classList.toggle('zeromonitor', mode === 'zero' || mode === 'matrix' || isPair);
  document.body.classList.toggle('singlemode', mode === 'single');
  document.body.classList.toggle('pgridmode', mode === 'pgrid');
  document.body.classList.toggle('singlechartmode', mode === 'single');
  document.querySelector('#tab-zero').classList.toggle('on', mode === 'matrix' || mode === 'zero' || isPair);
  const ts = document.querySelector('#tab-single');
  if (ts) ts.classList.toggle('on', mode === 'single');
  document.querySelector('#tab-alert').classList.toggle('on', mode === 'alert');
  const tpg = document.querySelector('#tab-pgrid');
  if (tpg) tpg.classList.toggle('on', mode === 'pgrid');
  // 多级别视图才有币种切换控件
  const csb = document.querySelector('#chart-symbar');
  if (csb) csb.style.display = 'none';   // 多级别视图已移除
  document.querySelector('#alert-symbar').style.display = mode === 'alert' ? '' : 'none';
  const zs = document.querySelector('#zero-symbar');
  if (zs) zs.style.display = (mode === 'zero' || mode === 'matrix' || isPair) ? '' : 'none';
  const pgs = document.querySelector('#pg-symbar');
  if (pgs) pgs.style.display = mode === 'pgrid' ? '' : 'none';
  const sbar = document.querySelector('#single-bar');
  if (sbar) sbar.style.display = mode === 'single' ? '' : 'none';
  // 'single' 表格模式下不需要图表轮询；K线模式下才启动
  // single 有两种模式：K线图要轮询图表，表格不需要（表格自己的轮询在 app.js）
  const singleTable = mode === 'single'
    && document.querySelector('#single-mode')?.value === 'table';
  if (mode === 'matrix' || isPair || mode === 'pgrid' || singleTable) stopLoop(); else startLoop();
  // 配对全景自己轮询，进出该视图时启停
  if (mode === 'pgrid') { if (typeof startPgPoll === 'function') startPgPoll(); }
  else { if (typeof stopPgPoll === 'function') stopPgPoll(); }
}

function startLoop() {
  stopLoop();
  refreshActive();
  viewTimer = setInterval(refreshActive, 3000);
}
function stopLoop() {
  if (viewTimer) { clearInterval(viewTimer); viewTimer = null; }
}
function refreshActive() {
  if (document.hidden) return;
  if (activeView === 'pair') refreshPairView();
  else if (activeView === 'single') refreshSingleView();
  else if (activeView === 'alert') refreshAlertView();
  // 零轴标签页已换成配对监控表，刷新由 pair.js 自己轮询，这里不再拉图表
}

/* ---------------- 布局 ---------------- */
// 多级别视图已移除，列数由各视图自己的尺寸下拉（alert-size / zero-size）决定，
// 这里保留一个恒为 null 的入口，表示「交给 fitCardSizes 自适应」。
function currentCols() { return null; }

/**
 * 布局试算。
 * @param {number} minH 卡片绘图区的**最小可读高度**：低于它宁可滚动也不压缩
 * @param {number} minW 卡片最小宽度
 *
 * 两段式判定：
 *   1. 优先选「整屏能铺满」的方案里宽高比最好的；
 *   2. 一个都铺不满时（报警很多），选**行数最少**的（列数最多）——
 *      反正要滚动，列多一行能少滚很多，同时宽高比不偏离目标太多。
 */
function computeFit(grid, n, minH = 0, minW = MIN_CW) {
  const availH = grid.clientHeight;
  const availW = grid.clientWidth;
  if (!availH || !availW || !n) return null;
  const cand = [];
  for (let cols = 2; cols <= 8; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (availW - GRID_PAD * 2 - (cols - 1) * GAP) / cols;
    if (cw < minW) continue;
    const chFit = (availH - GRID_PAD * 2 - (rows - 1) * GAP) / rows - HEAD_H - CARD_BORDER;
    const ch = Math.max(minH, Math.floor(chFit));
    if (ch < MIN_CH) continue;
    const score = Math.abs(Math.log(((cw - 70) / ch) / TARGET_RATIO));
    const totalH = rows * (ch + HEAD_H + CARD_BORDER) + (rows - 1) * GAP;
    cand.push({ cols, rows, ch, cw: Math.floor(cw), score, fits: chFit >= ch, totalH });
  }
  if (!cand.length) return null;
  const fitting = cand.filter(c => c.fits && c.totalH <= availH - 1);
  if (fitting.length) {
    fitting.sort((a, b) => a.score - b.score);
    return fitting[0];
  }
  // 都放不下：列数多 = 行数少 = 滚动少，优先行数少，其次看比例
  cand.sort((a, b) => (a.rows - b.rows) || (a.score - b.score));
  return cand[0];
}

function applyCols(view) {
  const grid = view.grid;
  if (!grid) return;
  const n = grid.childElementCount || 14;
  const fixed = currentCols();
  const isAlert = view.kind === 'alert';
  const isZero = view.kind === 'zero';
  const isSingle = view.kind === 'single';
  const isPair = view.kind === 'pair';
  const zeroSize = document.querySelector('#zero-size')?.value || 'normal';
  const minH = isZero ? ({compact:140, normal:230, large:320, xl:430}[zeroSize] || 230)
    : isAlert && document.querySelector('#alert-size').value !== 'compact' ? alertMinH() : 0;
  const minW = isZero ? 340 : isAlert && minH ? ALERT_MIN_W : MIN_CW;
  let cols, ch;
  if (isPair) {
    // 配对图的列数由工具条决定
    const want = Math.max(1, Math.min(4, +(document.querySelector('#pair-size')?.value) || 2));
    cols = want;
    ch = ({ 1: 520, 2: 420, 3: 340, 4: 300 }[want] || 420);
    view.cols = cols; view.rows = Math.ceil(n / cols); view.fits = true;
  } else if (isSingle) {
    // 单K图默认一行 2 张：塞得太多图表太矮，K 线细节看不清
    const want = Math.max(1, Math.min(4, +(document.querySelector('#single-size')?.value) || 2));
    cols = want;
    ch = ({ 1: 520, 2: 420, 3: 340, 4: 300 }[want] || 420);
    view.cols = cols;
    view.rows = Math.ceil(n / cols);
    view.fits = true;
  } else if (fixed) {
    cols = fixed; ch = Math.max(minH, COL_H[fixed] ?? Math.round(1200 / fixed));
  } else {
    const fit = computeFit(grid, n, minH, minW);
    if (fit) { cols = fit.cols; ch = fit.ch; view.fits = fit.fits; view.rows = fit.rows; }
    else { cols = 4; ch = Math.max(minH, COL_H[4]); view.fits = false; view.rows = Math.ceil(n / cols); }
  }
  view.cols = cols;
  grid.style.setProperty('--cols', cols);
  grid.style.setProperty('--ch', ch + 'px');
  layoutSpans(view, cols);
  // 尺寸没变就不要调 applyOptions：改动图表尺寸会让 Lightweight Charts 重置十字光标，
  // 结果是悬停时每 3 秒刷新一次 tooltip 就闪一下（实测到的真实问题）。
  requestAnimationFrame(() => view.entries.forEach(e => {
    const holder = e.card.querySelector('.cchart');
    if (!holder) return;
    const w = holder.clientWidth, h = holder.clientHeight;
    if (e._w === w && e._h === h) return;
    try { e.chart.applyOptions({ width: w, height: h }); e._w = w; e._h = h; } catch { }
  }));
}

/** 末行不满时把剩下的卡片横向拉宽填满整行 */
function layoutSpans(view, cols) {
  const cards = [...view.grid.children];
  const n = cards.length;
  // 必须全部清掉：内联 grid-column 优先级高于 .zoomed 的 CSS 规则
  for (const c of cards) c.style.gridColumn = '';
  if (!cols || !n) return;
  const rem = n % cols;
  if (rem === 0 || cols % rem !== 0) return;
  const span = cols / rem;
  if (span < 2) return;
  for (let i = n - rem; i < n; i++) {
    if (!cards[i].classList.contains('zoomed')) cards[i].style.gridColumn = `span ${span}`;
  }
}

/** 自动根数：按单张卡片宽度反推，保证每根蜡烛的像素宽度 */
function currentBars(view) {
  const sel = document.querySelector('#chart-bars').value;
  let bars;
  if (sel !== 'auto') {
    bars = +sel;
  } else {
    const grid = view.grid;
    const cols = view.cols || 2;
    const avail = (grid.clientWidth || 1200) - GRID_PAD * 2 - (cols - 1) * GAP;
    const cardW = Math.max(260, avail / cols) - 70;
    bars = Math.max(30, Math.min(400, Math.round(cardW / PX_PER_CANDLE)));
  }
  // 某些视图有最低根数要求：零轴视图必须看够「连续不破零轴」的那一段，
  // 按卡片宽度算出来的 40 来根根本不够（hold 本身就可能到 60 根）。
  if (view.minBars) bars = Math.max(bars, view.minBars);
  return bars;
}

/* ---------------- 建图 ---------------- */
function buildCard() {
  const card = document.createElement('div');
  card.className = 'chartcard';
  card.innerHTML = `<div class="cchead">
      <span class="lv"></span>
      <span class="roles"></span>
      <span class="st"></span>
      <span class="sp"></span>
      <span class="px"></span>
      <button class="pinbtn" type="button" title="固定到最前面（后续更新不会把它挤下去）">📌</button>
    </div>
    <div class="zero-meta" hidden></div>
    <div class="cchart"></div>`;
  // 置顶按钮：点一次固定、再点一次取消
  card.querySelector('.pinbtn').addEventListener('click', e => {
    e.stopPropagation();
    const id = card.dataset.pinId;
    if (!id) return;
    togglePin(id);
    card.classList.toggle('pinned', isPinned(id));
    const view = card._view || (card.closest('.chartgrid') ? null : null);
    if (typeof rerenderCurrentView === 'function') rerenderCurrentView();
  });
  return card;
}

/* ---------------- 置顶（固定） ---------------- */
const PIN_KEY = 'dsh.pinnedCards';
let PINNED = new Set();
try {
  const raw = localStorage.getItem(PIN_KEY);
  if (raw) PINNED = new Set(JSON.parse(raw));
} catch { /* localStorage 不可用时退化为内存 */ }

function isPinned(id) { return PINNED.has(id); }
function togglePin(id) {
  if (PINNED.has(id)) PINNED.delete(id); else PINNED.add(id);
  try { localStorage.setItem(PIN_KEY, JSON.stringify([...PINNED])); } catch { /* 忽略 */ }
}
/** 每张卡片的稳定身份（币种 + 具体形态） */
function pinIdOf(it) {
  if (it.kind === 'pair' && it.pair) return 'p|' + it.symbol + '|' + it.pair.sub + '-' + it.pair.main;
  if (it.kind === 'single' && it.single) return 's|' + it.symbol + '|' + it.single.level + '|' + it.side;
  if (it.kind === 'singlek') return 's|' + it.symbol + '|' + it.level + '|' + it.side;
  return (it.kind || 'x') + '|' + it.symbol + '|' + (it.key || '');
}
/** 置顶的排到最前，其余保持原顺序（稳定） */
function sortPinnedFirst(items) {
  if (!PINNED.size) return items;
  const on = [], off = [];
  for (const it of items) (isPinned(pinIdOf(it)) ? on : off).push(it);
  return on.length ? on.concat(off) : items;
}
/** 卡片建好后同步 pinId 与高亮状态 */
function syncPinBadge(card, it) {
  const id = pinIdOf(it);
  card.dataset.pinId = id;
  card._view = card._view;
  card.classList.toggle('pinned', isPinned(id));
  const btn = card.querySelector('.pinbtn');
  if (btn) btn.title = isPinned(id) ? '已固定（点一下取消）' : '固定到最前面';
}

function initChart(card, minutes) {
  const holder = card.querySelector('.cchart');
  const chart = LC.createChart(holder, {
    width: card.clientWidth,
    height: holder.clientHeight,
    layout: { background: { color: 'transparent' }, textColor: C.text, fontSize: 11 },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    crosshair: {
      mode: LC.CrosshairMode.Magnet,
      vertLine: { color: 'rgba(255,255,255,0.3)', style: 2, width: 1, labelVisible: true, labelBackgroundColor: C.gold },
      horzLine: { color: C.gold, style: 1, width: 1, labelVisible: true, labelBackgroundColor: C.gold, labelTextColor: '#000' },
    },
    rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.06, bottom: 0.24 } },
    timeScale: {
      borderColor: C.border, timeVisible: true, secondsVisible: false,
      rightOffset: 2, barSpacing: PX_PER_CANDLE, minBarSpacing: 1.5,
      lockVisibleTimeRangeOnResize: true,
      tickMarkFormatter: t => fmtCandleTime(t * 1000, minutes),
    },
    handleScroll: { vertTouchDrag: false, mouseWheel: true, pressedMouseMove: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    localization: { priceFormatter: p => fmtPrice(p) },
  });

  const candle = chart.addCandlestickSeries({
    upColor: C.up, downColor: C.down,
    borderUpColor: C.up, borderDownColor: C.down,
    wickUpColor: C.up, wickDownColor: C.down,
    priceLineVisible: false, lastValueVisible: true,
  });
  const ma25 = chart.addLineSeries({ color: C.ma25, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const ema7 = chart.addLineSeries({ color: C.ema7, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const ma7 = chart.addLineSeries({ color: C.ma7, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  // 缠论笔：一条折线穿过所有笔端点（顶底天然交替，单条折线画出来就是笔）
  const pen = chart.addLineSeries({
    color: C.pen, lineWidth: 1, lineStyle: LC.LineStyle.Dashed,
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: true,
  });
  const macdHist = chart.addHistogramSeries({
    priceScaleId: 'macd', priceFormat: { type: 'price', precision: 8 },
    priceLineVisible: false, lastValueVisible: false, base: 0,
  });
  const macdDif = chart.addLineSeries({ color: C.gold, lineWidth: 1, priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const macdDea = chart.addLineSeries({ color: '#f6465d', lineWidth: 1, priceScaleId: 'macd', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const vol = chart.addHistogramSeries({
    priceFormat: { type: 'volume' }, priceScaleId: 'vol',
    priceLineVisible: false, lastValueVisible: false,
  });
  chart.priceScale('macd').applyOptions({ scaleMargins: { top: 0.78, bottom: 0.02 }, visible: true });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 }, visible: false });

  const e = { card, chart, candle, ma7, ema7, ma25, pen, macdHist, macdDif, macdDea, vol, minutes, tip: null };
  chart.subscribeCrosshairMove(p => onCrosshair(e, p));
  holder.addEventListener('click', () => toggleZoom(card, e.view));
  return e;
}

function toggleZoom(card, view) {
  const was = card.classList.contains('zoomed');
  document.querySelectorAll('#' + view.grid.id + ' .chartcard.zoomed').forEach(c => c.classList.remove('zoomed'));
  if (!was) card.classList.add('zoomed');
  applyCols(view);
  setTimeout(() => {
    if (document.querySelector('#chart-bars').value === 'auto') refreshActive();
  }, 80);
}

/**
 * 卡片数量对齐。
 * 用**增量增删**而不是整块重建：报警每来一条，数量就变一次，
 * 整块重建会把已有的 Lightweight Charts 实例全部销毁重建 ——
 * 十字光标和 tooltip 会跟着断掉（实测到的真实抖动）。
 */
function ensureCards(view, items) {
  const grid = view.grid;
  let cur = grid.childElementCount;
  while (cur > items.length) {                 // 多了就删尾
    const removed = view.entries.pop();
    removed.chart.remove();
    grid.removeChild(grid.lastElementChild);
    cur--;
  }
  while (cur < items.length) {                 // 少了就补尾
    const it = items[cur];
    const card = buildCard();
    grid.appendChild(card);
    const e = initChart(card, it.minutes ?? 15);
    e.view = view;
    view.entries.push(e);
    cur++;
  }
  view.entries.forEach((e, i) => {
    if (items[i]) syncPinBadge(e.card, items[i]);
    const minutes = items[i].minutes ?? 15;
    if (e.minutes === minutes) return;
    e.minutes = minutes;
    e.chart.applyOptions({ timeScale: { tickMarkFormatter: t => fmtCandleTime(t * 1000, minutes) } });
  });
  // 关键：置顶会改变 items 顺序，但卡片 DOM 还留在原位。\n  // 按 entries 顺序重新 append，把 DOM 顺序也排好（appendChild 会移动已有节点）。\n  if (view.entries.length) view.entries.forEach(e => grid.appendChild(e.card));\n  return view.entries;
}

/* ---------------- 绘制 ---------------- */
const CHART_ROLE = { base: '基准', mid: '确认', big: '最大' };
const CHART_STATE = { 0: '数据不足', 1: '多头排列', 2: '站上MA7', 3: '均线纠缠', 4: '弱势', 5: '空头排列' };

const seriesCache = new WeakMap();
function syncSeries(series, points) {
  const previous = seriesCache.get(series);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (previous && points.length >= previous.length && previous.length &&
      previous.slice(0, -1).every((point, i) => same(point, points[i])) &&
      points[previous.length - 1]?.time === previous[previous.length - 1].time) {
    for (let i = previous.length - 1; i < points.length; i++) {
      if (!same(previous[i], points[i])) series.update(points[i]);
    }
  } else if (!previous || !same(previous, points)) series.setData(points);
  seriesCache.set(series, points);
}

function paintCard(view, i, it) {
  const e = view.entries[i];
  if (!e) return;
  const card = e.card;
  const isAlert = view.kind === 'alert';

  const isZero = view.kind === 'zero';

  // 不能覆盖 className，否则会抹掉用户的放大状态
  const cls = ['chartcard'];
  if (isAlert) {
    cls.push(signalConfirmed(it) ? 'mode-closed' : 'mode-live');
  } else if (isZero) {
    cls.push(it.side === 'long' ? 'mode-zero-long' : 'mode-zero-short');
  } else {
    const roles = view.roles?.[it.key] ?? [];
    if (roles.includes('base')) cls.push('role-base');
    else if (roles.includes('mid')) cls.push('role-mid');
    else if (roles.includes('big')) cls.push('role-big');
  }
  if (card.classList.contains('zoomed')) cls.push('zoomed');
  // 这里用 className 整体覆盖，必须把「已固定」的高亮补回去
  if (typeof isPinned === 'function' && isPinned(pinIdOf(it))) cls.push('pinned');
  card.className = cls.join(' ');

  const meta = card.querySelector('.zero-meta');
  // 配对卡片与单K卡片也要显示这行摘要（以前只有零轴视图显示）
  meta.hidden = !(isZero || it.kind === 'pair' || it.kind === 'single');
  const head = card.querySelector('.cchead');
  const divBadge = it.chanState?.divergence === 'pending'
    ? `<span class="st badge-div">${it.chanState.divDir === 'top' ? '顶' : '底'}背驰酝酿</span>` : '';

  if (it.kind === 'pair') {
    // 配对信号：次级别K线 + 主级别定方向
    const pr = it.pair || {};
    const up = pr.dir !== 'short';
    head.querySelector('.lv').innerHTML = `<span class="sym">${it.symbol}</span>`;
    head.querySelector('.roles').innerHTML = `<span class="rb lvl">${pr.subLabel || it.label}</span>`;
    const st = head.querySelector('.st');
    st.textContent = up ? '看多' : '看空';
    st.className = 'st ' + (up ? 's1' : 's3');
    head.querySelector('.sp').textContent = '#' + (i + 1) + ' · '
      + (pr.subLabel || pr.sub) + ' → ' + (pr.mainLabel || pr.main)
      + ' · 榜内 #' + (pr.rank ?? '—');
    meta.innerHTML = '<div><b>主级别 DIF ' + Number(pr.mainDif).toPrecision(3) + '</b>'
      + '<span>零轴' + (up ? '上' : '下') + ' · 持续 ' + (pr.mainHold ?? '—') + ' 根</span></div>'
      + '<div><span>' + (up ? '回踩 ' : '反弹 ') + (pr.subPullBars ?? '—') + ' 根</span>'
      + '<span>次级别 DIF ' + Number(pr.subDif).toPrecision(3) + '</span></div>';
    meta.title = (pr.subLabel || pr.sub) + ' 是本轮' + (up ? '回踩' : '反弹') + '用了 ' + (pr.subPullBars ?? '—')
      + ' 根（起点 DIF ' + Number(pr.subPeak).toPrecision(3) + '），全程没穿越零轴；'
      + '主级别 ' + (pr.mainLabel || pr.main) + ' DIF ' + Number(pr.mainDif).toPrecision(3);
  } else if (it.kind === 'single') {
    // 单K策略：每张卡是一个 (币种 × 级别 × 方向) 的「单K + 回调不破」
    const sk = it.single || {};
    const up = (sk.side || it.side || 'long') === 'long';
    head.querySelector('.lv').innerHTML = `<span class="sym">${it.symbol}</span>`;
    head.querySelector('.roles').innerHTML = `<span class="rb lvl">${it.label}</span>`;
    const st = head.querySelector('.st');
    st.textContent = up ? '看多' : '看空';
    st.className = 'st ' + (up ? 's1' : 's3');
    head.querySelector('.sp').textContent = '#' + (i + 1) + ' · ' + lvLabel(it.key)
      + ' · 榜内 #' + (sk.rank ?? '—')
      + (sk.zeroSide === 'above' ? ' · 零轴上' : sk.zeroSide === 'below' ? ' · 零轴下' : '');
    meta.innerHTML = '<div><b>单K ' + (up ? '+' : '−') + Number(sk.bodyPct || 0).toFixed(1) + '%</b>'
      + '<span>实体放大 ' + Number(sk.mult || 0).toFixed(1) + ' 倍</span></div>'
      + '<div><span>' + (up ? '回踩 ' : '反抽 ') + Number(sk.retracePct || 0).toFixed(2) + '%（' + (sk.barsAfter ?? '—') + ' 根）</span>'
      + '<span>不破线 ' + (sk.line ?? sk.low ?? '—') + '</span></div>'
      + (sk.dif != null
        ? '<div><span>DIF ' + Number(sk.dif).toPrecision(4) + '（'
          + (sk.zeroSide === 'above' ? '零轴上方' : '零轴下方') + '）</span></div>'
        : '');
    meta.title = (up ? '大阳线' : '大阴线') + '：开盘 ' + sk.open + '  收盘 ' + sk.close
      + (up ? '  最低 ' + sk.low : '  最高 ' + sk.high)
      + (up ? '｜反抽/回调期间最低收盘 ' + sk.minClose + '（未跌破最低价即「不破」）'
            : '｜反抽期间最高收盘 ' + sk.maxClose + '（未涨破最高价即「不破」）');
  } else if (isAlert || isZero) {
    head.querySelector('.lv').innerHTML = `<span class="sym">${it.symbol}</span>`;
    head.querySelector('.roles').innerHTML = `<span class="rb lvl">${it.label}</span>`;
    const st = head.querySelector('.st');
    if (isZero) {
      const z=it.zero;
      st.textContent=z.side>0?'多':'空';st.className='st '+(z.side>0?'s1':'s3');
      head.querySelector('.sp').textContent='#'+(i+1)+' · '+lvLabel(it.key)+' 独立监控';
      meta.innerHTML='<div><b>靠近零轴 '+(z.near*100).toFixed(1)+'%</b><span>'
        +(z.side>0?'零轴上方不下穿':'零轴下方不上穿')+' · 已持续 '+z.hold+' 根</span></div>'
        +'<div><span>DIF '+Number(z.dif).toPrecision(4)+' · DEA '+Number(z.dea).toPrecision(4)
        +'</span><span>首次靠近 '+zeroTime(z.firstNearAt)+'</span></div>';
      meta.title=lvLabel(it.key)+' 独立判定｜收盘确认 '+zeroTime(z.at)+'｜首次靠近 '+zeroTime(z.firstNearAt);
    } else {
      st.textContent = signalConfirmed(it) ? '已确认' : '预警';
      st.className = 'st ' + (signalConfirmed(it) ? 's1' : 's3');
      // 形态提醒没有评分，用方向标签代替；共振信号仍显示组合与评分
      const isDual = it.kind === 'dual';
      head.querySelector('.sp').innerHTML = isDual
        ? `<span class="grp">${it.side === 'long' ? '双阴不破 · 看多' : '双阳不穿 · 看空'}</span>` + (divBadge ? ' ' + divBadge : '')
        : `<span class="grp">${escapeHTML(signalChain(it))}</span>`
          + (signalHasScore(it) ? `<span class="sc">${it.score}分</span>` : '') + divBadge;
    }
    const t = new Date((isZero ? it.zero?.at : it.at) || Date.now());
    const p = n => String(n).padStart(2, '0');
    head.querySelector('.px').textContent = isZero ? `现价 ${fmtPrice(it.price)}`
      : `${fmtPrice(it.price)}　${p(t.getHours())}:${p(t.getMinutes())}`;
  } else {
    head.querySelector('.lv').textContent = it.label;
    head.querySelector('.roles').innerHTML = (view.roles?.[it.key] ?? [])
      .map(r => `<span class="rb ${r}">${CHART_ROLE[r]}</span>`).join('');
    const st = head.querySelector('.st');
    st.textContent = CHART_STATE[it.state] ?? '';
    st.className = 'st s' + it.state;
    head.querySelector('.sp').innerHTML = divBadge;
    head.querySelector('.px').textContent =
      `收 ${fmtPrice(it.price)}　距MA7 ${it.distMa7Pct >= 0 ? '+' : ''}${(it.distMa7Pct ?? 0).toFixed(2)}%`;
  }

  // —— 数据 ——
  const cs = it.candles;
  if (!cs.length) {
    syncSeries(e.candle, []); syncSeries(e.ma7, []); syncSeries(e.ema7, []); syncSeries(e.ma25, []);
    syncSeries(e.pen, []); e.pen.setMarkers([]); e.candle.setMarkers([]);
    syncSeries(e.macdHist, []); syncSeries(e.macdDif, []); syncSeries(e.macdDea, []); syncSeries(e.vol, []);
    return;
  }
  const T = i2 => Math.floor(cs[i2][0] / 1000);      // ms → 秒
  syncSeries(e.candle, cs.map((c, i2) => ({ time: T(i2), open: c[1], high: c[2], low: c[3], close: c[4] })));
  const line = arr => { const o = []; for (let i2 = 0; i2 < arr.length; i2++) if (arr[i2] != null) o.push({ time: T(i2), value: arr[i2] }); return o; };
  const showMA = document.querySelector('#chart-ma').checked;
  syncSeries(e.ma7, showMA ? line(it.ma7) : []);
  syncSeries(e.ema7, showMA ? line(it.ema7) : []);
  syncSeries(e.ma25, showMA ? line(it.ma25) : []);

  // 缠论笔
  const showChan = document.querySelector('#chart-chan').checked;
  if (showChan && it.strokes?.length >= 2) {
    const idx = s => Math.max(0, Math.min(cs.length - 1, s[0]));
    syncSeries(e.pen, it.strokes.map(s => ({ time: T(idx(s)), value: s[1] })));
    e.pen.setMarkers(it.strokes.map(s => ({
      time: T(idx(s)), position: s[2] > 0 ? 'aboveBar' : 'belowBar',
      color: s[2] > 0 ? '#f87171' : '#4ade80', shape: 'circle', size: 0.6,
    })));
  } else { syncSeries(e.pen, []); e.pen.setMarkers([]); }

  // MACD 副图
  const showMacd = document.querySelector('#chart-macd').checked;
  if (showMacd && it.macd) {
    const h = [];
    for (let i2 = 0; i2 < cs.length; i2++) {
      const v = it.macd.hist[i2];
      if (v == null) continue;
      h.push({ time: T(i2), value: v, color: v >= 0 ? 'rgba(246,70,93,.75)' : 'rgba(14,203,129,.75)' });
    }
    syncSeries(e.macdHist, h);
    syncSeries(e.macdDif, line(it.macd.dif));
    syncSeries(e.macdDea, line(it.macd.dea));
    e.chart.priceScale('macd').applyOptions({ visible: true, scaleMargins: { top: 0.78, bottom: 0.02 } });
  } else {
    syncSeries(e.macdHist, []); syncSeries(e.macdDif, []); syncSeries(e.macdDea, []);
    e.chart.priceScale('macd').applyOptions({ visible: false });
  }
  // 事件落在实际发生的 K 线上（时间标签使用收盘确认时间）。
  const zeroMarkers=[];
  if(isZero && it.zero && document.querySelector('#chart-mark').checked) {
    const z=it.zero, visible=new Set(cs.map(c=>c[0]));
    
    if(visible.has(z.firstNearBarAt)) zeroMarkers.push({time:Math.floor(z.firstNearBarAt/1000),position:'belowBar',color:'#38bdf8',shape:'circle',text:'首次回踩到位'});
  }
  // 配对策略：标出「回踩起点」——次级别 DIF 本轮极值那一根
  if (it.kind === 'pair' && it.pair && it.pair.subPeakT) {
    const pr = it.pair, visible = new Set(cs.map(c => c[0]));
    const up = pr.dir !== 'short';
    if (visible.has(pr.subPeakT)) {
      zeroMarkers.push({
        time: Math.floor(pr.subPeakT / 1000), position: up ? 'aboveBar' : 'belowBar',
        color: '#f0b90b', shape: up ? 'arrowDown' : 'arrowUp',
        text: (up ? '回踩起点 ' : '反弹起点 ') + (pr.subPullBars ?? '') + ' 根前',
      });
    }
    const lastT = cs.length ? cs[cs.length - 1][0] : null;
    if (lastT) {
      zeroMarkers.push({
        time: Math.floor(lastT / 1000), position: up ? 'belowBar' : 'aboveBar',
        color: '#38bdf8', shape: 'circle', text: up ? '回踩中' : '反弹中',
      });
    }
  }
  // 单K策略：标出那根大阳线，并画出「不破线」（大阳线最低价）
  if (it.kind === 'single' && it.single) {
    const sk = it.single, visible = new Set(cs.map(c => c[0]));
    if (visible.has(sk.bigT)) {
      zeroMarkers.push({
        time: Math.floor(sk.bigT / 1000), position: 'aboveBar', color: '#22c55e', shape: 'arrowDown',
        text: '单K +' + sk.bodyPct.toFixed(1) + '%',
      });
    }
    // 最近一根画「回踩中」的标记
    const lastT = cs.length ? cs[cs.length - 1][0] : null;
    if (lastT) zeroMarkers.push({ time: Math.floor(lastT / 1000), position: 'belowBar', color: '#f0b90b', shape: 'circle', text: '回踩不破' });
    // 不破线：横贯全图
    sk.priceLines = { low: sk.low };
  }
  e.candle.setMarkers(zeroMarkers.sort((a,b)=>a.time-b.time));

  // 「不破线」横线：单K策略用大阳线的最低价，每次重画前先移除旧的
  if (e._pl) { try { e.candle.removePriceLine(e._pl); } catch { } e._pl = null; }
  if (it.kind === 'single' && it.single && (it.single.line ?? it.single.low) > 0) {
    try {
      e._pl = e.candle.createPriceLine({
        price: it.single.line ?? it.single.low, color: '#f0b90b', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: '不破线',
      });
    } catch { }
  }
  // 成交量（关掉 MACD 时占位）
  const vd = [];
  for (let i2 = 0; i2 < cs.length; i2++) {
    vd.push({ time: T(i2), value: cs[i2][5], color: cs[i2][4] >= cs[i2][1] ? 'rgba(246,70,93,.35)' : 'rgba(14,203,129,.35)' });
  }
  syncSeries(e.vol, showMacd ? [] : vd);

  // 尺寸适配；时间轴只在首次或宽度变化时 fitContent，避免每轮重置用户的缩放
  const holder = card.querySelector('.cchart');
  const w = holder.clientWidth, h = holder.clientHeight;
  if (e._w !== w || e._h !== h) { e.chart.applyOptions({ width: w, height: h }); e._w = w; e._h = h; }
  const fitKey = (it.symbol ?? '') + '|' + (it.key ?? it.label) + '|' + w;
  if (e._fitFor !== fitKey) { e.chart.timeScale().fitContent(); e._fitFor = fitKey; }
}

function paintView(view) {
  view.items.forEach((it, i) => paintCard(view, i, it));
}

/* ---------------- 数据拉取 ---------------- */
async function fetchChart(view, url) {
  if (view.pendingUrl === url && view.controller && !view.controller.signal.aborted) return null;
  view.controller?.abort();
  const controller = new AbortController();
  view.controller = controller; view.pendingUrl = url;
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (controller.signal.aborted || view.controller !== controller || document.hidden || activeView !== view.kind) return null;
    if (data.error) throw new Error(data.error);
    return data;
  } catch (error) {
    if (!document.hidden && view.controller === controller && activeView === view.kind && (!controller.signal.aborted || view.pendingUrl === url)) {
      const liveEl = document.querySelector({ alert: '#alert-live', zero: '#zero-live' }[view.kind]);
      if (liveEl) liveEl.textContent =
        '图表更新失败，保留上次数据 · ' + (error.name === 'AbortError' ? '请求已取消或超时' : error.message);
    }
    return null;
  } finally {
    clearTimeout(timer);
    if (view.controller === controller) { view.controller = null; view.pendingUrl = null; }
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) for (const view of Object.values(VIEWS)) view.controller?.abort();
  else refreshActive();
});


/**
 * 零轴回调的 K 线图视图。
 * 每张图是一个达标的 (币种 × 级别)，MACD 副图能看到 DIF 回调到零轴附近但没跌破。
 */
/** 单K策略的平铺 K 线墙：每个命中 (币种 × 级别) 一张图 */
/** 配对策略的平铺K线：每条信号出一张次级别图，标出回踩起点 */
/** 点了图钉后立刻按新的置顶顺序重排（不重新请求数据） */
function rerenderCurrentView() {
  const view = VIEWS[activeView] || (activeView === "matrix" ? VIEWS.pair : null);
  if (!view || !view.grid || !view.items) return;
  view.items = sortPinnedFirst(view.items);
  ensureCards(view, view.items);
  paintView(view);
  applyCols(view);
}


async function refreshPairView() {
  const view = VIEWS.pair;
  if (!view.grid) return;
  applyCols(view);
  const bars = currentBars(view);
  const limit = +(document.querySelector("#zero-limit")?.value) || 24;
  const side = (typeof PAIR !== "undefined" && PAIR.side) || "all";
  try {
    const d = await fetchChart(view, `/api/pairchart?bars=${bars}&limit=${limit}&side=${side}`);
    if (!d) return;
    view.items = sortPinnedFirst(d.items ?? []);
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    const emptyEl = document.querySelector("#pair-empty");
    if (emptyEl) emptyEl.style.display = view.items.length ? "none" : "";
    const n = view.items.length;
    const rows = view.rows ?? (n ? Math.ceil(n / (view.cols || 2)) : 0);
    const live = document.querySelector("#pair-live");
    if (live) {
      live.textContent = n
        ? `命中 ${d.total} 条（多 ${d.longs} / 空 ${d.shorts}） · 展示 ${n} 个 · ${view.cols} 列 × ${rows} 行 · ${bars} 根 · `
          + new Date().toLocaleTimeString("zh-CN", { hour12: false })
        : "当前没有符合条件的配对信号 · " + new Date().toLocaleTimeString("zh-CN", { hour12: false });
    }
  } catch { /* 单次失败忽略 */ }
}

async function refreshSingleView() {
  const view = VIEWS.single;
  if (!view.grid) return;
  applyCols(view);
  const bars = currentBars(view);
  const limit = +(document.querySelector("#single-limit")?.value) || 24;
  try {
    const zeroQ = document.querySelector('#single-zero')?.value || 'all';
    const d = await fetchChart(view, `/api/singlekchart?bars=${bars}&limit=${limit}&zero=${zeroQ}`);
    if (!d) return;
    view.items = sortPinnedFirst(d.items ?? []);
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    const emptyEl = document.querySelector("#single-empty");
    if (emptyEl) emptyEl.style.display = view.items.length ? "none" : "";
    const n = view.items.length;
    const rows = view.rows ?? (n ? Math.ceil(n / (view.cols || 4)) : 0);
    const scrollable = view.grid.scrollHeight - view.grid.clientHeight > 4;
    const live = document.querySelector("#single-live");
    if (live) {
      live.textContent = n
        ? `命中 ${d.total} 个 · 展示 ${n} 个 · ${view.cols} 列 × ${rows} 行 · `
          + `${scrollable ? "可上下滚动" : "一屏看全"} · ${bars} 根 · `
          + new Date().toLocaleTimeString("zh-CN", { hour12: false })
        : "涨幅榜前 " + (d.topN || 50) + " 暂无单K回踩不破形态";
    }
  } catch { /* 单次失败忽略 */ }
}

async function refreshZeroView() {
  const view = VIEWS.zero;
  if (!view.grid) return;
  const filterQuery = zeroQuery();
  applyCols(view);
  const bars = currentBars(view);
  const limit = +(document.querySelector('#zero-limit')?.value) || 24;
  try {
    const d = await fetchChart(view, `/api/zerochart?bars=${bars}&limit=${limit}&${filterQuery}`);
    if (!d || (view.kind === 'zero' && filterQuery !== zeroQuery())) return;
    document.querySelector('#zero-symbar .chartsym').textContent = d.options?.phase === 'watch'
      ? '七周期独立监控 · 按交叉时间排序' : '七周期独立监控 · 按首次靠近时间排序';
    document.querySelector('#pill-bull').textContent = `七周期独立 · 达标 ${d.total} 级别`;
    view.items = (d.items ?? []).filter(zeroFilterMatches);
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    const emptyEl = document.querySelector('#zero-empty');
    if (emptyEl) emptyEl.style.display = view.items.length ? 'none' : '';
    const n = view.items.length;
    const rows = view.rows ?? (n ? Math.ceil(n / (view.cols || 4)) : 0);
    const scrollable = view.grid.scrollHeight - view.grid.clientHeight > 4;
    const live = document.querySelector('#zero-live');
    if (live) {
      live.textContent = n
        ? `已靠近 ${d.nearCount} · 展示 ${n} 个 · ${view.cols} 列 × ${rows} 行 · `
          + `${scrollable ? '可上下滚动' : '一屏看全'} · ${bars} 根 · `
          + new Date().toLocaleTimeString('zh-CN', { hour12: false })
        : '当前条件暂无匹配级别';
    }
  } catch { /* 忽略单次失败 */ }
}

async function refreshAlertView() {
  const view = VIEWS.alert;
  if (!view.grid) return;
  applyCols(view);
  const bars = currentBars(view);
  const limit = +document.querySelector('#alert-limit').value || 24;
  try {
    const d = await fetchChart(view, `/api/alertchart?bars=${bars}&limit=${limit}`);
    if (!d) return;
    view.items = sortPinnedFirst(d.items ?? []);
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    document.querySelector('#alert-empty').style.display = view.items.length ? 'none' : '';
    const n = view.items.length;
    const rows = view.rows ?? (n ? Math.ceil(n / (view.cols || 4)) : 0);
    const scrollable = view.grid.scrollHeight - view.grid.clientHeight > 4;
    document.querySelector('#alert-live').textContent =
      n
        ? `共 ${d.total} 条报警，展示最近 ${n} 条 · ${view.cols} 列 × ${rows} 行 · `
          + `${scrollable ? '可上下滚动' : '一屏看全'} · ${bars} 根 · `
          + new Date().toLocaleTimeString('zh-CN', { hour12: false })
        : `暂无报警`;
  } catch { /* 忽略单次失败 */ }
}

/* ---------------- 十字光标提示 ---------------- */
function onCrosshair(e, param) {
  if (!param || !param.point || param.time == null) { hideTip(e); return; }
  const d = param.seriesData.get(e.candle);
  if (!d) { hideTip(e); return; }
  if (!e.tip) {
    const t = document.createElement('div');
    t.className = 'ctip';
    e.card.appendChild(t);
    e.tip = t;
  }
  const item = e.view?.items?.[e.view.entries.indexOf(e)];
  const cs = item?.candles ?? [];
  const idx = cs.findIndex(c => Math.floor(c[0] / 1000) === param.time);
  const mv = item?.macd && idx >= 0 ? item.macd.hist[idx] : null;
  const dt = new Date(param.time * 1000);
  const p = n => String(n).padStart(2, '0');
  e.tip.style.display = 'block';
  const w = e.card.clientWidth;
  e.tip.style.left = Math.min(param.point.x + 14, Math.max(4, w - 140)) + 'px';
  e.tip.style.top = Math.max(4, param.point.y - 78) + 'px';
  e.tip.innerHTML =
    `<b>${item?.symbol ?? ''}</b> <span class="k">${item?.label ?? ''}</span><br>`
    + `开 ${fmtPrice(d.open)}　高 ${fmtPrice(d.high)}<br>`
    + `低 ${fmtPrice(d.low)}　收 ${fmtPrice(d.close)}<br>`
    + (mv != null ? `<span class="k">MACD柱</span> ${mv.toFixed(4)}<br>` : '')
    + `<span class="k">${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}</span>`;
}
function hideTip(e) { if (e.tip) e.tip.style.display = 'none'; }

/** 按周期决定时间轴格式 */
function fmtCandleTime(ts, minutes) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  if (minutes < 60) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (minutes < 1440) return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:00`;
  if (minutes < 10080) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/* ---------------- 绑定 ---------------- */
function initCharts() {
  VIEWS.alert.grid = document.querySelector('#alertchartgrid');
  VIEWS.zero.grid = document.querySelector('#zerochartgrid');
  VIEWS.single.grid = document.querySelector('#singlechartgrid');
  VIEWS.pair.grid = document.querySelector('#pairchartgrid');

  // 零轴标签页现在放的是「结构卡片墙」，旧的表格/图表控件已移除，
  // 这里统一用容错绑定：元素不存在就跳过，避免整个 initCharts 抛错。
  const zeroMode = () => (document.querySelector('#zero-mode')?.value === 'table' ? 'matrix' : 'zero');
  const on = (sel, evt, fn) => { const el = document.querySelector(sel); if (el) el.addEventListener(evt, fn); };
  on('#tab-zero', 'click', () => setView('pair'));
  on('#zero-mode', 'change', () => {
    setView(zeroMode());
    if (zeroMode() === 'matrix' && typeof renderZero === 'function') renderZero();
  });
  on('#tab-pgrid', 'click', () => setView('pgrid'));
  on('#tab-alert', 'click', () => setView('alert'));
  on('#chart-bars', 'change', () => refreshActive());
  on('#zero-limit', 'change', () => { if (typeof loadPair === 'function') loadPair(); });
  on('#zero-size', 'change', () => { applyCols(VIEWS.zero); refreshZeroView(); });
  on('#zero-refresh', 'click', () => { if (typeof loadPair === 'function') loadPair(); });
  on('#alert-limit', 'change', () => refreshAlertView());
  on('#alert-size', 'change', () => { applyCols(VIEWS.alert); refreshAlertView(); });
  ['#chart-ma', '#chart-chan', '#chart-mark', '#chart-macd'].forEach(s =>
    on(s, 'change', () => {
      if (activeView === 'zero') paintView(VIEWS.zero);
      else if (activeView === 'alert') paintView(VIEWS.alert);
    }));
  on('#alert-refresh', 'click', () => refreshAlertView());

  let rt = null;
  window.addEventListener('resize', () => {
    if (activeView === 'matrix') return;
    clearTimeout(rt);
    rt = setTimeout(() => refreshActive(), 250);
  });
  // 左右方向键切换币种的多级别视图已移除，键盘监听一并去掉
  applyCols(VIEWS.alert);
  applyCols(VIEWS.zero);

  // 初始视图：零轴页按「展示方式」决定（默认 K 线图）。
  // 不在这里显式 setView 的话，页面会停在 activeView='matrix' 的默认值上，
  // 表现就是「选了 K 线图但一张图都没有」，必须手动切一次才出来。
  setView(zeroMode());
}

if (typeof LC === 'undefined') {
  console.error('[chart] LightweightCharts 未加载，K线图不可用');
} else {
  initCharts();
  // 默认页就是配对监控（K线图），直接进 pair 视图
  setView('pair');
}

// 「多级别 K 线图」视图已移除：点击币种改为打开该币种的级别明细面板
function openChartFor(sym) {
  if (typeof openDetail === 'function') openDetail(sym);
}
