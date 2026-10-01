/**
 * 行情中枢：
 *  - 每 60s 拉取 /api/v3/ticker/24hr（权重80）重建「涨幅榜前200」
 *  - 3 条 WebSocket 连接共 2200 条 kline 流（币安单连接上限 1024 条）
 *  - REST 仅用于首次播种 / 定期对账，权重可忽略
 */
import { APP, LEVELS, LEVEL_INDEX, NATIVE_LEVELS, EXCLUDE_BASE, EXCLUDE_SYMBOL_RE } from './config.js';
import { CandleSeries, parseKline, parseWsKline } from './series.js';
import { TickFeed } from './tickfeed.js';

/** WebSocket 分片：每条连接不超过币安上限（1024 条流） */
const SHARD_GROUPS = [
  ['1m', '3m', '5m', '15m'],    // 200 * 4 = 800
  ['30m', '1h', '2h', '4h'],    // 200 * 4 = 800
  ['6h', '12h', '1d', '1w'],    // 200 * 4 = 800
];

export class Market {
  constructor(rest, log) {
    this.rest = rest;
    this.log = log;
    this.symbols = new Map();      // symbol -> state
    this.universe = [];            // 排序后的 symbol 列表（按24h涨幅降序）
    this.revision = 0;
    this.startedAt = Date.now();
    this.lastTickerAt = 0;
    this.lastKlineAt = 0;
    this.klineMessages = 0;
    this.wsState = 'idle';
    this.seeding = { done: 0, total: 0, active: false };
    this.tradingSymbols = new Set();
    this.lastExchangeInfoAt = 0;
    this.feedMode = null;          // 'kline-ws' | 'tick-rest'
    this.tickFeed = null;
    this.shards = SHARD_GROUPS.map((levels, i) => new WsShard(this, `shard${i + 1}`, levels));
    /** 由 server.js 注入：某币种有K线收盘时立刻重估 */
    this.onCandleClose = null;
  }

  // ---------- 初始化 ----------

  async init() {
    await this.refreshExchangeInfo();
    await this.refreshUniverse({ seed: false });
    this.startFeed();
    // 播种在后台渐进执行（受权重预算约束），不阻塞引擎启动
    this.seedAll().catch(e => this.log.error('播种失败：' + e.message));
  }

  /** 选择行情源：kline-ws / tick-rest / auto（先试 WS，无数据则降级） */
  startFeed() {
    const want = APP.feed;
    const wsOk = APP.profile.wsKlineStreams;
    if (want === 'tick-rest' || (want === 'auto' && !wsOk)) {
      this.startTickFeed();
      if (!wsOk && want === 'auto') {
        this.log.warn(`已按市场能力自动选择 tick-rest 行情源（${APP.profile.name} 的 kline WS 实测不可用）`);
      }
      return;
    }
    this.feedMode = 'kline-ws';
    this.openStreams();
    if (want === 'auto') {
      // 兜底探测：15 秒内收不到任何K线就自动降级
      setTimeout(() => {
        if (this.klineMessages > 0 || this.feedMode !== 'kline-ws') return;
        this.log.warn('15 秒内未收到任何 kline WS 数据，自动降级为 tick-rest 行情源');
        this.stopStreams();
        this.startTickFeed();
      }, 15_000);
    }
  }

  startTickFeed() {
    if (this.tickFeed) return;
    this.feedMode = 'tick-rest';
    this.tickFeed = new TickFeed(this, this.log);
    this.tickFeed.start();
  }

  stopStreams() {
    for (const sh of this.shards) {
      try { sh.ws?.close(4000, 'switch feed'); } catch { /* 已断开 */ }
    }
  }

  async refreshExchangeInfo() {
    try {
      const info = await this.rest.get(APP.exchangeInfoPath, { weight: APP.market === 'futures' ? 1 : 20, timeout: 30_000 });
      this.tradingSymbols = new Set(info.symbols.filter(APP.profile.universeFilter).map(s => s.symbol));
      this.lastExchangeInfoAt = Date.now();
      this.log.info(`可交易清单已更新：${this.tradingSymbols.size} 个 ${APP.profile.name} 标的`);
    } catch (e) {
      this.log.warn('exchangeInfo 获取失败，沿用上一次清单：' + e.message);
    }
  }

  // ---------- 涨幅榜前200 ----------

  async refreshUniverse({ seed = true } = {}) {
    try {
      const tickers = await this.rest.get(APP.tickerPath, { weight: APP.profile.tickerWeight, timeout: 30_000 });
      this.lastTickerAt = Date.now();
      const rows = [];
      for (const t of tickers) {
        if (!t.symbol.endsWith('USDT')) continue;
        if (EXCLUDE_SYMBOL_RE.test(t.symbol)) continue;
        const base = t.symbol.slice(0, -4);
        if (EXCLUDE_BASE.has(base)) continue;
        if (this.tradingSymbols.size && !this.tradingSymbols.has(t.symbol)) continue;
        const qv = Number(t.quoteVolume);
        if (qv < APP.minQuoteVolume) continue;
        if (Number(t.count) < APP.minTrades24h) continue;   // 死盘保险丝
        rows.push({
          symbol: t.symbol,
          price: Number(t.lastPrice),
          changePct: Number(t.priceChangePercent),
          quoteVolume: qv,
          trades: Number(t.count),
          high: Number(t.highPrice),
          low: Number(t.lowPrice),
          tickerAt: Date.now(),
        });
      }
      rows.sort((a, b) => b.changePct - a.changePct);
      this.universe = rows.slice(0, APP.topN).map(r => r.symbol);
      const keep = new Set(this.universe);

      // 移除跌出榜单的币种
      for (const sym of [...this.symbols.keys()]) {
        if (!keep.has(sym)) this.symbols.delete(sym);
      }
      // 新建/更新状态
      const fresh = [];
      for (const r of rows.slice(0, APP.topN)) {
        let st = this.symbols.get(r.symbol);
        if (!st) {
          st = createSymbolState(r.symbol);
          this.symbols.set(r.symbol, st);
          fresh.push(st);
        }
        st.price = r.price;
        st.changePct = r.changePct;
        st.quoteVolume = r.quoteVolume;
        st.high = r.high;
        st.low = r.low;
        st.tickerAt = this.lastTickerAt;
      }
      this.revision++;
      if (fresh.length) this.log.info(`涨幅榜更新：+${fresh.length} 个新标的（共 ${this.universe.length}）`);
      this.syncSubscriptions();
      if (seed && fresh.length) {
        for (const st of fresh) this.seedSymbol(st).catch(e => this.log.warn(`播种 ${st.symbol} 失败：${e.message}`));
      }
    } catch (e) {
      this.log.warn('涨幅榜刷新失败：' + e.message);
    }
  }

  // ---------- REST 播种 / 对账 ----------

  /** 播种单个币种的全部原生级别（首轮用较大的 backfill 回填更多历史） */
  async seedSymbol(st) {
    for (const lv of NATIVE_LEVELS) {
      const lim = lv.backfill ?? lv.limit ?? APP.candleLimit;
      const rows = await this.rest.get(
        `${APP.klinesPath}?symbol=${st.symbol}&interval=${lv.key}&limit=${lim}`,
        { weight: lim >= 500 ? 5 : lim >= 100 ? 2 : 1, timeout: 20_000 },
      );
      const ms = lv.minutes * 60_000;
      st.series[lv.key].mergeLoad(rows.map(r => parseKline(r, ms)));
    }
    for (const lv of LEVELS) {
      if (lv.native) continue;
      st.series[lv.key].rebuildFrom(st.series[lv.from]);
    }
    st.seeded = true;
    st.seededAt = Date.now();
  }

  async seedAll() {
    const list = [...this.symbols.values()].filter(s => !s.seeded);
    this.seeding = { done: 0, total: list.length, active: true };
    this.log.info(`开始播种 ${list.length} 个币种 × ${NATIVE_LEVELS.length} 个原生周期（权重预算内渐进执行）…`);
    const t0 = Date.now();
    await this.rest.mapLimit(list, async st => {
      await this.seedSymbol(st);
      this.seeding.done++;
      if (this.seeding.done % 20 === 0 || this.seeding.done === list.length) {
        this.log.info(`播种进度 ${this.seeding.done}/${list.length}`);
      }
    });
    this.seeding.active = false;
    this.log.info(`播种完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /** 全量对账：修复 WS 丢包造成的K线缺口 */
  async resyncAll() {
    if (this.seeding.active) return;
    this.log.info('开始定期对账…');
    const list = [...this.symbols.values()];
    await this.rest.mapLimit(list, async st => {
      try { await this.seedSymbol(st); } catch { /* 单币失败不影响整体 */ }
    });
    this.log.info('对账完成');
  }

  // ---------- WebSocket ----------

  openStreams() {
    for (const sh of this.shards) sh.connect();
  }

  syncSubscriptions() {
    if (this.feedMode !== 'kline-ws') return;
    for (const sh of this.shards) sh.sync();
  }

  /** 分发 WS K线 */
  onWsKline(payload) {
    const k = payload.k;
    if (!k) return;
    const st = this.symbols.get(k.s);
    if (!st) return;
    const idx = LEVEL_INDEX[k.i];
    if (idx === undefined) return;
    const lv = LEVELS[idx];
    const series = st.series[lv.key];
    series.upsert(parseWsKline(k));
    for (const dlv of LEVELS) {
      if (dlv.native || dlv.from !== lv.key) continue;
      st.series[dlv.key].rebuildFrom(series);
    }
    st.dirty = true;
    this.klineMessages++;
    this.lastKlineAt = Date.now();
    this.revision++;
  }

  get stats() {
    const shardInfo = this.shards.map(s => ({
      name: s.name,
      state: s.state,
      streams: s.streams.size,
      reconnects: s.reconnects,
    }));
    return {
      market: APP.market,
      marketName: APP.profile.name,
      feedMode: this.feedMode,
      tick: this.tickFeed ? this.tickFeed.stats : null,
      symbols: this.symbols.size,
      universe: this.universe.length,
      klineMessages: this.klineMessages,
      lastTickerAt: this.lastTickerAt,
      lastKlineAt: this.lastKlineAt,
      wsState: this.wsState,
      shards: shardInfo,
      seeding: this.seeding,
      rest: this.rest.stats,
      weightCap: APP.profile.officialWeightCap,
      uptime: Date.now() - this.startedAt,
    };
  }
}

function createSymbolState(symbol) {
  const series = {};
  for (const lv of LEVELS) series[lv.key] = new CandleSeries(lv);
  return {
    symbol,
    price: 0, changePct: 0, quoteVolume: 0, high: 0, low: 0,
    series,
    seeded: false, seededAt: 0, tickerAt: 0,
    dirty: true,
    levels: null,       // 最近一次评估结果
    evaluatedAt: 0,
    activeSignal: null, // 当前生效的共振信号
    lastAlertKey: null,
  };
}

/** 单条 WebSocket 连接（一个分片） */
class WsShard {
  constructor(market, name, levels) {
    this.market = market;
    this.name = name;
    this.levels = levels;
    this.ws = null;
    this.state = 'idle';
    this.streams = new Set();
    this.desired = new Set();
    this.reconnects = 0;
    this.backoff = 1000;
    this.msgCount = 0;
  }

  connect() {
    if (this.ws && (this.state === 'open' || this.state === 'connecting')) return;
    this.state = 'connecting';
    const ws = new WebSocket(APP.wsUrl);
    this.ws = ws;

    ws.addEventListener('open', () => {
      const isReconnect = this.reconnects > 0;
      this.state = 'open';
      this.backoff = 1000;
      this.streams.clear();
      this.market.log.info(`${this.name} WS 已连接${isReconnect ? '（重连）' : ''}`);
      this.sync(true);
      // 仅重连时补齐缺口；首次连接由 seedAll 负责，避免重复消耗权重
      if (isReconnect) {
        this.reseedTimer = setTimeout(() => {
          for (const st of this.market.symbols.values()) {
            this.market.seedSymbol(st).catch(() => {});
          }
        }, 3000);
      }
    });

    ws.addEventListener('message', ev => {
      this.msgCount++;
      const data = ev.data;
      if (typeof data !== 'string') return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.e === 'kline') this.market.onWsKline(msg);
      // 订阅/退订回执 {"result":null,"id":n} 在此静默忽略
    });

    ws.addEventListener('error', () => { /* close 事件会跟着来，统一在 close 处理 */ });

    ws.addEventListener('close', ev => {
      this.state = 'closed';
      clearTimeout(this.reseedTimer);
      this.reconnects++;
      const wait = Math.min(this.backoff, 30_000);
      this.backoff = Math.min(this.backoff * 2, 30_000);
      this.market.log.warn(`${this.name} WS 断开 (code=${ev.code})，${(wait / 1000).toFixed(0)}s 后重连`);
      setTimeout(() => this.connect(), wait);
    });
  }

  /** 计算期望流集合并与已订阅集合做差量 */
  sync(force = false) {
    const next = new Set();
    for (const sym of this.market.universe) {
      const s = sym.toLowerCase();
      for (const lv of this.levels) next.add(`${s}@kline_${lv}`);
    }
    this.desired = next;
    if (!this.ws || this.state !== 'open') return;

    const toAdd = [...next].filter(x => force || !this.streams.has(x));
    const toDel = [...this.streams].filter(x => !next.has(x));
    if (toDel.length) this.send({ method: 'UNSUBSCRIBE', params: toDel });
    for (const x of toDel) this.streams.delete(x);
    this.sendChunked(toAdd, 'SUBSCRIBE');
  }

  sendChunked(names, method) {
    if (!names.length) return;
    let idx = 0;
    const step = () => {
      if (!this.ws || this.state !== 'open') return;
      const chunk = names.slice(idx, idx + 200);
      this.send({ method, params: chunk });
      for (const n of chunk) { if (method === 'SUBSCRIBE') this.streams.add(n); }
      idx += chunk.length;
      if (idx < names.length) setTimeout(step, 350);
    };
    step();
  }

  send(obj) {
    try { this.ws?.send(JSON.stringify(obj)); } catch { /* 连接已断，忽略 */ }
  }
}
