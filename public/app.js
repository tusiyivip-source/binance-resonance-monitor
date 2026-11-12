/* 币安多级别共振盯盘 — 前端 */
'use strict';

const $ = s => document.querySelector(s);
const STATE_NAME = { 0: '数据不足', 1: '多头排列', 2: '站上MA7', 3: '均线纠缠', 4: '弱势', 5: '空头排列' };
const EVENT_NAME = { 0: '', 1: '上穿MA7', 2: '回踩MA7', 3: '跌破MA7', 4: '回踩后突破' };

let LEVELS = [];
let SNAP = null;
let HEADER_DONE = false;
// null = 强制重建行顺序。注意不能用 ''：当筛选结果为空集时 orderKey 也是 ''，会被误判为"顺序未变"
let lastOrderKey = null;
let sortKey = 'firstNear';
let sortDir = -1;
let stockRows = new Map();   // symbol -> {tr, refs}
let DISPLAY_ORDER = [];      // 当前表格显示顺序（供 K 线图 ◀ ▶ 使用）
let alerts = [];
let PRICE = new Map();       // symbol -> 最新价（用于报警卡片"信号后"追踪）
let cfg = null;
let soundOn = localStorage.getItem('sound') === '1';
let notifyOn = localStorage.getItem('notify') === '1';
const activeChips = new Set();

/* ---------------- 格式化 ---------------- */
// 注意：不能用 !isFinite(p) 判断，因为 isFinite(null) === true（Number(null) 是 0），
// 结果 null 会一路走到 p.toPrecision() 抛异常，把整个抽屉的渲染打断。
// 没有数据的级别（新上市币、K线不足）会返回 null，必须显式拦住。
function fmtPrice(p) {
  if (p === null || p === undefined || !isFinite(p)) return '—';
  if (p >= 1000) return p.toFixed(2);
  if (p >= 100) return p.toFixed(3);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  if (p >= 0.0001) return p.toFixed(6);
  return p.toPrecision(4);
}
function fmtVol(v) {
  if (!v) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(v);
}
const pctStr = v => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
function hhmmss(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const base = s => s.replace(/USDT$/, '');
const lvLabel = k => { const f = LEVELS.find(x => x.key === k); return f ? f.label : k; };

function signalKind(a) { return a.kind ?? 'resonance'; }
function signalConfirmed(a) {
  return typeof a.confirmed === 'boolean' ? a.confirmed
    : a.mode === 'closed' || ['dual', 'zeropair'].includes(signalKind(a));
}
function signalHasScore(a) {
  return signalKind(a) === 'resonance' && Number.isFinite(a.score);
}
function signalChain(a) {
  if (a.pair) return a.pair;
  if (a.sub && a.main) return `${lvLabel(a.sub)} → ${lvLabel(a.main)}`;
  const kind = signalKind(a);
  if (kind === 'singlek') {
    // 单K没有「组合」，副标题写它自己的关键信息：零轴位置 + 幅度
    const up = a.side !== 'short';
    return `${lvLabel(a.level || a.base) || '—'} · `
      + (a.zeroSide === 'above' ? '零轴上 ' : a.zeroSide === 'below' ? '零轴下 ' : '')
      + (up ? '大阳线 +' : '大阴线 −') + Number(a.bodyPct ?? 0).toFixed(1) + '%';
  }
  if (kind === 'dual') return `${lvLabel(a.level || a.base) || '—'} · ${a.side === 'short' ? '双阳不穿' : '双阴不破'}`;
  return [a.base, a.mid, a.big].filter(Boolean).map(lvLabel).join(' → ') || '历史记录（组合未保存）';
}
function zeroFilterMatches(item) {
  const symbol = item.symbol || item.sym || '';
  const idx = SNAP?.symbols.indexOf(symbol) ?? -1;
  const row = idx >= 0 ? SNAP.rows[idx] : null;
  const side = item.dir || item.side;
  const want = $('#f-side')?.value || 'all';
  if (want !== 'all' && side !== want) return false;
  if (!symbol.toUpperCase().includes(($('#q')?.value || '').trim().toUpperCase())) return false;
  if (activeChips.has('up') && !((item.changePct ?? row?.[1]) > 0)) return false;
  if (activeChips.has('sig') && item.signal === false) return false;
  if (activeChips.has('conf') && item.confirmed === false) return false;
  if (activeChips.has('seed') && !(item.seeded ?? row?.[7])) return false;
  return true;
}
function filteredZeroPairs() { return (ZERO?.items || []).filter(zeroFilterMatches); }

/* ---------------- 声音 ---------------- */
let actx = null;
function ensureAudio() {
  if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* 不支持则忽略 */ } }
  if (actx && actx.state === 'suspended') actx.resume();
  return actx;
}
function beep(kind) {
  if (!soundOn) return;
  const ctx = ensureAudio(); if (!ctx) return;
  const now = ctx.currentTime;
  const notes = kind === 'confirmed' ? [880, 1320] : [660];
  notes.forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now + i * 0.11);
    g.gain.exponentialRampToValueAtTime(0.22, now + i * 0.11 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 0.19);
    o.connect(g); g.connect(ctx.destination);
    o.start(now + i * 0.11); o.stop(now + i * 0.11 + 0.22);
  });
}

/* ---------------- Toast ---------------- */
function toast(html, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 5200);
  setTimeout(() => el.remove(), 5700);
}

async function requestJSON(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok || data?.error) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时，请检查连接后重试');
    throw error;
  } finally { clearTimeout(timer); }
}

async function runAction(button, action) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { return await action(); }
  catch (error) { toast('操作失败：' + escapeHTML(error.message), true); }
  finally { if (button) button.disabled = false; }
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ---------------- SSE ---------------- */
let sse = null, lastSnapAt = 0, snapGap = 0;
let streamState = 'connecting';
let marketHealth = { kind: 'warn', text: '行情源检查中' };
function renderConnection() {
  const age = lastSnapAt ? performance.now() - lastSnapAt : Infinity;
  const stale = age > 8000;
  const kind = streamState !== 'open' || stale ? 'bad' : marketHealth.kind;
  const stream = streamState === 'open' ? (stale ? '页面数据中断' : '页面实时连接') : '页面连接重连中';
  setWs(kind, `${stream} · ${marketHealth.text}`);
}
function connect() {
  if (sse) sse.close();
  sse = new EventSource('/api/stream');
  sse.addEventListener('open', () => { streamState = 'open'; renderConnection(); });
  sse.addEventListener('error', () => { streamState = 'error'; renderConnection(); });
  sse.addEventListener('hello', e => {
    const d = JSON.parse(e.data);
    LEVELS = d.levels;
    ALL_LEVELS = d.allLevels ?? d.levels;
    cfg = d.cfg;
    // 零轴表已改成「配对视图」，表头是固定的 12 列，不再按级别动态注入
    fillCfgForm();
    renderGroups();
    if (d.app?.marketName) {
      MARKET_NAME = d.app.marketName;
      const sub = document.querySelector('.brand p');
      if (sub) {
        const feedTxt = d.app.feed === 'tick-rest' ? '实时价+REST补K线' : d.app.feed === 'kline-ws' ? 'K线WebSocket' : '自动';
        sub.textContent = `${d.app.marketName} · 涨幅榜 Top${d.app.topN} · ${LEVELS.length} 个级别 · MA7/EMA7 回踩突破共振 · 行情源 ${feedTxt}`;
      }
      const h1 = document.querySelector('.brand h1');
      if (h1) h1.textContent = `币安多级别共振盯盘 · ${d.app.market === 'futures' ? '合约' : '现货'}`;
    }
  });
  sse.addEventListener('snapshot', e => {
    const t = performance.now();
    if (lastSnapAt) snapGap = t - lastSnapAt;
    lastSnapAt = t;
    renderConnection();
    SNAP = JSON.parse(e.data);
    // 零轴表是固定的配对列，不再按级别注入表头（否则会多出 9 个空列把表格撑歪）
    if (!LEVELS.length && SNAP.levels) LEVELS = SNAP.levels;
    render();
  });
  sse.addEventListener('alerts', e => {
    alerts = JSON.parse(e.data);
    renderAlerts();
  });
  sse.addEventListener('alert', e => {
    const a = JSON.parse(e.data);

    // ⚠ 顺序很关键：**先通知，再渲染**，且两者各自 try/catch。
    //   原来是先 renderAlerts() 再弹窗 —— 渲染一旦抛异常（比如某个报警类型字段不全），
    //   弹窗和鸣笛就永远不会执行，用户表现为「信号不弹了」，非常难查。
    //   通知路径不能依赖渲染路径。
    if (!a.initial) {
      try {
        beep(a.confirmed ? 'confirmed' : 'preview');
      } catch (err) { console.warn('[alert] 鸣笛失败', err); }
      try {
        // 不再弹左侧浮层 —— 报警直接进右侧「共振报警」面板（上面 renderAlerts 已处理）。
        // 浮层会盖住图表，用户明确要求去掉；只保留鸣笛与用户自行开启的桌面通知。
        const isDual = a.kind === 'dual';
        const tag = isDual
          ? (a.side === 'long' ? '🔴 双阴不破 · 看多' : '🟢 双阳不穿 · 看空')
          : (a.confirmed ? '✅ 共振确认' : '⚡ 共振预警');
        if (notifyOn && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(`${a.symbol} ${tag.replace(/[🔴🟢✅⚡]\s*/g, '')}`,
            { body: a.text, tag: a.symbol + (a.level || a.base) + a.candleT });
        }
      } catch (err) { console.warn('[alert] 通知失败', err); }
    }

    alerts.unshift(a);
    if (alerts.length > 300) alerts.pop();
    try { renderAlerts(); } catch (err) { console.warn('[alert] 面板渲染失败', err); }
  });
}
function setWs(kind, text) {
  const p = $('#pill-ws');
  p.className = 'pill ' + kind;
  p.innerHTML = `<i></i>${text}`;
}

/* ---------------- 表头 ---------------- */
/**
 * 建级别列表头。
 * 级别集合以**后端返回的 levels 为准**（buildHeader 会被 renderZero 用接口数据再调一次），
 * 这样后端增删级别时前端表头会自动跟上，不会出现列错位。
 * 传进来的 keys 与上次相同就直接返回，避免每 2 秒重复重建。
 */
let HEADER_KEYS = '';
function buildHeader(keys) {
  const list = (keys && keys.length) ? keys : ZERO_LEVELS;
  const sig = list.join(',');
  if (HEADER_DONE && HEADER_KEYS === sig) return;
  HEADER_DONE = true;
  HEADER_KEYS = sig;
  const head = $('#head');
  // 先清掉旧的级别列，避免重复追加
  head.querySelectorAll('th.lv').forEach(th => th.remove());
  for (const key of list) {
    const label = lvLabel(key);
    const th = document.createElement('th');
    th.className = 'lv';
    th.textContent = label ?? key;
    th.title = `${label ?? key} 级别`;
    head.appendChild(th);
  }
}

/* ---------------- 行构建 ---------------- */
function makeRow(sym) {
  const tr = document.createElement('tr');
  const refs = {};
  const td = (cls, html) => {
    const c = document.createElement('td');
    c.className = cls;
    if (html != null) c.innerHTML = html;
    tr.appendChild(c);
    return c;
  };

  refs.rank = td('c-rank', '');
  refs.sym = td('c-sym', `<span class="base">${base(sym)}</span><span class="quote">USDT</span><span class="det" title="级别明细表">📋</span>`);
  refs.price = td('c-price num', '');
  refs.chg = td('c-chg num', '');
  refs.vol = td('c-vol num', '');
  refs.bull = td('c-bull num', '');       // 达标级别数
  refs.longs = td('c-score num', '');     // 零轴上方达标
  refs.shorts = td('c-score num', '');    // 零轴下方达标
  refs.flag = td('c-flag', '');
  refs.cells = [];
  for (let i = 0; i < ZERO_LEVELS.length; i++) {
    const c = td('lv', '<div class="cell"></div>');
    refs.cells.push(c.firstChild);
  }
  refs.sym.addEventListener('click', e => {
    // 点币种名 → K线图；点 📋 → 级别明细表
    if (e.target.classList.contains('det')) { e.stopPropagation(); openDetail(sym); return; }
    if (typeof openChartFor === 'function') openChartFor(sym);
    else openDetail(sym);
  });
  refs._cache = {};
  return { tr, refs };
}

/* ---------------- Seven independent timeframe monitors ---------------- */
const ZERO_LEVELS = ['15m','30m','1h','2h','3h','4h','6h'];
let ZERO = null;
let pairListKey = '';
const pairRows = new Map();
function makeMonitorRow(p) {
  const tr=document.createElement('tr'),refs={};
  for(const key of ['rank','sym','level','dir','near','hold','dif','dea','first','price','chg','vol','time']) {
    const td=document.createElement('td');td.className='c-'+key+(key==='sym'?'':' num');tr.appendChild(td);refs[key]=td;
  }
  refs.sym.textContent=base(p.symbol);
  refs.sym.addEventListener('click',()=>typeof openChartFor==='function'?openChartFor(p.symbol):openDetail(p.symbol));
  return {tr,refs};
}
function renderZero() {
  // 零轴表格页已被「结构卡片墙」取代，DOM 不存在时直接返回（防呆）
  if (!document.querySelector('#grid')) return;
  if ($('#zero-mode')?.value==='chart'||!ZERO) return;
  const list=filteredZeroPairs();
  const cmp={sym:(a,b)=>a.symbol.localeCompare(b.symbol),price:(a,b)=>a.price-b.price,
    change:(a,b)=>a.changePct-b.changePct,near:(a,b)=>a.near-b.near,
    hold:(a,b)=>a.hold-b.hold,dif:(a,b)=>a.dif-b.dif,dea:(a,b)=>a.dea-b.dea}[sortKey];
  if(cmp) list.sort((a,b)=>sortDir*cmp(a,b));
  else list.sort((a,b)=>(a.firstNearAt??Infinity)-(b.firstNearAt??Infinity)||a.near-b.near);
  DISPLAY_ORDER=[...new Set(list.map(p=>p.symbol))];
  const identity=p=>p.symbol+'|'+p.level,key=list.map(identity).join(','),reorder=key!==pairListKey;
  const frag=document.createDocumentFragment();
  list.forEach((p,i)=>{
    const id=identity(p);let r=pairRows.get(id);if(!r){r=makeMonitorRow(p);pairRows.set(id,r);}
    const f=r.refs;f.rank.textContent=i+1;f.level.textContent=lvLabel(p.level);
    f.dir.textContent=p.dir==='long'?'多':'空';f.near.textContent=(p.near*100).toFixed(1)+'%';
    f.hold.textContent=p.hold;f.dif.textContent=Number(p.dif).toPrecision(4);f.dea.textContent=Number(p.dea).toPrecision(4);
    f.first.textContent=zeroTime(p.firstNearAt);f.price.textContent=fmtPrice(p.price);
    f.chg.textContent=pctStr(p.changePct);f.chg.className='c-chg num '+(p.changePct>0?'up':p.changePct<0?'down':'flat');
    f.vol.textContent=fmtVol(p.quoteVolume);f.time.textContent=zeroTime(p.at);
    if(reorder)frag.appendChild(r.tr);
  });
  if(reorder){$('#body').textContent='';$('#body').appendChild(frag);}pairListKey=key;
  const keep=new Set(list.map(identity));for(const id of pairRows.keys())if(!keep.has(id))pairRows.delete(id);
  $('#empty').style.display=list.length?'none':'block';
  if(!list.length)$('#empty').textContent='七个独立周期当前没有符合靠近程度的级别，可放宽阈值或切换方向。';
  $('#pill-bull').textContent='独立级别 '+list.length;
  $('#zero-live').textContent='七周期独立监控 · 达标 '+list.length+' 个级别 · 最近更新 '+zeroTime(ZERO.t)+zeroStatusSuffix();
}

/** 解码一个级别格子（与 signals.js 的 encodeZero 对应） */
function zeroCellInfo(code) {
  if (!code) return null;
  return {
    side: Math.floor(code / 100000),            // 1=零轴上方 2=零轴下方
    pull: Math.floor(code / 10000) % 10 === 1,  // 是否正在回调
    hold: Math.floor(code / 100) % 100,         // 连续不破零轴根数
    nearPct: code % 100,                        // 0..99，越小越回踩零轴
  };
}

function render() {
  // 顶部统计与 PRICE 表仍取自主快照（报警卡片的「信号后」涨跌要用它）
  if (SNAP) {
    const { symbols, rows } = SNAP;
    const pm = new Map();
    for (let i = 0; i < symbols.length; i++) pm.set(symbols[i], rows[i][0]);
    PRICE = pm;
    $('#pill-sym').textContent = `标的 ${symbols.length}`;
    const sigCount = rows.filter(r => r[6] === 1).length;
    const pre = rows.filter(r => r[6] === 2).length;
    $('#pill-sig').innerHTML = `信号 <b>${sigCount}</b>${pre ? ` <span style="color:#fbbf24">+${pre}预警</span>` : ''}`;
    $('#pill-time').textContent = hhmmss(SNAP.t);
  }
  renderZero();
}

/**
 * 多级别「回调不破零轴 + 回踩零轴」表。
 *
 * 服务端把每个级别压成一个整数，这里解码后**按界面上的筛选条件重新判定**，
 * 所以改「靠近程度 / 方向 / 最少达标级别」立即生效，不用重新请求。
 */
function zeroTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return p(d.getMonth()+1)+'/'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
function zeroQuery() {
  return new URLSearchParams({
    q: $('#q')?.value || '', near: String(Number($('#f-near')?.value || 20) / 100),
    side: $('#f-side')?.value || 'all',
    onlyUp: activeChips.has('up') ? '1' : '0',
    onlySignal: activeChips.has('sig') ? '1' : '0',
    onlyConfirmed: activeChips.has('conf') ? '1' : '0',
    onlySeeded: activeChips.has('seed') ? '1' : '0',
  }).toString();
}
let zeroRequest = 0;
let zeroController = null, zeroPendingQuery = null, zeroLastSuccess = 0, zeroError = '';
function zeroStatusSuffix() {
  const stale = zeroLastSuccess && Date.now() - zeroLastSuccess > 10_000;
  return zeroError ? ' · 更新失败，保留旧数据：' + zeroError : stale ? ' · 数据已过期，等待更新' : '';
}
async function loadZero() {
  const query=zeroQuery();
  if (zeroPendingQuery === query && zeroController) return;
  zeroController?.abort();
  const request=++zeroRequest, controller=new AbortController();
  zeroController=controller; zeroPendingQuery=query;
  const timer=setTimeout(()=>controller.abort(), 15000);
  try {
    const response=await fetch('/api/zeroaxis?'+query,{signal:controller.signal});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const data=await response.json();
    if(request!==zeroRequest || query!==zeroQuery()) return;
    if(data.error) throw new Error(data.error);
    ZERO=data; zeroLastSuccess=Date.now(); zeroError='';
    DISPLAY_ORDER=[...new Set(filteredZeroPairs().map(p=>p.symbol))]; renderZero();
  } catch(error) {
    if(request!==zeroRequest) return;
    zeroError=error.name==='AbortError'?'请求超时':error.message;
    if ($('#zero-mode')?.value==='table') {
      if(ZERO) renderZero(); else $('#zero-live').textContent='零轴数据加载失败：'+zeroError;
    }
  } finally {
    clearTimeout(timer);
    if(request===zeroRequest){zeroController=null;zeroPendingQuery=null;}
  }
}

/* ---------------- 单K推动 + 回调不破（独立策略，只扫涨幅榜前 N） ---------------- */
let SINGLE = null;
let singleTimer = null;

async function loadSingleK() {
  try {
    const r = await fetch('/api/singlek?zero=' + ($('#single-zero')?.value || 'all'));
    if (!r.ok) return;
    SINGLE = await r.json();
    renderSingleK();
  } catch { /* 单次失败忽略 */ }
}

function renderSingleK() {
  const body = $('#singlebody');
  if (!body || !SINGLE) return;
  const items = SINGLE.items || [];
  const frag = document.createDocumentFragment();
  items.forEach((it, i) => {
    const tr = document.createElement('tr');
    const td = (cls, txt, title) => {
      const c = document.createElement('td');
      c.className = cls;
      if (txt != null) c.textContent = txt;
      if (title) c.title = title;
      tr.appendChild(c);
      return c;
    };
    td('c-rank', i + 1);
    const sym = td('c-sym', `${base(it.symbol)} · #${it.rank}`,
      `${it.symbol}　涨幅榜第 ${it.rank} 名`);
    sym.style.cursor = 'pointer';
    sym.addEventListener('click', () => { if (typeof openChartFor === 'function') openChartFor(it.symbol); });
    td('c-lv', it.levelLabel || it.level);
    const dirCell = td('c-dir', (it.side === 'short' ? '空' : '多'));
    dirCell.style.color = it.side === 'short' ? '#ef4444' : '#22c55e';
    const zCell = td('c-zero', it.zeroSide === 'above' ? '上' : it.zeroSide === 'below' ? '下' : '—');
    zCell.style.color = it.zeroSide === 'above' ? '#22c55e' : it.zeroSide === 'below' ? '#ef4444' : '#5b6f8c';
    zCell.title = it.zeroSide
      ? '单K发生时 DIF=' + Number(it.dif).toPrecision(3) + '（' + (it.zeroSide === 'above' ? '零轴上方' : '零轴下方') + '）'
      : '未取到 DIF';
    const up = it.side !== 'short';
    td('c-num ' + (up ? 'up' : 'down'), (up ? '+' : '−') + it.bodyPct.toFixed(2) + '%',
      `${up ? '大阳线' : '大阴线'}收盘 ${it.close} / 开盘 ${it.open}`);
    td('c-num', it.mult.toFixed(1) + '倍', '实体相对近20根平均实体的倍数');
    td('c-num', it.retracePct.toFixed(2) + '%',
      up ? `回调期间最低收盘 ${it.minClose}` : `反抽期间最高收盘 ${it.maxClose}`);
    td('c-num', it.barsAfter + ' 根', `${up ? '大阳线之后已回调' : '大阴线之后已反抽'}多少根`);
    td('c-num', String(it.line ?? it.low), up ? '回调期间所有收盘都没跌破这个价格' : '反抽期间所有收盘都没涨破这个价格');
    td('c-num', fmtPrice(it.price));
    const chg = td('c-num ' + (it.changePct > 0 ? 'up' : it.changePct < 0 ? 'down' : ''), pctStr(it.changePct));
    chg.title = '24 小时涨跌幅';
    td('c-num', fmtVol(it.quoteVolume));
    td('c-time', zeroTime(it.t), '大阳线的收盘时间');
    frag.appendChild(tr);
  });
  body.textContent = '';
  body.appendChild(frag);
  const emptyEl = $('#single-empty');
  if (emptyEl) emptyEl.style.display = items.length ? 'none' : 'block';
}

function singleModeNow() {
  return ($('#single-mode')?.value) === 'table' ? 'table' : 'chart';
}
/** 按「K线图 / 表格」切换单K页的两种展示，并启停对应的轮询 */
function applySingleMode() {
  const tbl = singleModeNow() === 'table';
  const tw = $('#singletablewrap'), cw = $('#singlechartwrap');
  if (tw) tw.style.display = tbl ? '' : 'none';
  if (cw) cw.style.display = tbl ? 'none' : '';
  if (tbl) { loadSingleK(); startSinglePoll(); }
  else { stopSinglePoll(); if (typeof refreshActive === 'function') refreshActive(); }
}
function startSinglePoll() {
  if (singleTimer) return;
  loadSingleK();
  singleTimer = setInterval(loadSingleK, 8000);
}
function stopSinglePoll() {
  if (singleTimer) { clearInterval(singleTimer); singleTimer = null; }
}

/* ---------------- 报警列表 ---------------- */
function signalChange(a, now) {
  if (!Number.isFinite(now) || !Number.isFinite(a.price) || a.price <= 0) return null;
  return ((now - a.price) / a.price) * 100 * (a.side === 'short' ? -1 : 1);
}
function signalChangeText(a) {
  const change = signalChange(a, PRICE.get(a.symbol));
  const label = a.side === 'short' ? '看空表现' : '看多表现';
  return change == null ? `${label} —` : `${label} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
}
let renderedAlerts = [];
function renderAlerts() {
  const box = $('#alertlist');
  $('#alert-count').textContent = alerts.length;
  const visible = alerts.slice(0, 120);
  if (renderedAlerts.length === visible.length && visible.every((a, i) => a === renderedAlerts[i]) && box.childElementCount) {
    box.querySelectorAll('[data-signal-change]').forEach((node, i) => {
      const change = signalChange(visible[i], PRICE.get(visible[i].symbol));
      node.textContent = signalChangeText(visible[i]);
      node.style.color = change == null ? '#5b6f8c' : change >= 0 ? '#22c55e' : '#ef4444';
    });
    return;
  }
  renderedAlerts = visible;
  const frag = document.createDocumentFragment();
  for (const a of visible) {
    const el = document.createElement('div');
    el.className = 'acard ' + (a.confirmed ? 'confirmed' : 'pre');
    const extra = (a.matchCount ?? (a.combos ? a.combos.length : 1)) - 1;
    // 防御：不同来源的报警字段并不一致（形态提醒没有 bullCount / distBaseMa7Pct），
    // 直接 .toFixed() 会抛异常并让整个面板渲染中断 —— 这里全部做存在性判断。
    const isDual = a.kind === 'dual';
    // 前 N / 后 N 分组标签（后端在 dual 报警里带了 tier，老记录没有就留空）
    const tierTxt = a.tier === 'top' ? '<b style="color:#f0b90b">前段</b>'
      : a.tier === 'tail' ? '<b style="color:#7dd3fc">后段</b>' : '';
    // 星标：涨幅榜最靠前那批，卡片左侧加一条金色竖条 + ★
    const starTxt = a.star ? '<b style="color:#fde047" title="涨幅榜前' + (a.starRank || 20) + '名">★</b> ' : '';
    const chainTxt = isDual
      ? (starTxt + tierTxt + ((starTxt || tierTxt) ? ' · ' : '')
        + lvLabel(a.level || a.base) + (a.side === 'long' ? ' · 双阴不破' : ' · 双阳不穿')
        + (Number.isFinite(a.rank) ? ` <span style="color:#5b6f8c">#${a.rank}</span>` : ''))
      : signalChain(a);
    const bullTxt = Number.isFinite(a.bullCount) ? ('共振 ' + a.bullCount + ' 级') : '';
    const distTxt = Number.isFinite(a.distBaseMa7Pct)
      ? ('距MA7 ' + (a.distBaseMa7Pct >= 0 ? '+' : '') + a.distBaseMa7Pct.toFixed(2) + '%') : '';
    const scoreTxt = signalHasScore(a) ? a.score + '分' : '';
    // 信号后表现追踪：用当前价与信号价对比，便于用户自行验证信号有效性
    const since = signalChange(a, PRICE.get(a.symbol));
    const sinceTxt = `<span data-signal-change style="color:${since == null ? '#5b6f8c' : since >= 0 ? '#22c55e' : '#ef4444'}" title="按信号方向计算的价格变化，未扣除交易成本">${signalChangeText(a)}</span>`;
    el.innerHTML = `
      <div class="l1">
        <span class="sym">${a.symbol}</span>
        <span class="badge2">${a.confirmed ? '已确认' : '预警'}</span>
        ${a.initial ? '<span class="badge3" style="background:#2a3444;color:#94a3b8">存量</span>' : ''}
        <span class="score">${scoreTxt}</span>
      </div>
      <div class="chain">${chainTxt}${extra > 0 ? ` <span style="color:#5b6f8c">(+${extra} 组)</span>` : ''}</div>
      <div class="txt">${escapeHTML(a.text)}</div>
      <div class="meta">
        <span>@${fmtPrice(a.price)}</span>
        ${bullTxt ? '<span>' + bullTxt + '</span>' : ''}
        ${distTxt ? '<span>' + distTxt + '</span>' : ''}
        <span>${hhmmss(a.ts)}</span>
        ${sinceTxt}
      </div>`;
    el.addEventListener('click', () => openDetail(a.symbol));
    frag.appendChild(el);
  }
  if (!alerts.length) {
    const p = document.createElement('div');
    p.style.cssText = 'color:#5b6f8c;font-size:12px;padding:14px;text-align:center;line-height:1.8';
    p.innerHTML = '暂无共振信号<br><span style="font-size:11px">系统正持续扫描涨幅榜前列标的 × 全部级别</span>';
    frag.appendChild(p);
  }
  box.textContent = '';
  box.appendChild(frag);
}

/* ---------------- 详情 ---------------- */
window.closeDetailThenChart = function (sym) {
  $('#detail').classList.add('hidden');
  if (typeof openChartFor === 'function') openChartFor(sym);
};
let detailRequest = 0;
async function openDetail(sym) {
  const request=++detailRequest;
  const d = await requestJSON('/api/detail?symbol=' + encodeURIComponent(sym)).catch(() => null);
  if(request!==detailRequest) return;
  if (!d || d.error) { toast('获取 ' + sym + ' 详情失败', true); return; }
  $('#d-title').innerHTML = `${sym} <span style="font-size:12px;color:${d.changePct >= 0 ? '#22c55e' : '#ef4444'}">${pctStr(d.changePct)}</span>`;
  let html = `<div class="dsum">
      <div class="k"><i>最新价</i><b>${fmtPrice(d.price)}</b></div>
      <div class="k"><i>24h成交额</i><b>${fmtVol(d.quoteVolume)}</b></div>
      <div class="k"><i>数据状态</i><b style="font-size:12px">${d.seeded ? '已播种' : '加载中'}</b></div>
      <div class="k"><i>评估时间</i><b style="font-size:12px">${d.evaluatedAt ? hhmmss(d.evaluatedAt) : '—'}</b></div>
      <div class="k" style="cursor:pointer" onclick="closeDetailThenChart('${sym}')"><i>切换到</i><b style="font-size:12px;color:#38bdf8">📈 K线图</b></div>
    </div>`;

  if (d.matches && d.matches.length) {
    for (const m of d.matches) {
      html += `<div class="hint" style="border-color:#fde047;color:#fde047;margin-bottom:10px">🔔 ${m.text}</div>`;
    }
  }
  html += `<table class="lvtable"><thead><tr>
      <th>级别</th><th>K线</th><th>状态</th><th>价格</th><th>MA7</th><th>EMA7</th><th>MA25</th><th>距MA7</th></tr></thead><tbody>`;
  for (const lv of LEVELS) {
    const x = d.levels[lv.key];
    if (!x) continue;
    const st = STATE_NAME[x.state] ?? '—';
    const dist = x.distMa7Pct;
    html += `<tr>
      <td>${x.label}</td>
      <td style="color:#5b6f8c">${x.closed}/${x.candles}</td>
      <td><span class="pillbox s${x.state}">${st}${x.event ? ' ' + EVENT_NAME[x.event] : ''}</span></td>
      <td>${fmtPrice(x.price)}</td>
      <td>${fmtPrice(x.ma7)}</td>
      <td>${fmtPrice(x.ema7)}</td>
      <td style="color:#8ba0bd">${fmtPrice(x.ma25)}</td>
      <td style="color:${dist >= 0 ? '#22c55e' : '#ef4444'}">${dist == null ? '—' : (dist >= 0 ? '+' : '') + dist.toFixed(2) + '%'}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  $('#d-body').innerHTML = html;
  $('#detail').classList.remove('hidden');
}

/* ---------------- 信号绩效 ---------------- */
let perfTimer = null;
function fxPct(x, digits = 2) {
  if (x == null || !isFinite(x)) return '<span style="color:#5b6f8c">—</span>';
  const c = x > 0 ? '#22c55e' : x < 0 ? '#ef4444' : '#8ba0bd';
  return `<span style="color:${c}">${x > 0 ? '+' : ''}${x.toFixed(digits)}%</span>`;
}
function perfRow(h) {
  const n = h?.n ?? 0;
  return `<tr>
    <td>${h?.hours ?? ''} 小时</td>
    <td>${n} / ${h?.total ?? 0}</td>
    <td>${fxPct(h?.avg)}</td>
    <td>${fxPct(h?.med)}</td>
    <td>${n ? h.win.toFixed(1) + '%' : '—'}</td>
    <td>${fxPct(h?.best)}</td>
    <td>${fxPct(h?.worst)}</td>
  </tr>`;
}
function scoreRow(b) {
  return `<tr>
    <td>${b.name}</td>
    <td>${b.n}</td>
    <td>${fxPct(b.h1?.avg)} <span style="color:#5b6f8c;font-size:10.5px">n=${b.h1?.n ?? 0}</span></td>
    <td>${fxPct(b.h4?.avg)} <span style="color:#5b6f8c;font-size:10.5px">n=${b.h4?.n ?? 0}</span></td>
    <td>${b.h4?.n ? b.h4.win.toFixed(0) + '%' : '—'}</td>
    <td>${fxPct(b.h24?.avg)} <span style="color:#5b6f8c;font-size:10.5px">n=${b.h24?.n ?? 0}</span></td>
  </tr>`;
}
async function openPerf() {
  let d;
  try { d = await fetch('/api/performance').then(r => r.json()); }
  catch { toast('获取绩效数据失败', true); return; }
  if (!d) return;
  const resolved = d.horizons?.[1]?.n ?? 0;
  let html = `<div class="dsum">
    <div class="k"><i>累计记录</i><b>${d.total}</b></div>
    <div class="k"><i>参与统计</i><b>${d.tracked}</b></div>
    <div class="k"><i>已确认 / 预警</i><b style="font-size:13px">${d.confirmed} / ${d.preview}</b></div>
    <div class="k"><i>已结算 +4h</i><b>${resolved}</b></div>
  </div>`;

  if (d.legacyExcluded) html += `<div class="hint">保留 ${d.legacyExcluded} 条旧口径记录；因缺少可靠方向信息，不纳入下方多空收益统计。新记录按信号方向计算，未扣除交易成本。</div>`;
  if (!d.total) {
    html += `<div class="hint">还没有信号记录。系统每产生一条报警都会存入 <code>data/signals.jsonl</code>，
      并在 1 / 4 / 24 小时后自动结算实际涨跌幅。运行一段时间后回到这里，就能看到这套逻辑在你本机实际数据上的表现。</div>`;
  } else {
    html += `<div class="hint" style="border-color:#fbbf24;color:#fbbf24">
      ⚠ 这里的数字是<b>你本机实际运行</b>的结果，比任何回测都可信。但注意：
      信号在同一标的的相近时刻高度重叠，有效独立样本远少于条数；短样本下的胜率波动很大，建议至少积累数天后再判断。</div>`;
    html += `<h3 style="font-size:13px;margin:14px 0 6px">按时间窗口</h3>
      <table class="lvtable"><thead><tr>
        <th>持有期</th><th>已结算/总</th><th>平均</th><th>中位</th><th>胜率</th><th>最好</th><th>最差</th>
      </tr></thead><tbody>`;
    for (const h of d.horizons) html += perfRow(h);
    html += `</tbody></table>`;

    html += `<h3 style="font-size:13px;margin:16px 0 6px">仅「已确认」信号（不含未收盘预警）</h3>
      <table class="lvtable"><thead><tr>
        <th>持有期</th><th>已结算/总</th><th>平均</th><th>中位</th><th>胜率</th><th>最好</th><th>最差</th>
      </tr></thead><tbody>`;
    for (const k of ['h1', 'h4', 'h24']) {
      const h = d.confirmedOnly?.[k];
      const hours = k === 'h1' ? 1 : k === 'h4' ? 4 : 24;
      html += perfRow({ ...(h || {}), hours });
    }
    html += `</tbody></table>`;

    html += `<h3 style="font-size:13px;margin:16px 0 6px">按评分分组（验证评分是否真的有区分度）</h3>
      <table class="lvtable"><thead><tr>
        <th>评分</th><th>条数</th><th>+1h 平均</th><th>+4h 平均</th><th>+4h 胜率</th><th>+24h 平均</th>
      </tr></thead><tbody>`;
    for (const b of d.byScore || []) html += scoreRow(b);
    html += `</tbody></table>`;

    html += `<h3 style="font-size:13px;margin:16px 0 6px">最近信号明细</h3>
      <table class="lvtable"><thead><tr>
        <th>时间</th><th>币种</th><th>方向</th><th>组合</th><th>评分</th><th>信号价</th><th>+1h</th><th>+4h</th><th>+24h</th>
      </tr></thead><tbody>`;
    for (const r of d.recent || []) {
      const t = new Date(r.ts);
      const p = n => String(n).padStart(2, '0');
      html += `<tr>
        <td>${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}</td>
        <td>${r.symbol}${r.confirmed ? '' : ' <span style="color:#fbbf24">预</span>'}</td>
        <td>${r.legacy ? '历史方向未知' : r.side === 'short' ? '空' : '多'}</td>
        <td>${escapeHTML(signalChain(r))}</td>
        <td>${signalHasScore(r) && !r.legacy ? r.score : '—'}</td>
        <td>${fmtPrice(r.price)}</td>
        <td>${fxPct(r.legacy ? null : r.out?.h1)}</td>
        <td>${fxPct(r.legacy ? null : r.out?.h4)}</td>
        <td>${fxPct(r.legacy ? null : r.out?.h24)}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }
  $('#p-body').innerHTML = html;
  $('#perf').classList.remove('hidden');
}

/* ---------------- 级别组合编辑器 ---------------- */
let ALL_LEVELS = [];          // 含隐藏级别（1分），仅用于内部换算
const PRESET_GROUPS = [
  { base: '3m', mid: '15m', big: '2h', enabled: true },
  { base: '2m', mid: '10m', big: '1h', enabled: true },
  { base: '5m', mid: '30m', big: '3h', enabled: true },
];

function levelOptions(selected, allowHidden) {
  const src = ALL_LEVELS.length ? ALL_LEVELS : LEVELS;
  return src.filter(l => allowHidden || !l.hidden)
    .map(l => `<option value="${l.key}"${l.key === selected ? ' selected' : ''}>${l.label}</option>`).join('');
}

function renderGroups() {
  const box = $('#grouplist');
  const groups = cfg?.groups ?? [];
  const auto = cfg?.scanMode === 'auto';
  box.innerHTML = '';
  if (auto) {
    box.innerHTML = `<div class="gnote" style="color:#fbbf24">当前为【穷举扫描】模式，下面的固定组合不生效。
      取消勾选下方开关即可切换回固定组合模式。</div>`;
  }
  groups.forEach((g, i) => {
    const row = document.createElement('div');
    row.className = 'grow' + (g.enabled === false ? ' off' : '');
    row.innerHTML = `
      <input type="checkbox" ${g.enabled === false ? '' : 'checked'} data-i="${i}" data-k="enabled" title="启用/停用">
      <select data-i="${i}" data-k="base">${levelOptions(g.base, false)}</select>
      <span class="arrow">→</span>
      <select data-i="${i}" data-k="mid">${levelOptions(g.mid, false)}</select>
      <span class="arrow">→</span>
      <select data-i="${i}" data-k="big">${levelOptions(g.big, false)}</select>
      <button class="del" data-i="${i}" title="删除">✕</button>`;
    box.appendChild(row);
  });
  if (!groups.length) box.innerHTML = `<div class="gnote" style="color:#f87171">没有启用的组合 → 不会产生任何信号。点「＋ 添加组合」或「恢复示例组合」。</div>`;

  box.querySelectorAll('select').forEach(sel => sel.addEventListener('change', () => {
    const i = +sel.dataset.i, k = sel.dataset.k;
    const g = cfg.groups[i];
    g[k] = sel.value;
    validateGroupRow(sel.closest('.grow'), g);
  }));
  box.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
    cfg.groups[+cb.dataset.i].enabled = cb.checked;
    cb.closest('.grow').classList.toggle('off', !cb.checked);
  }));
  box.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
    cfg.groups.splice(+b.dataset.i, 1);
    renderGroups();
  }));
  $('#c-scanModeAuto').checked = auto;
  updateGroupChip();
}

function validateGroupRow(row, g) {
  const idx = k => ALL_LEVELS.findIndex(l => l.key === k);
  const ok = idx(g.base) < idx(g.mid) && idx(g.mid) < idx(g.big);
  let warn = row.querySelector('.bad');
  if (!ok) {
    if (!warn) { warn = document.createElement('span'); warn.className = 'bad'; row.appendChild(warn); }
    warn.textContent = '⚠ 顺序必须是 基准 < 确认 < 最大';
  } else if (warn) warn.remove();
  return ok;
}

function updateGroupChip() {
  const el = $('#f-groups');
  if (!el) return;
  if (cfg?.scanMode === 'auto') { el.textContent = '组合：穷举扫描模式'; return; }
  const on = (cfg?.groups ?? []).filter(g => g.enabled !== false);
  el.textContent = '组合：' + (on.length
    ? on.map(g => `${lvLabel(g.base)}→${lvLabel(g.mid)}→${lvLabel(g.big)}`).join('  |  ')
    : '（无）');
}

async function saveGroups() {
  const idx = k => ALL_LEVELS.findIndex(l => l.key === k);
  const bad = (cfg.groups ?? []).filter(g => !(idx(g.base) < idx(g.mid) && idx(g.mid) < idx(g.big)));
  if (bad.length) { toast('有组合的级别顺序不合法（必须 基准 < 确认 < 最大）', true); return; }
  await postCfg({ groups: cfg.groups, scanMode: $('#c-scanModeAuto').checked ? 'auto' : 'groups' });
  alerts = [];
  renderAlerts();
  toast('级别组合已更新，重新开始扫描');
}

/* ---------------- 钉钉推送配置 ---------------- */
let PUSH_META = {};
let PUSH_CFG = null;

function renderPush() {
  const box = $('#pushlist');
  if (!box) return;
  const chans = PUSH_CFG?.channels ?? [];
  $('#p-enabled').checked = !!PUSH_CFG?.enabled;
  $('#p-minScore').value = PUSH_CFG?.minScore ?? 60;
  $('#p-batch').value = Math.round((PUSH_CFG?.batchWindowMs ?? 20000) / 1000);
  $('#p-maxpm').value = PUSH_CFG?.maxPerMinute ?? 10;
  $('#p-maxitems').value = PUSH_CFG?.maxItemsPerMessage ?? 8;
  $('#p-confirmedOnly').checked = !!PUSH_CFG?.confirmedOnly;

  box.innerHTML = '';
  chans.forEach((c, i) => {
    const meta = PUSH_META[c.type] ?? PUSH_META.dingtalk ?? { label: c.type, fields: [] };
    const el = document.createElement('div');
    el.className = 'pchan';
    el.innerHTML = `
      <div class="top">
        <input type="checkbox" ${c.enabled === false ? '' : 'checked'} data-i="${i}" data-k="enabled" title="启用本通道">
        <select data-i="${i}" data-k="__type">
          ${Object.entries(PUSH_META).map(([k, m]) => `<option value="${k}"${k === c.type ? ' selected' : ''}>${m.label}</option>`).join('')}
        </select>
        <button class="del" data-i="${i}" title="删除">✕</button>
      </div>
      ${meta.fields.map(f => `
        <div class="pfld">
          <span>${f.label}</span>
          <input data-i="${i}" data-k="${f.key}" type="text"
                 placeholder="${f.placeholder ?? ''}"
                 value="${f.secret && c[f.key + 'Masked'] ? c[f.key + 'Masked'] : (c[f.key] ?? '')}">
        </div>`).join('')}`;
    box.appendChild(el);
  });
  if (!chans.length) {
    box.innerHTML = `<div class="gnote">还没有通道。点「＋ 添加通道」→ 选「钉钉群机器人」→ 粘贴 Webhook 里的 access_token。
      若安全设置选了「加签」，再填上 SEC 开头的 secret。</div>`;
  }

  box.querySelectorAll('input[type=text]').forEach(inp => inp.addEventListener('input', () => {
    const i = +inp.dataset.i, k = inp.dataset.k;
    PUSH_CFG.channels[i][k] = inp.value;
    if (inp.value.includes('****')) return;
    delete PUSH_CFG.channels[i][k + 'Masked'];
  }));
  box.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
    PUSH_CFG.channels[+cb.dataset.i].enabled = cb.checked;
  }));
  box.querySelectorAll('select').forEach(sel => sel.addEventListener('change', () => {
    PUSH_CFG.channels[+sel.dataset.i] = { type: sel.value, enabled: true };
    renderPush();
  }));
  box.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => {
    PUSH_CFG.channels.splice(+b.dataset.i, 1);
    renderPush();
  }));
}

function collectPush() {
  const c = PUSH_CFG ?? { channels: [] };
  return {
    enabled: $('#p-enabled').checked,
    minScore: Math.round(+$('#p-minScore').value || 0),
    batchWindowMs: Math.max(0, Math.round(+$('#p-batch').value || 0) * 1000),
    maxPerMinute: Math.max(1, Math.round(+$('#p-maxpm').value || 10)),
    maxItemsPerMessage: Math.max(1, Math.round(+$('#p-maxitems').value || 8)),
    confirmedOnly: $('#p-confirmedOnly').checked,
    channels: c.channels,
  };
}

async function loadPush() {
  try {
    const d = await fetch('/api/push').then(r => r.json());
    PUSH_META = d.channelMeta ?? {};
    PUSH_CFG = d.config ?? { channels: [] };
    renderPush();
    updatePushStats(d.stats);
  } catch { /* 忽略 */ }
}

function updatePushStats(st) {
  const el = $('#push-stats');
  if (!el || !st) return;
  const chans = (st.enabledChannels ?? []).map(c => c.label + (c.signed ? '(已加签)' : '')).join('、') || '无';
  el.innerHTML = `通道：<b>${chans}</b>　|　已发 <b>${st.messages}</b> 条消息 / ${st.sent} 个信号　|　`
    + `失败 ${st.failed}　丢弃 ${st.dropped}　队列 ${st.queueLength}`
    + (st.lastError ? `　|　<span style="color:#f87171">${st.lastError}</span>` : '')
    + (st.lastPreview ? `<br><span style="color:#5b6f8c">最近一条：${st.lastPreview.replace(/\n/g, ' ').slice(0, 120)}…</span>` : '');
}

async function savePush() {
  const body = collectPush();
  const savedCfg = await requestJSON('/api/push', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const cfg = savedCfg;
  PUSH_CFG = cfg;
  renderPush();
  const d = await fetch('/api/push').then(x => x.json());
  updatePushStats(d.stats);
  return cfg;
}

/* ---------------- 配置面板 ---------------- */
const CFG_FIELDS = [
  ['minBullLevels', 'int'], ['pullbackLookback', 'int'], ['pullbackTolerance', 'pct'],
  ['triggerLookback', 'int'], ['adjacentLookback', 'int'], ['bigMa', 'str'],
  ['bigTolerance', 'pct'], ['requireEma7', 'bool'], ['requireAdjacentCross', 'bool'],
  ['requireBaseBull', 'bool'], ['useLiveCandle', 'bool'], ['countRule', 'str'],
  ['baseMinIdx', 'int'], ['baseMaxIdx', 'int'], ['minScore', 'int'],
  ['filterBeichi', 'bool'], ['beichiScope', 'str'], ['beichiMinBars', 'int'],
  ['beichiRatio', 'num'], ['beichiMinProgress', 'num'],
  ['requireStrokeChain', 'bool'], ['chainRequireAboveMa', 'bool'],
  ['pullbackPattern', 'str'], ['pullbackBars', 'int'],
  ['watchEnabled', 'bool'], ['watchBigBars', 'int'], ['watchRequireBear', 'bool'],
  ['dualEnabled', 'bool'], ['dualBars', 'int'], ['dualMinQuoteVolume', 'num'],
  ['signalEnabled', 'bool'],
  ['zeroAlertEnabled', 'bool'],
];
const CFG_DEFAULTS = {
  minBullLevels: 3, pullbackLookback: 6, pullbackTolerance: 0.002, triggerLookback: 2,
  adjacentLookback: 3, requireEma7: true, requireAdjacentCross: true, requireBaseBull: true,
  bigMa: 'ema7', bigTolerance: 0, useLiveCandle: true, countRule: 'align',
  baseMinIdx: 2, baseMaxIdx: 6, minScore: 0,
  filterBeichi: true, beichiScope: 'mid', beichiMinBars: 5, beichiRatio: 1.0, beichiMinProgress: 0.3,
  requireStrokeChain: true, chainRequireAboveMa: false,
  pullbackPattern: 'twoBearHold', pullbackBars: 2,
  watchEnabled: true, watchBigBars: 2, watchRequireBear: true,
  dualEnabled: true, dualBars: 2, dualMinQuoteVolume: 4000000, signalEnabled: false, zeroAlertEnabled: true,
};

let CFG_SNAPSHOT = {};
function fillCfgForm() {
  if (!cfg) return;
  for (const [k, t] of CFG_FIELDS) {
    const el = $('#c-' + k);
    if (!el) continue;
    if (t === 'bool') el.checked = !!cfg[k];
    else if (t === 'pct') el.value = +(cfg[k] * 100).toFixed(3);
    else el.value = cfg[k];
  }
  // 记录服务端的权威状态：保存时只提交用户真正改动过的字段。
  // 否则界面上的陈旧值（例如某个开关在页面载入时是未勾选）会被当成用户意图写回服务端。
  CFG_SNAPSHOT = readCfgForm();
}

/** 读当前表单值 */
function readCfgForm() {
  const v = {};
  for (const [k, t] of CFG_FIELDS) {
    const el = $('#c-' + k);
    if (!el) continue;
    if (t === 'bool') v[k] = el.checked;
    else if (t === 'pct') v[k] = (+el.value || 0) / 100;
    else if (t === 'int') v[k] = Math.round(+el.value);
    else if (t === 'num') v[k] = +el.value || 0;
    else v[k] = el.value;
  }
  return v;
}
async function postCfg(patch) {
  const nextCfg = await requestJSON('/api/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  cfg = nextCfg;
  fillCfgForm();
  return cfg;
}
async function saveCfg() {
  const now = readCfgForm();
  const patch = {};
  for (const k of Object.keys(now)) {
    // 与「服务端权威快照」一致的字段不提交 —— 界面陈旧值不会覆盖服务端
    if (CFG_SNAPSHOT[k] !== undefined && CFG_SNAPSHOT[k] === now[k]) continue;
    patch[k] = now[k];
  }
  if (!Object.keys(patch).length) { toast('没有改动'); return; }
  await postCfg(patch);
  alerts = [];
  renderAlerts();
  Object.assign(CFG_SNAPSHOT, patch);
  $('#cfg-msg').textContent = '✓ 已应用，重新开始扫描形态';
  setTimeout(() => { $('#cfg-msg').textContent = ''; }, 2600);
  toast('信号参数已更新');
}

/* ---------------- 状态轮询 ---------------- */
let MARKET_NAME = '';
let statsPending = false;
async function pollStats() {
  if (statsPending) return;
  statsPending = true;
  try {
    const s = await requestJSON('/api/stats');
    const m = s.market;
    let strategy = $('#pill-strategy');
    if (!strategy) {
      strategy = document.createElement('span'); strategy.id = 'pill-strategy'; strategy.className = 'pill';
      $('#pill-sig').after(strategy);
    }
    const modes = s.engine.cfg ?? {};
    const enabled = [modes.zeroAlertEnabled && '零轴配对', modes.signalEnabled && '共振', modes.watchEnabled && '观察', modes.dualEnabled && '双阴/双阳'].filter(Boolean);
    strategy.textContent = '策略：' + (enabled.join('、') || '全部关闭');
    strategy.className = 'pill ' + (enabled.length ? '' : 'warn');
    if (m.feedMode === 'tick-rest') {
      // 合约模式：没有 K线 WS 分片，实时价走 !bookTicker，K线由 REST 滚动补
      const t = m.tick ?? {};
      const fresh = t.lastPriceAt && (Date.now() - t.lastPriceAt) < 30_000;
      const on = t.state === 'open' && fresh;
      marketHealth = { kind: on ? 'ok' : t.state === 'open' ? 'warn' : 'bad',
        text: `${m.marketName ?? '合约'} · 实时价 ${on ? '在线' : t.state === 'open' ? '无数据' : '重连中'}` };
    } else {
      const shards = m.shards ?? [];
      const open = shards.filter(x => x.state === 'open').length;
      const streams = shards.reduce((n, x) => n + x.streams, 0);
      marketHealth = { kind: open === shards.length && open > 0 ? 'ok' : open ? 'warn' : 'bad',
        text: `行情 WS ${open}/${shards.length} · ${streams}流` };
    }
    renderConnection();
    const age = m.lastKlineAt ? Date.now() - m.lastKlineAt : -1;
    $('#pill-lat').textContent = `更新间隔 ${snapGap ? Math.round(snapGap) : '—'}ms · 行情 ${age < 0 ? '—' : (age / 1000).toFixed(1) + 's'}`;
    const t = m.tick;
    $('#pill-lat').title = `权重 ${m.rest.lastUsedWeight}/${m.weightCap} · 往返 ${m.rest.avgLatency}ms`
      + ` · 播种 ${m.seeding.done}/${m.seeding.total} · 评估耗时 ${s.engine.lastSweepMs}ms`
      + (t ? ` · 价格tick ${t.priceTicks} · 补K线 ${t.rollingTicks} 次` : '');
    const bl = $('#beichi-stats');
    if (bl) {
      const en = s.engine.cfg?.filterBeichi;
      bl.innerHTML = en
        ? `背驰过滤已开启（${s.engine.cfg.beichiScope === 'mid+big' ? '确认+最大级别' : '仅确认级别'}）`
          + ` · 近一分钟拦截 <b>${s.engine.beichiPerMin ?? 0}</b> 次评估`
          + ` · 累计拦截 ${s.engine.beichiBlocked ?? 0} · 已产生信号 ${s.engine.signalCount} 条`
        : `背驰过滤已关闭（当前不拦截任何信号）`;
    }
    const cl = $('#chain-stats');
    if (cl) {
      const en = s.engine.cfg?.requireStrokeChain;
      cl.innerHTML = en
        ? `成笔链已开启${s.engine.cfg.chainRequireAboveMa ? '（含站上MA7）' : ''}`
          + ` · 累计因「回踩不够成笔」拦下 <b>${s.engine.strokeBlocked ?? 0}</b> 次评估`
          + ` · 已产生信号 ${s.engine.signalCount} 条`
        : `成笔链已关闭（当前不检查靠近程度）`;
    }
  } catch { marketHealth = { kind: 'warn', text: '行情状态查询失败' }; renderConnection(); }
  finally { statsPending = false; }
}

/* ---------------- 交互 ---------------- */
function bind() {
  let filterTimer;
  const updateZero = () => {
    // 零轴表格页已移除，筛选相关操作改为刷新结构卡片墙
    if (typeof loadPair === 'function') loadPair();
  };
  $('#q').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer=setTimeout(updateZero, 200); });
  // 零轴视图的筛选（纯前端重算，不发请求）
  ['#f-side', '#f-near'].forEach(s => {
    const el = $(s);
    if (el) el.addEventListener('change', updateZero);
  });
  // 旧的共振筛选已随矩阵视图移除，这里保留空引用保护
  ['#f-bull', '#f-score'].forEach(s => {
    const el = $(s);
    if (el) el.addEventListener('change', () => { lastOrderKey = null; render(); });
  });

  if ($('#f-bigma')) $('#f-bigma').addEventListener('change', e => {
    const input = e.currentTarget, previous = cfg?.bigMa;
    runAction(input, async () => {
      try {
        const c = await postCfg({ bigMa: input.value });
        toast('最大级别判定均线：' + (c.bigMa === 'ema7' ? 'EMA7' : 'MA7'));
      } catch (error) { input.value = previous; throw error; }
    });
  });
  // 单K回踩不破：默认平铺 K 线墙，可切表格
const tabSingle = $('#tab-single');
if (tabSingle) tabSingle.addEventListener('click', () => {
  if (typeof setView === 'function') setView('single');
  applySingleMode();
});
['#tab-zero', '#tab-pgrid'].forEach(s => { const el = $(s); if (el) el.addEventListener('click', stopSinglePoll); });const singleModeSel = $('#single-mode');
if (singleModeSel) singleModeSel.addEventListener('change', applySingleMode);
const singleLimitSel = $('#single-limit');
if (singleLimitSel) singleLimitSel.addEventListener('change', () => { if (singleModeNow() === 'chart') refreshActive(); });
const singleZeroSel = $('#single-zero');
if (singleZeroSel) singleZeroSel.addEventListener('change', () => {
  if (singleModeNow() === 'table') loadSingleK(); else refreshActive();
});
const singleSizeSel = $('#single-size');
if (singleSizeSel) singleSizeSel.addEventListener('change', () => {
  // 只改布局：立刻按新列数重排，不必等下一次请求
  if (singleModeNow() === 'chart' && typeof applyCols === 'function' && typeof VIEWS !== 'undefined') {
    applyCols(VIEWS.single);
  }
});
const singleRefreshBtn = $('#single-refresh');
if (singleRefreshBtn) singleRefreshBtn.addEventListener('click', () => {
  // 刷新 = 把已固定的排到最前
  if (typeof setPinFirstMode === 'function') setPinFirstMode(true);
  if (singleModeNow() === 'table') loadSingleK(); else refreshActive();
});

$('#f-groups').addEventListener('click', () => { fillCfgForm(); renderGroups(); $('#cfgpanel').classList.remove('hidden'); });
  $('#btn-addgroup').addEventListener('click', () => {
    if (!cfg?.groups) cfg = { ...(cfg || {}), groups: [] };
    cfg.groups.push({ base: '3m', mid: '15m', big: '2h', enabled: true });
    renderGroups();
  });
  $('#btn-preset').addEventListener('click', e => runAction(e.currentTarget, async () => {
    await postCfg({ groups: PRESET_GROUPS.map(g => ({ ...g })), scanMode: 'groups' });
    renderGroups();
    toast('已恢复示例组合：3分→15分→2时 / 2分→10分→1时 / 5分→30分→3时');
  }));
  $('#t-live').addEventListener('change', e => {
    const input = e.currentTarget, previous = !!cfg?.useLiveCandle;
    runAction(input, async () => { try { await postCfg({ useLiveCandle: input.checked }); }
      catch (error) { input.checked = previous; throw error; } });
  });

  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'sym' ? 1 : -1; }
      document.querySelectorAll('th.sortable').forEach(x => x.classList.remove('asc', 'desc'));
      th.classList.add(sortDir > 0 ? 'asc' : 'desc');
      lastOrderKey = null; render();
    });
  });

  const CHIPS = [['sig', '仅看信号'], ['conf', '仅已确认'], ['up', '仅上涨'], ['seed', '仅数据完整']];
  const box = $('#chips');
  for (const [k, label] of CHIPS) {
    const el = document.createElement('span');
    el.className = 'chip'; el.textContent = label;
    el.addEventListener('click', () => {
      if (activeChips.has(k)) activeChips.delete(k); else activeChips.add(k);
      el.classList.toggle('on', activeChips.has(k));
      updateZero();
    });
    box.appendChild(el);
  }

  $('#btn-sound').addEventListener('click', e => {
    soundOn = !soundOn;
    localStorage.setItem('sound', soundOn ? '1' : '0');
    e.currentTarget.classList.toggle('on', soundOn);
    if (soundOn) { ensureAudio(); beep('confirmed'); }
  });
  $('#btn-notify').addEventListener('click', async e => {
    if (!('Notification' in window)) { toast('当前浏览器不支持桌面通知', true); return; }
    if (!notifyOn) {
      const p = await Notification.requestPermission();
      if (p !== 'granted') { toast('通知权限被拒绝', true); return; }
      notifyOn = true;
    } else notifyOn = false;
    localStorage.setItem('notify', notifyOn ? '1' : '0');
    e.currentTarget.classList.toggle('on', notifyOn);
  });
  $('#btn-cfg').addEventListener('click', () => { fillCfgForm(); renderGroups(); renderPush(); $('#cfgpanel').classList.remove('hidden'); });
  $('#btn-perf').addEventListener('click', () => {
    openPerf();
    clearInterval(perfTimer);
    perfTimer = setInterval(() => {
      if ($('#perf').classList.contains('hidden')) { clearInterval(perfTimer); return; }
      openPerf();
    }, 30_000);
  });
  $('#btn-clear').addEventListener('click', () => { alerts = []; renderAlerts(); });
  $('#btn-resync').addEventListener('click', e => runAction(e.currentTarget, async () => {
    await requestJSON('/api/resync');
    toast('已触发全量对账，稍后自动修复K线缺口');
  }));
  $('#btn-addpush').addEventListener('click', () => {
    if (!PUSH_CFG) PUSH_CFG = { channels: [] };
    if (!PUSH_CFG.channels) PUSH_CFG.channels = [];
    PUSH_CFG.channels.push({ type: 'dingtalk', enabled: true, accessToken: '', secret: '', keyword: '' });
    renderPush();
  });
  $('#btn-pushtest').addEventListener('click', async () => {
    const el = $('#push-msg');
    el.style.color = '#fbbf24';
    el.textContent = '正在保存并发送…';
    try {
      await savePush();
      const r = await fetch('/api/push/test', { method: 'POST' }).then(x => x.json());
      if (r.ok) { el.style.color = '#22c55e'; el.textContent = '✓ 测试消息已发送，请查看钉钉群'; }
      else {
        el.style.color = '#f87171';
        el.textContent = '✗ ' + (r.error || (r.results ?? []).map(x => `${x.label}: ${x.error}`).join(' ; '));
      }
    } catch (e) { el.style.color = '#f87171'; el.textContent = '✗ ' + e.message; }
    setTimeout(() => { el.textContent = ''; }, 12000);
  });

  $('#btn-cfgsave').addEventListener('click', e => runAction(e.currentTarget, async () => {
    const groups = structuredClone(cfg?.groups ?? []);
    const index = key => ALL_LEVELS.findIndex(l => l.key === key);
    if (groups.some(g => index(g.base) < 0 || !(index(g.base) < index(g.mid) && index(g.mid) < index(g.big)))) {
      throw new Error('组合顺序必须为 基准 < 确认 < 最大');
    }
    const pushBody = collectPush();
    const patch = readCfgForm();
    for (const key of Object.keys(patch)) if (CFG_SNAPSHOT[key] === patch[key]) delete patch[key];
    patch.groups = groups;
    patch.scanMode = $('#c-scanModeAuto').checked ? 'auto' : 'groups';
    await postCfg(patch);
    alerts = [];
    renderAlerts();
    // The two endpoints are independent: report a partial save explicitly.
    try {
      PUSH_CFG = await requestJSON('/api/push', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pushBody),
      });
      renderPush();
    } catch (error) { throw new Error('信号参数已保存，但推送配置保存失败：' + error.message); }
    renderGroups();
    updateGroupChip();
    toast('参数、组合与推送配置已保存');
  }));
  $('#btn-cfgreset').addEventListener('click', e => runAction(e.currentTarget, async () => {
    await postCfg({ ...CFG_DEFAULTS, groups: PRESET_GROUPS.map(g => ({ ...g })), scanMode: 'groups' });
    renderGroups();
    toast('已恢复默认参数与示例组合');
  }));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', e => {
    e.target.closest('.drawer').classList.add('hidden');
  }));
  document.addEventListener('keydown', e => {
    const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || document.activeElement?.tagName || '') || e.target?.isContentEditable;
    if (e.key === '/' && !editing) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape') {
      document.querySelectorAll('.drawer').forEach(d => d.classList.add('hidden'));
      $('#q').blur();
    }
  });
}

/* ---------------- 启动 ---------------- */
bind();
$('#btn-sound').classList.toggle('on', soundOn);
$('#btn-notify').classList.toggle('on', notifyOn);
connect();
loadPush();
setInterval(pollStats, 3000);
pollStats();
// 零轴表格页已被「配对监控表」取代（刷新由 pair.js 负责），这里不再轮询 /api/zeroaxis，
// 否则 renderZero 会去写已经被移除的 #grid / #empty 并抛错。
// 推送状态与报警卡片的"信号后"涨跌幅一起刷新
setInterval(() => { if (alerts.length) renderAlerts(); }, 5000);
setInterval(async () => {
  if ($('#cfgpanel').classList.contains('hidden')) return;
  try { const d = await fetch('/api/push').then(r => r.json()); updatePushStats(d.stats); } catch { /* 忽略 */ }
}, 5000);
setInterval(() => {
  renderConnection();
  if ($('#zero-mode')?.value==='table' && ZERO) renderZero();
}, 4000);
