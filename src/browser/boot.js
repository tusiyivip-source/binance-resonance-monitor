/**
 * 纯前端版引导层 —— 让整套盯盘系统在**没有后端**的情况下跑起来。
 *
 * 思路：核心逻辑（config / rest / market / tickfeed / series / indicators / chan / signals / engine）
 * 本来就与运行环境无关；这里只做三件事：
 *   1. 实例化 Market + Engine，接好「K线收盘 → 立即重估」与「告警 → 推送」
 *   2. 把 window.fetch 里所有 /api/* 请求**就地路由**到内存中的 engine/market
 *   3. 用本地 SSE 替身驱动 /api/stream（前端代码一行都不用改）
 *
 * 于是 public/app.js 与 public/chart.js **原封不动**即可工作。
 *
 * 已知限制（页面顶部会提示）：
 *   · 钉钉推送不可用（需要后端保管密钥，且浏览器跨域发不出去）
 *   · 每个访客用自己的 IP 拉币安数据，各自受 2400 权重/分钟约束
 */
import { APP, LEVELS, VISIBLE_LEVELS, DEFAULT_SIGNAL } from '../config.js';
import { TokenBucket, RestClient } from '../rest.js';
import { Market } from '../market.js';
import { Engine } from '../engine.js';
import { Tracker } from '../tracker.js';
import { CHANNEL_META, DEFAULT_PUSH, emptyPushStats } from '../push-meta.js';
import { createLogger } from '../logger.js';

/* ---------------- 可调项（URL 参数） ---------------- */
const Q = new URLSearchParams(location.search);
if (Q.has('top')) APP.topN = Math.max(10, Math.min(400, Number(Q.get('top')) || APP.topN));
const log = createLogger('web');
log.info(`浏览器版启动：市场 ${APP.profile.name}，标的 ${APP.topN} 个，级别 ${LEVELS.length} 个`);

/* ---------------- 存储适配器：绩效库落 localStorage ---------------- */
function localStorageAdapter(key) {
  return {
    load: () => { try { return localStorage.getItem(key); } catch { return null; } },
    append: line => {
      try {
        const cur = localStorage.getItem(key) ?? '';
        // 只保留最近 N 行，避免把 localStorage 撑爆
        const merged = (cur + line).split('\n').filter(Boolean).slice(-1500).join('\n') + '\n';
        localStorage.setItem(key, merged);
      } catch { /* 配额满就静默放弃持久化，内存里仍然有 */ }
    },
    rewrite: text => {
      try { localStorage.setItem(key, text.split('\n').filter(Boolean).slice(-1500).join('\n') + '\n'); } catch { }
    },
  };
}

/* ---------------- 实例 ---------------- */
const bucket = new TokenBucket(APP.weightPerMinute, APP.weightBurst);
const rest = new RestClient(bucket);
const market = new Market(rest, createLogger('market'));
const engine = new Engine(market, createLogger('engine'));
const tracker = new Tracker('web-signals', createLogger('tracker'), localStorageAdapter('dsh.web.signals'));

// 钉钉推送在纯前端版不可用，用一个空实现占位，保证前端面板能正常渲染
const pushStub = {
  publicConfig: () => ({ ...DEFAULT_PUSH, channels: [] }),
  setConfig: patch => ({ ...DEFAULT_PUSH, ...patch, channels: [] }),
  statsOut: emptyPushStats(),
  push: () => { },
  sendTest: async () => ({ ok: false, error: '在线版不支持钉钉推送：需要后端保管密钥，且浏览器无法跨域调用钉钉 Webhook' }),
};

/* ---------------- 事件接线（与 server.js 一致） ---------------- */
market.onCandleClose = st => {
  try { engine.evaluateOne(st, true); } catch { /* 单次评估失败不影响行情 */ }
};

const sseClients = new Set();
engine.on('alert', alert => {
  try { tracker.record(alert); } catch { }
  for (const c of sseClients) c._emit('alert', alert);
});

let broadcastTimer = null;
function startBroadcast() {
  broadcastTimer = setInterval(() => {
    if (!sseClients.size) return;
    let snap;
    try { snap = engine.snapshot(); } catch { return; }
    for (const c of sseClients) c._emit('snapshot', snap);
  }, APP.broadcastMs);
}

/* ---------------- SSE 替身 ---------------- */
class MsgEvent extends Event {
  constructor(type, data) { super(type); this.data = JSON.stringify(data); }
}
class LocalEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    sseClients.add(this);
    // 异步发首屏，模拟真实 SSE 的握手顺序
    setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.dispatchEvent(new MsgEvent('open', {}));
      this._emit('hello', helloPayload());
      this._emit('snapshot', safe(() => engine.snapshot(), {}));
      this._emit('alerts', engine.alerts.slice(-100).reverse());
    }, 0);
  }
  _emit(type, data) { try { this.dispatchEvent(new MsgEvent(type, data)); } catch { } }
  close() { this.readyState = 2; sseClients.delete(this); }
}

function helloPayload() {
  return {
    serverTime: Date.now(),
    levels: VISIBLE_LEVELS,
    allLevels: LEVELS,
    cfg: engine.cfg,
    app: {
      port: location.port || 443,
      topN: APP.topN,
      market: APP.market,
      marketName: APP.profile.name,
      feed: APP.feed,
      webMode: true,
    },
  };
}

const safe = (fn, fallback) => { try { return fn(); } catch (e) { log.warn('内部调用失败：' + e.message); return fallback; } };

/* ---------------- /api/* 就地路由（镜像 server.js 的契约） ---------------- */
function sanitizeConfig(patch) {
  const allowed = Object.keys(DEFAULT_SIGNAL);
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.includes(k)) continue;
    if (k === 'groups') {
      // 只接受结构合法的组合：基准 < 确认 < 最大，且不能使用隐藏的数据源级别
      const idx = key => LEVELS.findIndex(l => l.key === key && !l.hidden);
      clean.groups = (Array.isArray(v) ? v : []).slice(0, 40).map(g => ({
        base: String(g?.base ?? ''), mid: String(g?.mid ?? ''), big: String(g?.big ?? ''),
        enabled: g?.enabled !== false,
      })).filter(g => {
        const b = idx(g.base), m = idx(g.mid), k = idx(g.big);
        return b >= 0 && m >= 0 && k >= 0 && b < m && m < k;
      });
      continue;
    }
    clean[k] = v;
  }
  return clean;
}

function routeApi(pathname, search) {
  const q = search;
  switch (pathname) {
    case '/api/snapshot': return { body: safe(() => engine.snapshot(), {}) };
    case '/api/stats': {
      return {
        body: {
          market: safe(() => market.stats, {}),
          engine: safe(() => engine.stats(), {}),
          push: pushStub.statsOut,
          clients: sseClients.size,
          webMode: true,
        },
      };
    }
    case '/api/alerts': return { body: engine.alerts.slice(-200).reverse() };
    case '/api/push': return {
      body: {
        config: pushStub.publicConfig(),
        defaults: DEFAULT_PUSH,
        channelMeta: CHANNEL_META,
        stats: pushStub.statsOut,
        webMode: true,
        note: '纯前端版不支持钉钉推送',
      },
    };
    case '/api/push/test': return { body: { ok: false, error: '在线版不支持钉钉推送（需要后端保管密钥）' }, status: 200 };
    case '/api/performance': {
      try { tracker.resolve(market, true); } catch { /* 结算失败不影响读取 */ }
      return { body: safe(() => tracker.stats(), {}) };
    }
    case '/api/detail': {
      const sym = (q.get('symbol') || '').toUpperCase();
      const d = engine.detail(sym);
      return d ? { body: d } : { body: { error: 'not found' }, status: 404 };
    }
    case '/api/chart': {
      const sym = (q.get('symbol') || '').toUpperCase();
      const bars = Math.max(40, Math.min(400, Number(q.get('bars')) || 150));
      const d = engine.chart(sym, bars);
      return d ? { body: d } : { body: { error: 'not found' }, status: 404 };
    }
    case '/api/alertchart': {
      const bars = Math.max(40, Math.min(400, Number(q.get('bars')) || 150));
      const limit = Math.max(1, Math.min(60, Number(q.get('limit')) || 24));
      return { body: safe(() => engine.alertCharts(bars, limit), { items: [], total: 0, shown: 0 }) };
    }
    case '/api/config': return { body: engine.cfg };
    case '/api/resync': {
      market.resyncAll().catch(e => log.warn('对账失败：' + e.message));
      return { body: { ok: true } };
    }
    case '/api/debug/drop-ws': {
      if (q.get('confirm') !== 'yes') return { body: { error: 'confirm=yes required' }, status: 400 };
      let n = 0;
      for (const sh of market.shards ?? []) { if (sh.ws) { try { sh.ws.close(4000, 'manual test drop'); n++; } catch { } } }
      if (market.tickFeed?.ws) { try { market.tickFeed.ws.close(4000, 'manual test drop'); n++; } catch { } }
      return { body: { ok: true, dropped: n, mode: market.feedMode } };
    }
    default: return null;
  }
}

/* ---------------- 补丁：fetch ---------------- */
const nativeFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  let url;
  try { url = new URL(typeof input === 'string' ? input : input.url, location.href); }
  catch { return nativeFetch(input, init); }

  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    // POST 的 body 交给对应路由处理
    if (url.pathname === '/api/config' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      let patch = {};
      try { patch = JSON.parse(init.body || '{}'); } catch { return jsonRes({ error: 'bad json' }, 400); }
      const next = safe(() => engine.setConfig(sanitizeConfig(patch)), { error: 'setConfig failed' });
      return jsonRes(next);
    }
    if (url.pathname === '/api/push' && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      let patch = {};
      try { patch = JSON.parse(init.body || '{}'); } catch { }
      pushStub.setConfig(patch);
      return jsonRes(pushStub.publicConfig());
    }
    const r = routeApi(url.pathname, url.searchParams);
    if (r) return jsonRes(r.body, r.status ?? 200);
  }
  return nativeFetch(input, init);
};
function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* ---------------- 补丁：EventSource ---------------- */
window.EventSource = LocalEventSource;

/* ---------------- 启动 ---------------- */
(async () => {
  startBroadcast();
  try {
    await market.init();
  } catch (e) {
    log.error('初始化失败：' + (e.stack || e.message));
  }
  engine.start();
  log.ok(`引擎已启动，评估 ${market.symbols.size} 个标的 × ${LEVELS.length} 个级别`);

  setInterval(() => market.refreshUniverse().catch(e => log.warn(e.message)), APP.tickerRefreshMs);
  setInterval(() => market.refreshExchangeInfo().catch(() => { }), APP.exchangeInfoRefreshMs);
  setInterval(() => { if (market.feedMode === 'tick-rest') return; market.resyncAll().catch(e => log.warn(e.message)); }, APP.resyncMs);
  setInterval(() => { try { tracker.resolve(market); } catch { } }, 30_000);

  // tick-rest 模式下 K线合并式累积，依赖 REST 滚动修正
  document.dispatchEvent(new CustomEvent('dsh-web-ready'));
})();

// 供调试与自动化测试使用
window.__DSH_WEB__ = { APP, market, engine, tracker, bucket, rest, routeApi, helloPayload };
