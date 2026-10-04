/**
 * 币安多级别共振盯盘系统 —— 服务入口
 *   启动： node server.js        （默认 http://127.0.0.1:8848）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP, LEVELS, VISIBLE_LEVELS, DEFAULT_SIGNAL } from './src/config.js';import { TokenBucket, RestClient } from './src/rest.js';
import { Market } from './src/market.js';
import { Engine } from './src/engine.js';
import { Tracker } from './src/tracker.js';
import { fileStorage } from './src/file-storage.js';
import { Pusher, CHANNEL_META, DEFAULT_PUSH } from './src/push.js';
import { createLogger } from './src/logger.js';
import { readCache, writeCache } from './src/kline-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const log = createLogger('main');

const bucket = new TokenBucket(APP.weightPerMinute, APP.weightBurst);
const rest = new RestClient(bucket);
const market = new Market(rest, createLogger('market'));
const engine = new Engine(market, createLogger('engine'));
const tracker = new Tracker(path.join(__dirname, 'data', 'signals.jsonl'), createLogger('tracker'),
  fileStorage(path.join(__dirname, 'data', 'signals.jsonl')));
const pusher = new Pusher(path.join(__dirname, 'data', 'push.json'), createLogger('push'));

// K线一收盘就立刻重估该标的（tick-rest 模式下这是低延迟的关键）
market.onCandleClose = st => {
  try { engine.evaluateOne(st, true); } catch { /* 单次评估失败不影响行情 */ }
};

// ---------------- SSE ----------------
const clients = new Set();

function sseSend(res, type, data) {
  try {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* 客户端已断开 */ }
}

engine.on('alert', alert => {
  tracker.record(alert);
  pusher.push(alert);                 // 钉钉推送（内部做聚合与限流，非阻塞）
  for (const c of clients) sseSend(c, 'alert', alert);
});

let broadcastTimer = null;
function startBroadcast() {
  broadcastTimer = setInterval(() => {
    if (!clients.size) return;
    const snap = engine.snapshot();
    for (const c of clients) sseSend(c, 'snapshot', snap);
  }, APP.broadcastMs);
}
startBroadcast();

// ---------------- 静态资源 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// ---------------- HTTP ----------------
const server = http.createServer((req, res) => {
  // 所有路由异常都必须兜住：handler 是 async 的，一旦 reject 就没人应答，
  // 客户端会一直挂到超时（曾因 engine 里少导入一个符号导致接口永久挂死）。
  handleRequest(req, res).catch(e => {
    log.error(`请求处理失败 ${req.method} ${req.url}：${e.stack || e.message}`);
    try {
      if (!res.headersSent) json(res, { error: e.message }, 500);
      else res.end();
    } catch { try { res.destroy(); } catch { } }
  });
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    sseSend(res, 'snapshot', engine.snapshot());
    sseSend(res, 'alerts', engine.alerts.slice(-100).reverse());
    sseSend(res, 'hello', {
      serverTime: Date.now(), levels: VISIBLE_LEVELS, allLevels: LEVELS, cfg: engine.cfg,
      app: { port: APP.port, topN: APP.topN, market: APP.market, marketName: APP.profile.name, feed: APP.feed },
    });
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20_000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }

  if (url.pathname === '/api/snapshot') return json(res, engine.snapshot());
  if (url.pathname === '/api/push') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try { json(res, pusher.setConfig(JSON.parse(body || '{}'))); }
        catch (e) { json(res, { error: e.message }, 400); }
      });
      return;
    }
    return json(res, {
      config: pusher.publicConfig(),
      defaults: DEFAULT_PUSH,
      channelMeta: CHANNEL_META,
      stats: pusher.statsOut,
    });
  }
  if (url.pathname === '/api/push/test' && req.method === 'POST') {
    pusher.sendTest()
      .then(r => json(res, r))
      .catch(e => json(res, { ok: false, error: e.message }, 500));
    return;
  }
  if (url.pathname === '/api/stats') return json(res, { market: market.stats, engine: engine.stats(), push: pusher.statsOut, clients: clients.size });
  if (url.pathname === '/api/alerts') return json(res, engine.alerts.slice(-200).reverse());
  if (url.pathname === '/api/performance') {
    try { tracker.resolve(market, true); } catch { /* 结算失败不影响读取 */ }
    return json(res, tracker.stats());
  }
  if (url.pathname === '/api/detail') {
    const sym = (url.searchParams.get('symbol') || '').toUpperCase();
    const d = engine.detail(sym);
    return d ? json(res, d) : json(res, { error: 'not found' }, 404);
  }
  if (url.pathname === '/api/chart') {
    const sym = (url.searchParams.get('symbol') || '').toUpperCase();
    const bars = Math.max(40, Math.min(400, Number(url.searchParams.get('bars')) || 150));
    const d = engine.chart(sym, bars);
    return d ? json(res, d) : json(res, { error: 'not found' }, 404);
  }
  if (url.pathname === '/api/watch') {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 60));
    return json(res, engine.watchSnapshot(limit));
  }
  if (url.pathname === '/api/alertchart') {
    const bars = Math.max(40, Math.min(400, Number(url.searchParams.get('bars')) || 150));
    const limit = Math.max(1, Math.min(60, Number(url.searchParams.get('limit')) || 24));
    return json(res, engine.alertCharts(bars, limit));
  }
  if (url.pathname === '/api/config') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const patch = JSON.parse(body || '{}');
          const allowed = Object.keys(DEFAULT_SIGNAL);
          const clean = {};
          for (const [k, v] of Object.entries(patch)) {
            if (!allowed.includes(k)) continue;
            if (k === 'groups') {
              // 只接受结构合法的级别组合：必须是 基准 < 确认 < 最大，且不能使用隐藏的数据源级别
              const idx = k2 => LEVELS.findIndex(l => l.key === k2 && !l.hidden);
              clean.groups = (Array.isArray(v) ? v : []).slice(0, 40).map(g => ({
                base: String(g?.base ?? ''), mid: String(g?.mid ?? ''), big: String(g?.big ?? ''),
                enabled: g?.enabled !== false,
              })).filter(g => {
                const b = idx(g.base), m = idx(g.mid), kk = idx(g.big);
                return b >= 0 && m >= 0 && kk >= 0 && b < m && m < kk;
              });
              continue;
            }
            clean[k] = v;
          }
          json(res, engine.setConfig(clean));
        } catch (e) { json(res, { error: e.message }, 400); }
      });
      return;
    }
    return json(res, engine.cfg);
  }
  if (url.pathname === '/api/resync') {
    market.resyncAll().catch(e => log.error(e.message));
    return json(res, { ok: true });
  }
  // 可靠性验证钩子：强制断开全部行情连接，观察自动重连与订阅恢复
  if (url.pathname === '/api/debug/drop-ws' && url.searchParams.get('confirm') === 'yes') {
    let n = 0;
    for (const sh of market.shards) {
      if (!sh.ws) continue;
      try { sh.ws.close(4000, 'manual test drop'); n++; } catch { /* 已断开 */ }
    }
    if (market.tickFeed?.ws) {
      try { market.tickFeed.ws.close(4000, 'manual test drop'); n++; } catch { /* 已断开 */ }
    }
    log.warn(`[测试钩子] 已强制断开 ${n} 条行情连接（模式 ${market.feedMode}）`);
    return json(res, { ok: true, dropped: n, mode: market.feedMode });
  }

  serveStatic(req, res, url.pathname);
}

// ---------------- 启动 ----------------
async function main() {
  log.info('════════════════════════════════════════════');
  log.info('  币安多级别共振盯盘系统 v1.1');
  log.info(`  市场：${APP.profile.name}    权重上限：${APP.profile.officialWeightCap}/分钟`);
  log.info(`  级别：${LEVELS.map(l => l.key).join(' / ')}`);
  log.info('════════════════════════════════════════════');

  server.listen(APP.port, APP.host, () => {
    log.ok(`面板已就绪 → http://${APP.host}:${APP.port}`);
  });

  // K线缓存的文件读写留在 Node 侧（market.js 是两端共用的，不能碰 node:fs）。
  // 清单拉回来之后才能读缓存 —— 缓存是往 market.symbols 里填K线的。
  const cacheFile = APP.cacheFile || 'data/klines-cache.json';
  market.onCacheReady = () => {
    const raw = readCache(cacheFile, log);
    if (raw) market.applyCache(raw);
  };
  const saveCacheNow = () => {
    const r = writeCache(cacheFile, market.collectCache(), log);
    if (r) log.info(`K线缓存已写入：${r.symbols} 个标的 / ${(r.bytes / 1048576).toFixed(1)} MB`);
    return r;
  };

  // 被限流时的等待要有可见输出，否则启动阶段静默挂住，日志停在「面板已就绪」像死了一样
  rest.onBanWait = secs => log.warn(`被币安限流（418），等待 ${secs} 秒后重试 —— 这是正常退避，服务没有卡死`);
  // 地域封锁与频率无关：换域名没用，只能换网络出口。必须明确告知，别让人误以为是网络抖动
  rest.onGeoBlock = (status, host) => log.error(
    `币安返回 HTTP ${status}（地域限制：${host}）—— 这是按 IP/地区封锁，与请求频率无关。\n` +
    '  · 合约只有 fapi.binance.com 一个域名，切换域名无效\n' +
    '  · 唯一解决办法是更换网络出口（挂代理 / 换网络 / 换 IP）\n' +
    '  · WebSocket（bookTicker）通常不受影响，所以会出现「价格在动但拉不到K线」的现象\n' +
    '  · 在线版不受此影响：https://tusiyivip-source.github.io/binance-resonance-monitor/',
  );

  try {
    await market.init();          // 只做不依赖网络的部分：起行情流 + 读磁盘缓存
  } catch (e) {
    log.error('初始化失败：' + (e.stack || e.message));
  }
  engine.start();
  log.ok(`引擎已启动，评估 ${market.symbols.size} 个标的 × ${LEVELS.length} 个级别`);

  // 拉清单/播种放到后台：限流时可能被退避拖住几分钟，
  // 绝不能让它阻塞引擎启动和下面的定时器注册（否则服务看起来就是死了）。
  market.bootstrap()
    .then(() => log.ok(`初始清单就绪，播种 ${market.symbols.size} 个标的`))
    .catch(e => log.warn('初始清单获取失败（60 秒后自动重试）：' + e.message));

  setInterval(() => market.refreshUniverse().catch(e => log.warn(e.message)), APP.tickerRefreshMs);
  setInterval(() => market.refreshExchangeInfo().catch(() => {}), APP.exchangeInfoRefreshMs);
  // tick-rest 模式由滚动补K线负责纠偏，不需要再叠加全量对账（权重预算吃不消）
  setInterval(() => {
    if (market.feedMode === 'tick-rest') return;
    market.resyncAll().catch(e => log.warn(e.message));
  }, APP.resyncMs);
  setInterval(() => { try { tracker.resolve(market); } catch (e) { log.warn('绩效结算失败：' + e.message); } }, 30_000);

  // 定期把K线写盘：重启时可直接恢复、跳过全量重播。
  // 否则每次重启都重发 200×12 = 2400 个请求（4800 权重），必撞 418，
  // 而 418 期间播种又必然失败 —— 服务会卡在「有标的名、无K线」出不来。
  setInterval(() => { try { saveCacheNow(); } catch (e) { log.warn('缓存写入失败：' + e.message); } }, APP.cacheSaveMs);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { saveCacheNow(); } catch { /* 退出时尽力而为 */ } process.exit(0); });
  }

  setInterval(() => {
    const s = market.stats;
    const p = tracker.stats();
    const feed = s.feedMode === 'tick-rest'
      ? `bookTicker ${s.tick?.bookMsgs ?? 0}条/${s.tick?.state ?? '-'} · 价格tick ${s.tick?.priceTicks ?? 0}`
      : `WS ${s.shards.map(x => `${x.streams}流/${x.state}`).join(' ')} · K线消息 ${s.klineMessages}`;
    log.info(
      `状态 | ${s.marketName} | 标的 ${s.symbols} | ${feed}` +
      ` | 权重 ${s.rest.lastUsedWeight}/${s.weightCap}` +
      ` | 评估 ${engine.stats().evaluations} | 信号 ${engine.signalCount}` +
      ` | 绩效库 ${p.tracked} 条`,
    );
  }, 60_000);
}

process.on('unhandledRejection', e => log.error('未处理的 Promise 拒绝：' + (e?.stack || e)));
process.on('uncaughtException', e => log.error('未捕获异常：' + (e?.stack || e)));
process.on('SIGINT', () => { log.warn('收到 SIGINT，退出'); process.exit(0); });

main();
