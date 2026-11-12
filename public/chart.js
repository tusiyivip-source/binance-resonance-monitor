/* K 线图视图 —— 基于 TradingView Lightweight Charts（已本地化，不走 CDN）
 *
 * 两个视图共用同一套建图/绘制代码：
 *   multi  多级别视图：当前币种的 14 个级别按周期升序铺开
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

/* ---------------- 视图状态 ---------------- */
const VIEWS = {
  zero: { kind: 'zero', grid: null, entries: [], items: [], roles: {}, cols: 4, minBars: 120 },
  single: { kind: 'single', grid: null, entries: [], items: [], roles: {}, cols: 4, minBars: 100 },
  pair: { kind: 'pair', grid: null, entries: [], items: [], roles: {}, cols: 2, minBars: 100 },
  rev: { kind: 'rev', grid: null, entries: [], items: [], roles: {}, cols: 4 },   // 报警级别K线（配对反转）
  half: { kind: 'half', grid: null, entries: [], items: [], roles: {}, cols: 4 }, // 背驰50%
  crosspb: { kind: 'crosspb', grid: null, entries: [], items: [], roles: {}, cols: 4 }, // 金叉回踩
};
let activeView = 'matrix';         // 'matrix' | 'pair' | 'single' | 'zero' | 'pgrid'
let viewTimer = null;

/* ---------------- 视图切换 ---------------- */
function setView(mode) {
  for (const view of Object.values(VIEWS)) view.controller?.abort();
  activeView = mode;
  const isChart = mode === 'zero' || mode === 'single';
  const isPair = mode === 'pair';
  document.body.classList.toggle('chartmode', isChart);
  document.body.classList.toggle('zerochartmode', mode === 'zero');
  document.body.classList.toggle('zeromonitor', mode === 'zero' || mode === 'matrix' || isPair);
  document.body.classList.toggle('singlemode', mode === 'single');
  document.body.classList.toggle('pgridmode', mode === 'pgrid');
  document.body.classList.toggle('revmode', mode === 'rev');
  document.body.classList.toggle('halfmode', mode === 'half');
  document.body.classList.toggle('cgmode', mode === 'crosspb');
  document.body.classList.toggle('singlechartmode', mode === 'single');
  document.querySelector('#tab-zero').classList.toggle('on', mode === 'matrix' || mode === 'zero' || isPair);
  const ts = document.querySelector('#tab-single');
  if (ts) ts.classList.toggle('on', mode === 'single');
  const tpg = document.querySelector('#tab-pgrid');
  if (tpg) tpg.classList.toggle('on', mode === 'pgrid');
  const trv = document.querySelector('#tab-rev');
  if (trv) trv.classList.toggle('on', mode === 'rev');
  const thf = document.querySelector('#tab-half');
  if (thf) thf.classList.toggle('on', mode === 'half');
  const tcg = document.querySelector('#tab-cg');
  if (tcg) tcg.classList.toggle('on', mode === 'crosspb');
  // 多级别视图才有币种切换控件
  const csb = document.querySelector('#chart-symbar');
  if (csb) csb.style.display = 'none';   // 多级别视图已移除
  const zs = document.querySelector('#zero-symbar');
  if (zs) zs.style.display = (mode === 'zero' || mode === 'matrix' || isPair) ? '' : 'none';
  const pgs = document.querySelector('#pg-symbar');
  if (pgs) pgs.style.display = mode === 'pgrid' ? '' : 'none';
  const rvs = document.querySelector('#rev-symbar');
  if (rvs) rvs.style.display = mode === 'rev' ? '' : 'none';
  const hfs = document.querySelector('#half-symbar');
  if (hfs) hfs.style.display = mode === 'half' ? '' : 'none';
  const cgs = document.querySelector('#cg-symbar');
  if (cgs) cgs.style.display = mode === 'crosspb' ? '' : 'none';
  const sbar = document.querySelector('#single-bar');
  if (sbar) sbar.style.display = mode === 'single' ? '' : 'none';
  // 'single' 表格模式下不需要图表轮询；K线模式下才启动
  // single 有两种模式：K线图要轮询图表，表格不需要（表格自己的轮询在 app.js）
  const singleTable = mode === 'single'
    && document.querySelector('#single-mode')?.value === 'table';
  if (mode === 'matrix' || isPair || mode === 'pgrid' || mode === 'rev' || mode === 'half' || mode === 'crosspb' || singleTable) stopLoop(); else startLoop();
  // 配对全景自己轮询，进出该视图时启停
  if (mode === 'pgrid') { if (typeof startPgPoll === 'function') startPgPoll(); }
  else { if (typeof stopPgPoll === 'function') stopPgPoll(); }
  // 反转提醒页自己轮询
  if (mode === 'rev') { if (typeof startReboundPoll === 'function') startReboundPoll(); }
  else { if (typeof stopReboundPoll === 'function') stopReboundPoll(); }
  // 背驰50% 页自己轮询
  if (mode === 'half') { if (typeof startHalfPoll === 'function') startHalfPoll(); }
  else { if (typeof stopHalfPoll === 'function') stopHalfPoll(); }
  // 金叉回踩页自己轮询
  if (mode === 'crosspb') { if (typeof startCgPoll === 'function') startCgPoll(); }
  else { if (typeof stopCgPoll === 'function') stopCgPoll(); }
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
  // 零轴标签页已换成配对监控表，刷新由 pair.js 自己轮询，这里不再拉图表
}

/* ---------------- 布局 ---------------- */
// 列数由各视图自己的尺寸下拉（zero-size / pair-size）决定，
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
  const isZero = view.kind === 'zero';
  const isSingle = view.kind === 'single';
  const isPair = view.kind === 'pair';
  if (view.kind === 'rev' || view.kind === 'half' || view.kind === 'crosspb') return;   // 这几页的列数由 --pgcols 控制
  const zeroSize = document.querySelector('#zero-size')?.value || 'normal';
  const minH = isZero ? ({compact:140, normal:230, large:320, xl:430}[zeroSize] || 230) : 0;
  const minW = isZero ? 340 : MIN_CW;
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
/**
 * 把卡片的 DOM 顺序对齐到目标顺序。
 * 只在顺序真的不同才移动节点 —— 每轮都 appendChild 一遍会把滚动位置顶回顶部，
 * 用户表现为「一固定页面就跳回最上面」。
 */
function syncCardOrder(grid, want) {
  if (!grid || !want.length) return;
  const have = [...grid.children];
  let same = have.length === want.length;
  if (same) for (let i = 0; i < want.length; i++) if (have[i] !== want[i]) { same = false; break; }
  if (same) return;
  const top = grid.scrollTop;
  for (let i = 0; i < want.length; i++) {
    const c = want[i];
    if (grid.children[i] !== c) grid.insertBefore(c, grid.children[i] || null);
  }
  // 多出来的（正在被移除的）先不动，由调用方负责删
  grid.scrollTop = top;
  requestAnimationFrame(() => { if (grid.isConnected) grid.scrollTop = top; });
}

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
    // 只标记，不重排、不跳位；要看到最前面请按刷新按钮
    const pb = card.querySelector('.pinbtn');
    if (pb) pb.title = isPinned(id) ? '已固定（按刷新按钮才排到最前）' : '固定（按刷新按钮后置顶）';
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

let pinFirstMode = false;
let pinDidReorder = false;   // 本次刷新是否真的做过「置顶重排」   // false = 固定只标记，不改变顺序；按刷新按钮才置顶
function isPinned(id) { return PINNED.has(id); }
function togglePin(id) {
  if (PINNED.has(id)) PINNED.delete(id); else PINNED.add(id);
  try { localStorage.setItem(PIN_KEY, JSON.stringify([...PINNED])); } catch { /* 忽略 */ }
}
/** 每张卡片的稳定身份（币种 + 具体形态） */
function pinIdOf(it) {
  // 反转提醒页单独一个命名空间：同一条信号在「配对全景」和「报警级别K线」里
  // 是两屏不同的东西，共用 id 会让一边的固定影响到另一边
  if (it.kind === 'rev' && it.pair) return 'r|' + it.symbol + '|' + it.pair.sub + '-' + it.pair.main;
  if (it.kind === 'half' && it.pair) return 'h|' + it.symbol + '|' + it.pair.sub + '-' + it.pair.main;
  if (it.kind === 'crosspb') return 'c|' + it.symbol + '|' + (it.pair?.sub || '') + '|' + (it.side || '');
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
/**
 * 让「已固定」的卡片钉在它原来的位置。
 * 上游列表每次刷新都会插入/删除条目（新信号进榜、旧信号过期），
 * 卡片按索引复用就会被挤得上下乱跳。这里把固定的那几张按上次的下标放回去。
 * 如果某个固定的条目在新数据里已经没有了，就用上次的对象补回来（保证不消失）。
 */
function anchorPinned(prev, next) {
  const list = Array.isArray(next) ? next.slice() : [];
  if (!Array.isArray(prev) || !prev.length || !PINNED.size) return dedupeById(list);

  // 收集「上次固定项的位置」——同一个 id 只记第一次出现，
  // 否则一旦列表里出现过重复，这里会把同一条插进去好几次，越滚越多。
  const anchors = [];
  const taken = new Set();
  prev.forEach((it, i) => {
    const id = pinIdOf(it);
    if (!isPinned(id) || taken.has(id)) return;
    taken.add(id);
    anchors.push({ id, at: i, it });
  });
  if (!anchors.length) return dedupeById(list);

  // 先把这些固定条目从新列表里摘出来（重复的也一并摘掉）
  const held = new Map();
  for (let i = list.length - 1; i >= 0; i--) {
    const id = pinIdOf(list[i]);
    if (!taken.has(id)) continue;
    if (!held.has(id)) held.set(id, list[i]);
    list.splice(i, 1);
  }

  // 按上次的下标逐个插回去；新数据里没有的，用上次的对象补一次
  anchors.sort((a, b) => a.at - b.at);
  for (const a of anchors) {
    const item = held.get(a.id) || a.it;
    if (!item) continue;
    const at = Math.max(0, Math.min(a.at, list.length));
    list.splice(at, 0, item);
  }
  return dedupeById(list);
}

/** 同一张卡片（pinId 相同）只保留第一次出现，防止各种插入逻辑把列表撑大 */
function dedupeById(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const id = pinIdOf(it);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}
/**
 * 按开关决定要不要把固定的提到最前。
 * 注意是**一次性**：排完这一次就自动关掉开关。
 * 否则开关会一直开着，之后每次固定新卡片都会被下一轮轮询顶到最前面。
 */
function applyPinOrder(items) {
  if (!pinFirstMode) return items;
  pinFirstMode = false;
  if (typeof PG !== "undefined" && PG) PG.pinFirst = false;
  pinDidReorder = true;   // 排完了，稍后把视图滚回顶部
  return sortPinnedFirst(items);
}
/** 刷新按钮用：打开置顶开关（图表版和全景屏一起） */
function setPinFirstMode(on) {
  pinFirstMode = !!on;
  if (typeof PG !== "undefined" && PG) PG.pinFirst = !!on;
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
  // 顺序变了才动 DOM；没变就别碰（每次都 appendChild 会把滚动条顶回顶部）
  syncCardOrder(grid, view.entries.map(e => e.card));
  return view.entries;
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
  const isZero = view.kind === 'zero';

  // 不能覆盖 className，否则会抹掉用户的放大状态
  const cls = ['chartcard'];
  if (isZero) {
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
      + (pr.levelLabel || pr.subLabel || pr.sub)
      + ' · 榜内 #' + (pr.rank ?? '—');
    meta.innerHTML = '<div><b>死叉 DIF ' + Number(pr.deadDif ?? pr.mainDif).toPrecision(3) + ' / DEA ' + Number(pr.deadDea ?? pr.deadDif ?? pr.mainDif).toPrecision(3) + '</b>'
      + '<span>' + (pr.levelLabel || pr.subLabel || pr.sub) + '</span></div>'
      + '<div><span class="sk-variant">' + (pr.variantLabel || (pr.variant === 'state' ? '零上死叉·阳收MA5' : '首次收阳')) + '</span>'
      + '<span>MA5 ' + Number(pr.ma5 ?? pr.subDif).toPrecision(3) + '</span>'
      + '<span>收 ' + (pr.close ?? '—') + '</span></div>';
    meta.title = (pr.levelLabel || pr.subLabel || pr.sub) + '：零轴上 MACD 死叉后连续下跌 '
      + (pr.downBars ?? '—') + ' 根，第一根阳线收 ' + (pr.close ?? '—') + '（前一根仍是阴线）';
      + ' 站上 MA5 ' + (pr.ma5 ?? '—') + '（前一根在 MA5 下方）';
  } else if (it.kind === 'single') {
  // 一阳穿三阴：每张卡是一个 (币种 × 级别) 的「三阴之后一根阳线穿透」
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
    meta.innerHTML = '<div><b>阳线 +' + Number(sk.bodyPct || 0).toFixed(1) + '%</b>'
      + '<span>下跌 ' + (sk.barsAfter ?? '—') + ' 根</span>'
      + '<span>实体 ' + Number(sk.mult || 0).toFixed(1) + '×</span></div>'
      + '<div><span>穿透 ' + Number(sk.retracePct || 0).toFixed(2) + '%</span>'
      + '<span>三阴最高开 ' + (sk.line ?? '—') + '</span>'
      + '<span>收 ' + (sk.close ?? '—') + '</span></div>'
      + (sk.dif != null
        ? '<div><span>DIF ' + Number(sk.dif).toPrecision(4) + '（'
          + (sk.zeroSide === 'above' ? '零轴上方' : '零轴下方') + '）</span></div>'
        : '')
      // 上级确认：例如「2时 金叉 ✓ 同向」
      + (sk.confirm
        ? '<div class="sk-conf"><span>' + sk.confirm.label + ' '
          + sk.confirm.cross + ' ✓ 同向</span>'
          + '<span>DIF ' + Number(sk.confirm.dif).toPrecision(3)
          + ' / DEA ' + Number(sk.confirm.dea).toPrecision(3) + '</span></div>'
        : '');
    meta.title = (up ? '大阳线' : '大阴线') + '：开盘 ' + sk.open + '  收盘 ' + sk.close
      + (up ? '  最低 ' + sk.low : '  最高 ' + sk.high)
      + (up ? '｜反抽/回调期间最低收盘 ' + sk.minClose + '（未跌破最低价即「不破」）'
            : '｜反抽期间最高收盘 ' + sk.maxClose + '（未涨破最高价即「不破」）');
  } else if (isZero) {
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
    // 一阳穿三阴：标出那根阳线，并画出「三阴里最高的开盘价」这条关键位
  if (it.kind === 'single' && it.single) {
    const sk = it.single, visible = new Set(cs.map(c => c[0]));
    if (visible.has(sk.bigT)) {
      zeroMarkers.push({
        time: Math.floor(sk.bigT / 1000), position: 'aboveBar', color: '#22c55e', shape: 'arrowDown',
        text: '一阳穿三阴 +' + sk.bodyPct.toFixed(1) + '%',
      });
    }
    // 最近一根画「回踩中」的标记
    const lastT = cs.length ? cs[cs.length - 1][0] : null;
    if (lastT) zeroMarkers.push({ time: Math.floor(lastT / 1000), position: 'belowBar', color: '#f0b90b', shape: 'arrowUp', text: '穿三阴' });
    // 不破线：横贯全图
    sk.priceLines = { low: sk.low };
  }
  // 在图上标出「零轴上死叉」那一根，方便核对
  // ⚠ 两个坑：
  //   1) 这里已经出了上面那个分支，pr 不在作用域里 —— 必须重新取，否则整屏只画一张
  //   2) 时间必须落在当前显示的数据范围内，否则 Lightweight Charts 也会抛错
  if (it.kind === 'pair') {
    const prDead = it.pair || {};
    const mt = prDead.deadT ? Math.floor(prDead.deadT / 1000) : null;
    const cc = it.candles || [];
    const firstT = cc.length ? Math.floor(cc[0][0] / 1000) : 0;
    const lastT2 = cc.length ? Math.floor(cc[cc.length - 1][0] / 1000) : 0;
    if (mt && mt >= firstT && mt <= lastT2) {
      zeroMarkers.push({ time: mt, position: 'aboveBar', color: '#8ba0bd', shape: 'square', text: '死叉' });
    }
  }
  e.candle.setMarkers(zeroMarkers.sort((a,b)=>a.time-b.time));

    // 关键位横线：三阴里最高的开盘价，每次重画前先移除旧的
  if (e._pl) { try { e.candle.removePriceLine(e._pl); } catch { } e._pl = null; }
  if (it.kind === 'single' && it.single && (it.single.line ?? it.single.low) > 0) {
    try {
      e._pl = e.candle.createPriceLine({
        price: it.single.line ?? it.single.low, color: '#f0b90b', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: '三阴最高开',
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
      const liveEl = document.querySelector({ zero: '#zero-live' }[view.kind]);
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
  view.items = applyPinOrder(anchorPinned(view.items, view.items));
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
    view.items = applyPinOrder(anchorPinned(view.items, d.items ?? []));
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    if (pinDidReorder) { pinDidReorder = false; view.grid.scrollTop = 0; }
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
    view.items = applyPinOrder(anchorPinned(view.items, d.items ?? []));
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    if (pinDidReorder) { pinDidReorder = false; view.grid.scrollTop = 0; }
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
        : "涨幅榜前 " + (d.topN || 50) + " 暂无一阳穿三阴形态";
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
    if (pinDidReorder) { pinDidReorder = false; view.grid.scrollTop = 0; }
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
  on('#tab-rev', 'click', () => setView('rev'));
  on('#tab-half', 'click', () => setView('half'));
  on('#tab-cg', 'click', () => setView('crosspb'));
  on('#chart-bars', 'change', () => refreshActive());
  on('#zero-limit', 'change', () => { if (typeof loadPair === 'function') loadPair(); });
  on('#zero-size', 'change', () => { applyCols(VIEWS.zero); refreshZeroView(); });
  on('#zero-refresh', 'click', () => {
    setPinFirstMode(true);   // 刷新 = 把已固定的排到最前
    if (typeof loadPair === 'function') loadPair();
  });
  ['#chart-ma', '#chart-chan', '#chart-mark', '#chart-macd'].forEach(s =>
    on(s, 'change', () => {
      if (activeView === 'zero') paintView(VIEWS.zero);
        }));

  let rt = null;
  window.addEventListener('resize', () => {
    if (activeView === 'matrix') return;
    clearTimeout(rt);
    rt = setTimeout(() => refreshActive(), 250);
  });
  // 左右方向键切换币种的多级别视图已移除，键盘监听一并去掉
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
