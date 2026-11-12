/* 「反转提醒」：把配对共振的策略搬到一个独立标签页，
 *
 * 与「配对全景」的区别（配对全景完全不动）：
 *   · 信号 = 配对共振 **且** 次级别满足反转条件
 *        做多：回踩 ≥5 根后，连续两根阳K + 低点抬高（止跌）
 *        做空：镜像 —— 连续两根阴K + 高点降低（止涨）
 *   · 实时算，不看报警历史；**不推钉钉**，只在这里看
 *   · 不做固定/不记 localStorage，避免和配对全景的状态互相干扰
 *
 * 卡片样式复用 pgrid.js 的 buildPgCard()，保证两屏长得一样。
 */
'use strict';

const RG = {
  cols: 4,
  limit: 200,
  side: 'all',
  items: [],
  entries: [],
  timer: null,
  hidden: new Set(),
  loading: false,
};

/* ---------------- 卡片内容 ---------------- */

/** 底部信息：成交额 / 配对 / 方向 / 回踩根数 / 两根阳K / 止跌 */
function rgUpdateCard(e, it) {
  const pr = it.pair || {};
  const rb = pr.rebound || {};
  const up = pr.dir !== 'short';
  const card = e.card;

  card.dataset.sym = it.symbol;
  card.dataset.rgId = 'r|' + it.symbol + '|' + pr.sub + '-' + pr.main;
  card.classList.toggle('pg-long', up);
  card.classList.toggle('pg-short', !up);
  if (typeof isPinned === 'function') card.classList.toggle('pinned', isPinned(card.dataset.rgId));

  card.querySelector('.pg-sym').textContent = it.symbol;
  card.querySelector('.pg-price').textContent = pgFmtPrice(pr.price);
  const pct = Number(pr.changePct);
  const pctEl = card.querySelector('.pg-pct');
  pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  pctEl.className = 'pg-pct ' + (pct >= 0 ? 'up' : 'dn');

  const stopTxt = up ? '低点抬高' : '高点降低';
  card.querySelector('.pg-info').innerHTML =
    `<span class="pg-vol" title="24小时成交额">额 ${pgFmtVol(pr.quoteVolume)}</span>`
    + `<span class="pg-pair">${pr.subLabel}→${pr.mainLabel}</span>`
    + `<span class="pg-dir ${up ? 'up' : 'dn'}">${up ? '看多' : '看空'}</span>`
    + `<span>回踩 <b>${pr.subPullBars}</b> 根</span>`
    + `<span class="rg-two" title="连续两根${up ? '阳' : '阴'}K">${up ? '阳+阳' : '阴+阴'}</span>`
    + `<span class="rg-stop" title="止跌/止涨确认">✓ ${stopTxt}</span>`;

  /* ---- K线 ---- */
  const cs = it.candles;
  if (!cs || !cs.length) return;
  const T = i => Math.floor(cs[i][0] / 1000);
  syncSeries(e.candle, cs.map((c, i) => ({ time: T(i), open: c[1], high: c[2], low: c[3], close: c[4] })));
  const line = arr => { const o = []; for (let i = 0; i < arr.length; i++) if (arr[i] != null) o.push({ time: T(i), value: arr[i] }); return o; };
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
  }
  e.chart.priceScale('vol').applyOptions({ visible: false });
  syncSeries(e.vol, []);
  e.candle.setMarkers([]);
}

/* ---------------- 渲染 ---------------- */

function ensureRgCards(items) {
  const grid = document.querySelector('#revgrid');
  if (!grid) return [];
  while (RG.entries.length > items.length) {
    const e = RG.entries.pop();
    e.chart.remove();
    e.card.remove();
  }
  while (RG.entries.length < items.length) {
    const it = items[RG.entries.length];
    const card = buildPgCard();
    grid.appendChild(card);
    const e = initChart(card, it.minutes ?? 15);
    e.card = card;
    RG.entries.push(e);
    card.querySelector('.pg-acts').addEventListener('click', ev => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      ev.stopPropagation();
      const act = b.dataset.act;
      const id = card.dataset.rgId;
      if (act === 'pin' && typeof togglePin === 'function') {
        togglePin(id);
        card.classList.toggle('pinned', isPinned(id));
        const pb = card.querySelector('.pg-act[data-act="pin"]');
        if (pb) pb.title = isPinned(id) ? '已固定（固定的始终排在最前）' : '固定到最前';
      } else if (act === 'detail') {
        if (typeof openDetail === 'function') openDetail(card.dataset.sym);
      } else if (act === 'close') {
        RG.hidden.add(card.dataset.sym);
        loadRebound();
      }
    });
    card.addEventListener('click', () => {
      if (typeof openDetail === 'function') openDetail(card.dataset.sym);
    });
  }
  if (typeof syncCardOrder === 'function') syncCardOrder(grid, RG.entries.map(e => e.card));
  return RG.entries;
}

function applyRgCols() {
  const grid = document.querySelector('#revgrid');
  if (grid) grid.style.setProperty('--pgcols', RG.cols);
}

/* ---------------- 数据 ---------------- */

async function loadRebound() {
  if (RG.loading) return;
  const grid = document.querySelector('#revgrid');
  if (!grid) return;
  RG.loading = true;
  try {
    const q = `/api/pairreb?bars=120&limit=${RG.limit}${RG.side !== 'all' ? '&side=' + RG.side : ''}`;
    const r = await fetch(q);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();

    let items = (d.items || []).filter(it => !RG.hidden.has(it.symbol));
    if (typeof dedupeById === 'function') {
      const seen = new Set();
      items = items.filter(it => {
        const k = it.symbol + '|' + (it.pair || {}).pair;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // 和配对全景一个方式：固定的始终排在最前；
    // anchorPinned 会在信号已经不再成立时把上次那条补回来，避免固定卡凭空消失。
    // ⚠ 必须先统一 kind：pinId 走 r| 命名空间，否则和 RG.items 里的旧 id 对不上
    items = items.map(it => ({ ...it, kind: 'rev' }));
    if (typeof anchorPinned === 'function') items = anchorPinned(RG.items, items);
    if (typeof sortPinnedFirst === 'function') items = sortPinnedFirst(items);

    RG.items = items;
    applyRgCols();
    const entries = ensureRgCards(items);
    entries.forEach((e, i) => { if (items[i]) rgUpdateCard(e, items[i]); });

    const empty = document.querySelector('#rev-empty');
    if (empty) empty.style.display = items.length ? 'none' : '';
    const live = document.querySelector('#rev-live');
    if (live) {
      const n = items.length;
      live.textContent = n
        ? `共 ${d.total} 条反转信号（多 ${d.longs} / 空 ${d.shorts}）· 展示 ${n} 张`
          + ` · 条件：回踩 ≥${(d.options || {}).minPullBars ?? 5} 根 + 连续两根${'\u9633'}K + 止跌`
          + ` · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
        : '暂无符合条件的反转信号';
    }
  } catch (e) {
    const live = document.querySelector('#rev-live');
    if (live) live.textContent = '加载失败：' + e.message;
  } finally {
    RG.loading = false;
  }
}

function startReboundPoll() {
  if (RG.timer) return;
  loadRebound();
  RG.timer = setInterval(() => { if (!document.hidden) loadRebound(); }, 5000);
}

function stopReboundPoll() {
  if (RG.timer) { clearInterval(RG.timer); RG.timer = null; }
}

/* ---------------- 初始化 ---------------- */

(function initRebound() {
  const grid = document.querySelector('#revgrid');
  if (!grid) return;

  const sideSeg = document.querySelector('#rev-side');
  if (sideSeg) {
    sideSeg.addEventListener('click', ev => {
      const b = ev.target.closest('[data-side]');
      if (!b) return;
      RG.side = b.dataset.side;
      [...sideSeg.querySelectorAll('[data-side]')].forEach(x => x.classList.toggle('on', x === b));
      loadRebound();
    });
  }

  const limSel = document.querySelector('#rev-limit');
  if (limSel) limSel.addEventListener('change', () => {
    RG.limit = Math.max(20, Math.min(400, Number(limSel.value) || 200));
    loadRebound();
  });

  const rf = document.querySelector('#rev-refresh');
  if (rf) rf.addEventListener('click', () => loadRebound());

  const reset = document.querySelector('#rev-reset');
  if (reset) reset.addEventListener('click', () => { RG.hidden.clear(); loadRebound(); });
})();
