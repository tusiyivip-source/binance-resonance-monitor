/* 次级别回踩 / 主级别零轴 配对监控
 * 七组配对：5m-30m / 10m-1h / 15m-2h / 30m-3h / 1h-6h / 2h-12h / 4h-1d
 * 数据来自 /api/pairzero */
'use strict';

const PAIR = {
  side: 'all',
  mode: 'chart',      // 'chart' = 平铺K线（默认）；'table' = 明细表
  limit: 24,
  data: null,
  loading: false,
  timer: null,
};

function pairLabel(sub, main) {
  const L = {
    '1m': '1分', '2m': '2分', '3m': '3分', '5m': '5分', '10m': '10分',
    '15m': '15分', '30m': '30分', '1h': '1小时', '2h': '2小时', '3h': '3小时',
    '4h': '4小时', '6h': '6小时', '12h': '12小时', '1d': '日线', '1w': '周线',
  };
  return (L[sub] || sub) + ' → ' + (L[main] || main);
}

async function loadPair() {
  // 图表模式交给 chart.js 的 refreshPairView（它有自己的请求与轮询节流）
  if (PAIR.mode === 'chart') {
    if (typeof refreshPairView === 'function') await refreshPairView();
    return;
  }
  if (PAIR.loading) return;
  PAIR.loading = true;
  try {
    const r = await fetch(`/api/pairzero?side=${PAIR.side}&limit=${PAIR.limit}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    PAIR.data = await r.json();
    renderPair();
  } catch (e) {
    const el = $('#pair-live');
    if (el) el.textContent = '加载失败：' + e.message;
  } finally {
    PAIR.loading = false;
  }
}

function renderPair() {
  const d = PAIR.data;
  const body = $('#pairbody');
  if (!d || !body) return;

  const items = (d.items || []).slice(0, PAIR.limit);
  const emptyEl = $('#pair-empty');
  if (emptyEl) emptyEl.style.display = items.length ? 'none' : '';

  const mp = $('#pair-minpull');
  if (mp && d.options) mp.textContent = d.options.minPullBars;

  const frag = document.createDocumentFragment();
  items.forEach((it, i) => {
    const tr = document.createElement('tr');
    const up = it.dir === 'long';
    const td = (cls, txt, title) => {
      const c = document.createElement('td');
      c.className = cls;
      if (txt != null) c.textContent = txt;
      if (title) c.title = title;
      tr.appendChild(c);
      return c;
    };
    td('c-rank', i + 1);
    const sym = td('c-sym', base(it.symbol) + ' · #' + it.rank, it.symbol + '　涨幅榜第 ' + it.rank + ' 名');
    sym.style.cursor = 'pointer';
    sym.addEventListener('click', () => { if (typeof openDetail === 'function') openDetail(it.symbol); });
    td('c-pair', pairLabel(it.sub, it.main),
      '次级别 ' + it.subLabel + '，主级别 ' + it.mainLabel);
    const dir = td('c-dir', up ? '多' : '空');
    dir.style.color = up ? '#22c55e' : '#ef4444';
    td('num ' + (up ? 'up' : 'down'), numStr(it.mainDif),
      '主级别 DIF ' + numStr(it.mainDif) + '（' + (up ? '零轴上方' : '零轴下方') + '）');
    td('num', it.mainHold + ' 根', '主级别 DIF 已在同侧 ' + it.mainHold + ' 根');
    td('num ' + (up ? 'up' : 'down'), numStr(it.subDif),
      '次级别 DIF ' + numStr(it.subDif) + '（与主级别同侧，未穿越零轴）');
    const pull = td('num', it.subPullBars + ' 根',
      (up ? '回踩' : '反弹') + '已 ' + it.subPullBars + ' 根（本轮极值 ' + numStr(it.subPeak) + '）');
    pull.style.color = it.subPullBars >= 5 ? '#f0b90b' : '';
    td('c-price num', fmtPrice(it.price));
    td('c-chg num ' + (it.changePct > 0 ? 'up' : it.changePct < 0 ? 'down' : ''), pctStr(it.changePct));
    td('c-vol num', fmtVol(it.quoteVolume));
    td('c-time', zeroTime ? zeroTime(it.subAt) : '—');
    frag.appendChild(tr);
  });
  body.textContent = '';
  body.appendChild(frag);

  const live = $('#pair-live');
  if (live) {
    live.textContent = items.length
      ? `命中 ${d.total} 条（多 ${d.longs} / 空 ${d.shorts}） · 展示 ${items.length} 条 · `
        + new Date().toLocaleTimeString('zh-CN', { hour12: false })
      : '当前没有符合条件的配对信号 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  }
}

function numStr(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1) return n.toFixed(4);
  if (a >= 0.001) return n.toFixed(6);
  if (a === 0) return '0';
  return n.toExponential(2);
}

function startPairPoll() {
  stopPairPoll();
  loadPair();
  PAIR.timer = setInterval(() => { if (!document.hidden) loadPair(); }, 5000);
}
function stopPairPoll() {
  if (PAIR.timer) { clearInterval(PAIR.timer); PAIR.timer = null; }
}

/** 切换「K线图 / 表格」两种展示 */
function applyPairMode() {
  const chart = PAIR.mode !== 'table';
  const cw = $('#pairchartwrap'), tw = $('#pairtablewrap');
  if (cw) cw.style.display = chart ? '' : 'none';
  if (tw) tw.style.display = chart ? 'none' : '';
  const sel = $('#pair-size');
  if (sel) sel.style.display = chart ? '' : 'none';
  loadPair();
}

document.addEventListener('DOMContentLoaded', () => {
  startPairPoll();
  const modeSel = $('#pair-mode');
  if (modeSel) {
    PAIR.mode = modeSel.value === 'table' ? 'table' : 'chart';
    modeSel.addEventListener('change', () => {
      PAIR.mode = modeSel.value === 'table' ? 'table' : 'chart';
      applyPairMode();
    });
    applyPairMode();
  }
  const box = $('#pairseg-side');
  if (box) {
    box.addEventListener('click', e => {
      const b = e.target.closest('[data-side]');
      if (!b) return;
      PAIR.side = b.dataset.side;
      box.querySelectorAll('[data-side]').forEach(x => x.classList.toggle('on', x === b));
      loadPair();
    });
  }
  const lim = $('#zero-limit');
  if (lim) {
    PAIR.limit = Number(lim.value) || 24;
    lim.addEventListener('change', () => { PAIR.limit = Number(lim.value) || 24; loadPair(); });
  }
  const sizeSel = $('#pair-size');
  if (sizeSel) {
    sizeSel.addEventListener('change', () => {
      if (typeof applyCols === 'function' && typeof VIEWS !== 'undefined' && VIEWS.pair) {
        applyCols(VIEWS.pair);
      }
    });
  }
  const rf = $('#zero-refresh');
  if (rf) rf.addEventListener('click', () => {
    if (typeof setPinFirstMode === 'function') setPinFirstMode(true);
    loadPair();
  });
});
