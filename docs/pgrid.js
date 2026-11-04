/* 「配对全景」：一个**独立的**多图平铺屏
 *
 * 只读展示，不产生任何报警/推送 —— 推送由引擎的 pairZeroAlertSweep 负责，
 * 这里只拉 /api/pairchart（只读接口），所以不会和钉钉重复提醒，
 * 也不会干扰现有的「配对监控」标签页。
 *
 * 每个面板：币种 / 价格 / 涨跌幅 + K线(两条均线) + 成交量副图 + 配对详情
 */
'use strict';

const PG = {
  cols: 4,          // 固定一行 4 个
  limit: 200,       // 显示全部已提醒的（服务端最多 400）
  side: 'all',
  items: [],
  entries: [],
  timer: null,
  loading: false,
  hidden: new Set(),      // 被 ✕ 关掉的面板（只在本屏隐藏）
};

const PG_COLORS = {
  up: '#f6465d', down: '#0ecb81',
  ma7: '#f0b90b', ema7: '#0ef0f0',
  volUp: 'rgba(246,70,93,.55)', volDown: 'rgba(14,203,129,.55)',
};

function pgFmtPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '$—';
  if (n >= 1000) return '$' + n.toFixed(2);
  if (n >= 1) return '$' + n.toFixed(4);
  if (n >= 0.01) return '$' + n.toFixed(5);
  return '$' + n.toPrecision(4);
}

/* ---------------- 面板 ---------------- */
function buildPgCard() {
  const card = document.createElement('div');
  card.className = 'pgcard';
  card.innerHTML = `
    <div class="pg-h">
      <b class="pg-sym"></b>
      <span class="pg-price"></span>
      <span class="pg-pct"></span>
      <span class="pg-acts">
        <button class="pg-act" data-act="pin" title="固定到最前">📌</button>
        <button class="pg-act" data-act="detail" title="查看级别明细">📋</button>
        <button class="pg-act" data-act="close" title="从本屏移除（不影响策略）">✕</button>
      </span>
    </div>
    <div class="pg-chart cchart"></div>
    <div class="pg-f">
      <span class="pg-ok">✓ 数据正常</span>
      <span class="pg-info"></span>
    </div>`;
  return card;
}

function pgUpdateCard(e, it) {
  const pr = it.pair || {};
  const up = pr.dir !== 'short';
  const card = e.card;
  card.dataset.sym = it.symbol;
  card.dataset.pgId = 'p|' + it.symbol + '|' + pr.sub + '-' + pr.main;
  card.classList.toggle('pg-long', up);
  card.classList.toggle('pg-short', !up);
  const pinned = typeof isPinned === 'function' && isPinned(card.dataset.pgId);
  card.classList.toggle('pinned', pinned);

  card.querySelector('.pg-sym').textContent = it.symbol;
  card.querySelector('.pg-price').textContent = pgFmtPrice(pr.price);
  const pct = Number(pr.changePct);
  const pctEl = card.querySelector('.pg-pct');
  pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  pctEl.className = 'pg-pct ' + (pct >= 0 ? 'up' : 'dn');
  card.querySelector('.pg-info').innerHTML =
    `<span class="pg-pair">${pr.subLabel}→${pr.mainLabel}</span>`
    + `<span class="pg-dir ${up ? 'up' : 'dn'}">${up ? '看多' : '看空'}</span>`
    + `<span>${up ? '回踩' : '反弹'} <b>${pr.subPullBars}</b> 根</span>`
    + `<span title="主级别 DIF">主 ${Number(pr.mainDif).toPrecision(3)}</span>`
    + `<span title="次级别 DIF">次 ${Number(pr.subDif).toPrecision(3)}</span>`;

  // —— K线 ——
  const cs = it.candles;
  if (!cs || !cs.length) return;
  const T = i => Math.floor(cs[i][0] / 1000);
  syncSeries(e.candle, cs.map((c, i) => ({ time: T(i), open: c[1], high: c[2], low: c[3], close: c[4] })));
  const line = arr => { const o = []; for (let i = 0; i < arr.length; i++) if (arr[i] != null) o.push({ time: T(i), value: arr[i] }); return o; };
  syncSeries(e.ma7, line(it.ma7));
  syncSeries(e.ema7, line(it.ema7));
  syncSeries(e.ma25, []);
  syncSeries(e.pen, []);

  // MACD 副图（DIF/DEA + 柱），成交量让位
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
  e.candle.setMarkers([]);
}

/* ---------------- 渲染 ---------------- */
function ensurePgCards(items) {
  const grid = document.querySelector('#pggrid');
  if (!grid) return [];
  while (PG.entries.length > items.length) {
    const e = PG.entries.pop();
    e.chart.remove();
    e.card.remove();
  }
  while (PG.entries.length < items.length) {
    const it = items[PG.entries.length];
    const card = buildPgCard();
    grid.appendChild(card);
    const e = initChart(card, it.minutes ?? 15);
    e.card = card;
    PG.entries.push(e);
    // 操作按钮
    card.querySelector('.pg-acts').addEventListener('click', ev => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      ev.stopPropagation();
      const act = b.dataset.act;
      const id = card.dataset.pgId;
      if (act === 'pin' && typeof togglePin === 'function') {
        togglePin(id);
        card.classList.toggle('pinned', isPinned(id));
        loadPairGrid();
      } else if (act === 'detail') {
        if (typeof openDetail === 'function') openDetail(card.dataset.sym);
      } else if (act === 'close') {
        PG.hidden.add(card.dataset.sym);
        loadPairGrid();
      }
    });
    card.addEventListener('click', () => {
      if (typeof openDetail === 'function') openDetail(card.dataset.sym);
    });
  }
  // DOM 顺序跟着数据走
  PG.entries.forEach(e => grid.appendChild(e.card));
  return PG.entries;
}

function applyPgCols() {
  const grid = document.querySelector('#pggrid');
  if (grid) grid.style.setProperty('--pgcols', PG.cols);
}

async function loadPairGrid() {
  if (PG.loading) return;
  PG.loading = true;
  try {
    // 数据源是「已经推送过（已提醒）的配对信号」，不是当前实时状态
    // 把「已固定」的面板 id 传给服务端：即使它的报警已过期，也必须继续画出来
    const pins = (typeof PINNED !== 'undefined' ? [...PINNED] : []).filter(x => x.startsWith('p|'));
    const pinQ = pins.length ? '&pin=' + encodeURIComponent(pins.join(',')) : '';
    const q = `/api/pairgrid?bars=120&limit=${PG.limit}${pinQ}`;
    const r = await fetch(q);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    let items = (d.items || []).filter(it => !PG.hidden.has(it.symbol));
    if (PG.side === 'long') items = items.filter(it => (it.pair || {}).dir === 'long');
    else if (PG.side === 'short') items = items.filter(it => (it.pair || {}).dir === 'short');
    if (typeof sortPinnedFirst === 'function') items = sortPinnedFirst(items);
    // 截断时保证固定的那些一定留下
    if (items.length > PG.limit) {
      const pinOf = it => (typeof pinIdOf === 'function' ? pinIdOf(it) : '');
      const keep = items.filter(it => typeof isPinned === 'function' && isPinned(pinOf(it)));
      const rest = items.filter(it => !(typeof isPinned === 'function' && isPinned(pinOf(it))));
      items = keep.concat(rest).slice(0, Math.max(PG.limit, keep.length));
    }
    PG.items = items;
    applyPgCols();
    const entries = ensurePgCards(items);
    entries.forEach((e, i) => { if (items[i]) pgUpdateCard(e, items[i]); });
    const emptyEl = document.querySelector('#pg-empty');
    if (emptyEl) emptyEl.style.display = items.length ? 'none' : '';
    const live = document.querySelector('#pg-live');
    if (live) {
      live.textContent = items.length
        ? `${items.length} 个面板 · 4 列 · 已提醒 ${d.total} 条 · `
          + new Date().toLocaleTimeString('zh-CN', { hour12: false })
        : '当前没有配对信号';
    }
  } catch (e) {
    const live = document.querySelector('#pg-live');
    if (live) live.textContent = '加载失败：' + e.message;
  } finally {
    PG.loading = false;
  }
}

function startPgPoll() {
  stopPgPoll();
  loadPairGrid();
  PG.timer = setInterval(() => { if (!document.hidden) loadPairGrid(); }, 5000);
}
function stopPgPoll() {
  if (PG.timer) { clearInterval(PG.timer); PG.timer = null; }
}

document.addEventListener('DOMContentLoaded', () => {
  // 列数固定一行 4 个，所以不再有列数下拉
  const limSel = document.querySelector('#pg-limit');
  if (limSel) limSel.addEventListener('change', () => {
    PG.limit = Number(limSel.value) || 200; loadPairGrid();
  });
  const sideBox = document.querySelector('#pgseg-side');
  if (sideBox) sideBox.addEventListener('click', e => {
    const b = e.target.closest('[data-side]');
    if (!b) return;
    PG.side = b.dataset.side;
    sideBox.querySelectorAll('[data-side]').forEach(x => x.classList.toggle('on', x === b));
    loadPairGrid();
  });
  const rf = document.querySelector('#pg-refresh');
  if (rf) rf.addEventListener('click', () => loadPairGrid());
  const reset = document.querySelector('#pg-reset');
  if (reset) reset.addEventListener('click', () => { PG.hidden.clear(); loadPairGrid(); });
});
