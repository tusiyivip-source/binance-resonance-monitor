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
  multi: { kind: 'multi', grid: null, entries: [], items: [], roles: {}, cols: 4 },
  alert: { kind: 'alert', grid: null, entries: [], items: [], roles: {}, cols: 4 },
};
let activeView = 'matrix';         // 'matrix' | 'multi' | 'alert'
let chartSymbol = null;
let chartList = [];
let viewTimer = null;

/* ---------------- 视图切换 ---------------- */
function setView(mode) {
  activeView = mode;
  document.body.classList.toggle('chartmode', mode === 'multi' || mode === 'alert');
  document.body.classList.toggle('alertchartmode', mode === 'alert');
  document.querySelector('#tab-matrix').classList.toggle('on', mode === 'matrix');
  document.querySelector('#tab-multi').classList.toggle('on', mode === 'multi');
  document.querySelector('#tab-alert').classList.toggle('on', mode === 'alert');
  // 多级别视图才有币种切换控件
  document.querySelector('#chart-symbar').style.display = mode === 'multi' ? '' : 'none';
  document.querySelector('#alert-symbar').style.display = mode === 'alert' ? '' : 'none';
  if (mode === 'matrix') stopLoop(); else startLoop();
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
  if (activeView === 'multi') refreshMulti();
  else if (activeView === 'alert') refreshAlertView();
}

/* ---------------- 币种列表（多级别视图用） ---------------- */
function ensureChartList() {
  if (chartList.length) return true;
  const order = (typeof DISPLAY_ORDER !== 'undefined' && DISPLAY_ORDER.length)
    ? DISPLAY_ORDER
    : (typeof SNAP !== 'undefined' && SNAP?.symbols ? SNAP.symbols : []);
  if (!order.length) return false;
  chartList = order.slice();
  return true;
}
function selectChartSymbol(sym) {
  if (!sym) return;
  ensureChartList();
  chartSymbol = sym;
  document.querySelector('#chart-sym').textContent = sym;
  refreshMulti();
}
function stepChart(dir) {
  if (!ensureChartList()) return;
  let i = chartList.indexOf(chartSymbol);
  if (i < 0) i = 0;
  i = (i + dir + chartList.length) % chartList.length;
  selectChartSymbol(chartList[i]);
}

/* ---------------- 布局 ---------------- */
function currentCols() {
  const v = document.querySelector('#chart-cols').value;
  return v === 'fit' ? null : Math.max(1, Math.min(8, +v || 2));
}

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
  const minH = isAlert && document.querySelector('#alert-size').value !== 'compact' ? alertMinH() : 0;
  const minW = isAlert && minH ? ALERT_MIN_W : MIN_CW;
  let cols, ch;
  if (fixed) { cols = fixed; ch = Math.max(minH, COL_H[fixed] ?? Math.round(1200 / fixed)); }
  else {
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
  if (sel !== 'auto') return +sel;
  const grid = view.grid;
  const cols = view.cols || 2;
  const avail = (grid.clientWidth || 1200) - GRID_PAD * 2 - (cols - 1) * GAP;
  const cardW = Math.max(260, avail / cols) - 70;
  return Math.max(30, Math.min(400, Math.round(cardW / PX_PER_CANDLE)));
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
    </div>
    <div class="cchart"></div>`;
  return card;
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
    grid.removeChild(grid.lastElementChild);
    view.entries.pop();
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
  return view.entries;
}

/* ---------------- 绘制 ---------------- */
const CHART_ROLE = { base: '基准', mid: '确认', big: '最大' };
const CHART_STATE = { 0: '数据不足', 1: '多头排列', 2: '站上MA7', 3: '均线纠缠', 4: '弱势', 5: '空头排列' };

function paintCard(view, i, it) {
  const e = view.entries[i];
  if (!e) return;
  const card = e.card;
  const isAlert = view.kind === 'alert';

  // 不能覆盖 className，否则会抹掉用户的放大状态
  const cls = ['chartcard'];
  if (isAlert) {
    cls.push(it.mode === 'closed' ? 'mode-closed' : 'mode-live');
  } else {
    const roles = view.roles?.[it.key] ?? [];
    if (roles.includes('base')) cls.push('role-base');
    else if (roles.includes('mid')) cls.push('role-mid');
    else if (roles.includes('big')) cls.push('role-big');
  }
  if (card.classList.contains('zoomed')) cls.push('zoomed');
  card.className = cls.join(' ');

  const head = card.querySelector('.cchead');
  const divBadge = it.chanState?.divergence === 'pending'
    ? `<span class="st badge-div">${it.chanState.divDir === 'top' ? '顶' : '底'}背驰酝酿</span>` : '';

  if (isAlert) {
    head.querySelector('.lv').innerHTML = `<span class="sym">${it.symbol}</span>`;
    head.querySelector('.roles').innerHTML = `<span class="rb lvl">${it.label}</span>`;
    const st = head.querySelector('.st');
    st.textContent = it.mode === 'closed' ? '已确认' : '预警';
    st.className = 'st ' + (it.mode === 'closed' ? 's1' : 's3');
    // 形态提醒没有评分，用方向标签代替；共振信号仍显示组合与评分
    const isDual = it.kind === 'dual';
    head.querySelector('.sp').innerHTML = isDual
      ? `<span class="grp">${it.side === 'long' ? '双阴不破 · 看多' : '双阳不穿 · 看空'}</span>` + (divBadge ? ' ' + divBadge : '')
      : `<span class="grp">${String(it.group).replace(/>/g, '→')}</span>`
        + `<span class="sc">${it.score}分</span>` + divBadge;
    const t = new Date(it.at || Date.now());
    const p = n => String(n).padStart(2, '0');
    head.querySelector('.px').textContent =
      `${fmtPrice(it.price)}　${p(t.getHours())}:${p(t.getMinutes())}`;
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
    e.candle.setData([]); e.ma7.setData([]); e.ema7.setData([]); e.ma25.setData([]);
    e.pen.setData([]); e.pen.setMarkers([]);
    e.macdHist.setData([]); e.macdDif.setData([]); e.macdDea.setData([]); e.vol.setData([]);
    return;
  }
  const T = i2 => Math.floor(cs[i2][0] / 1000);      // ms → 秒
  e.candle.setData(cs.map((c, i2) => ({ time: T(i2), open: c[1], high: c[2], low: c[3], close: c[4] })));
  const line = arr => { const o = []; for (let i2 = 0; i2 < arr.length; i2++) if (arr[i2] != null) o.push({ time: T(i2), value: arr[i2] }); return o; };
  const showMA = document.querySelector('#chart-ma').checked;
  e.ma7.setData(showMA ? line(it.ma7) : []);
  e.ema7.setData(showMA ? line(it.ema7) : []);
  e.ma25.setData(showMA ? line(it.ma25) : []);

  // 缠论笔
  const showChan = document.querySelector('#chart-chan').checked;
  if (showChan && it.strokes?.length >= 2) {
    const idx = s => Math.max(0, Math.min(cs.length - 1, s[0]));
    e.pen.setData(it.strokes.map(s => ({ time: T(idx(s)), value: s[1] })));
    e.pen.setMarkers(it.strokes.map(s => ({
      time: T(idx(s)), position: s[2] > 0 ? 'aboveBar' : 'belowBar',
      color: s[2] > 0 ? '#f87171' : '#4ade80', shape: 'circle', size: 0.6,
    })));
  } else { e.pen.setData([]); e.pen.setMarkers([]); }

  // MACD 副图
  const showMacd = document.querySelector('#chart-macd').checked;
  if (showMacd && it.macd) {
    const h = [];
    for (let i2 = 0; i2 < cs.length; i2++) {
      const v = it.macd.hist[i2];
      if (v == null) continue;
      h.push({ time: T(i2), value: v, color: v >= 0 ? 'rgba(246,70,93,.75)' : 'rgba(14,203,129,.75)' });
    }
    e.macdHist.setData(h);
    e.macdDif.setData(line(it.macd.dif));
    e.macdDea.setData(line(it.macd.dea));
    e.chart.priceScale('macd').applyOptions({ visible: true, scaleMargins: { top: 0.78, bottom: 0.02 } });
  } else {
    e.macdHist.setData([]); e.macdDif.setData([]); e.macdDea.setData([]);
    e.chart.priceScale('macd').applyOptions({ visible: false });
  }
  // 成交量（关掉 MACD 时占位）
  const vd = [];
  for (let i2 = 0; i2 < cs.length; i2++) {
    vd.push({ time: T(i2), value: cs[i2][5], color: cs[i2][4] >= cs[i2][1] ? 'rgba(246,70,93,.35)' : 'rgba(14,203,129,.35)' });
  }
  e.vol.setData(showMacd ? [] : vd);

  // 尺寸适配；时间轴只在首次或宽度变化时 fitContent，避免每轮重置用户的缩放
  const holder = card.querySelector('.cchart');
  const w = holder.clientWidth, h = holder.clientHeight;
  if (e._w !== w || e._h !== h) { e.chart.applyOptions({ width: w, height: h }); e._w = w; e._h = h; }
  const fitKey = cs.length + '|' + w;
  if (e._fitFor !== fitKey) { e.chart.timeScale().fitContent(); e._fitFor = fitKey; }
}

function paintView(view) {
  view.items.forEach((it, i) => paintCard(view, i, it));
}

/* ---------------- 数据拉取 ---------------- */
async function refreshMulti() {
  const view = VIEWS.multi;
  if (!view.grid) return;
  if (!chartSymbol) {
    if (!ensureChartList()) return;
    selectChartSymbol(chartList[0]);
    return;
  }
  applyCols(view);
  const bars = currentBars(view);
  try {
    const d = await fetch(`/api/chart?symbol=${encodeURIComponent(chartSymbol)}&bars=${bars}`).then(r => r.json());
    if (d.error) return;
    view.items = d.levels;
    view.roles = d.roles ?? {};
    ensureCards(view, view.items);
    paintView(view);
    applyCols(view);
    const age = d.tickAt ? ((Date.now() - d.tickAt) / 1000).toFixed(1) : '—';
    document.querySelector('#chart-live').textContent =
      `共振 ${d.bullCount}/14 · ${bars} 根 · 行情 ${age}s 前 · ` +
      new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch { /* 忽略单次失败 */ }
}

async function refreshAlertView() {
  const view = VIEWS.alert;
  if (!view.grid) return;
  applyCols(view);
  const bars = currentBars(view);
  const limit = +document.querySelector('#alert-limit').value || 24;
  try {
    const d = await fetch(`/api/alertchart?bars=${bars}&limit=${limit}`).then(r => r.json());
    view.items = d.items ?? [];
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
    `<b>${item?.symbol ?? chartSymbol ?? ''}</b> <span class="k">${item?.label ?? ''}</span><br>`
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
  VIEWS.multi.grid = document.querySelector('#chartgrid');
  VIEWS.alert.grid = document.querySelector('#alertchartgrid');

  document.querySelector('#tab-matrix').addEventListener('click', () => setView('matrix'));
  document.querySelector('#tab-multi').addEventListener('click', () => setView('multi'));
  document.querySelector('#tab-alert').addEventListener('click', () => setView('alert'));
  document.querySelector('#chart-prev').addEventListener('click', () => stepChart(-1));
  document.querySelector('#chart-next').addEventListener('click', () => stepChart(1));
  document.querySelector('#chart-detail').addEventListener('click', () => { if (chartSymbol) openDetail(chartSymbol); });
  document.querySelector('#chart-cols').addEventListener('change', () => { applyCols(VIEWS.multi); refreshActive(); });
  document.querySelector('#chart-bars').addEventListener('change', () => refreshActive());
  document.querySelector('#alert-limit').addEventListener('change', () => refreshAlertView());
  document.querySelector('#alert-size').addEventListener('change', () => { applyCols(VIEWS.alert); refreshAlertView(); });
  ['#chart-ma', '#chart-chan', '#chart-mark', '#chart-macd'].forEach(s =>
    document.querySelector(s).addEventListener('change', () => {
      if (activeView === 'multi') paintView(VIEWS.multi);
      else if (activeView === 'alert') paintView(VIEWS.alert);
    }));
  document.querySelector('#alert-refresh').addEventListener('click', () => refreshAlertView());

  let rt = null;
  window.addEventListener('resize', () => {
    if (activeView === 'matrix') return;
    clearTimeout(rt);
    rt = setTimeout(() => refreshActive(), 250);
  });
  document.addEventListener('keydown', e => {
    if (activeView !== 'multi') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowLeft') stepChart(-1);
    if (e.key === 'ArrowRight') stepChart(1);
  });
  applyCols(VIEWS.multi);
  applyCols(VIEWS.alert);
}

if (typeof LC === 'undefined') {
  console.error('[chart] LightweightCharts 未加载，K线图不可用');
} else {
  initCharts();
}

function openChartFor(sym) {
  ensureChartList();
  selectChartSymbol(sym);
  setView('multi');
}
