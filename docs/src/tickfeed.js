/**
 * tick-rest 行情源（U 本位合约默认）
 *
 * 背景：实测从部分网络访问 fstream 时，kline / aggTrade / markPrice / miniTicker /
 * ticker 这几类 WS 流被静默拦截（订阅回执正常但零数据），而 depth / bookTicker 正常。
 * 因此这里改为：
 *   1) 订阅 `!bookTicker`（全市场最优买卖价），用中间价实时推进每根正在形成的K线；
 *   2) 用 REST `/fapi/v1/klines` 按周期滚动补真实 OHLC（价格流拿不到真实最高/最低与成交量）。
 *
 * 延迟：K线收盘由实时价驱动，边界处 1~2 秒内即可判定；REST 只负责纠偏。
 */
import { APP, LEVELS, NATIVE_LEVELS, REST_REFRESH_PLAN } from './config.js';
import { parseKline } from './series.js';

export class TickFeed {
  constructor(market, log) {
    this.market = market;
    this.log = log;
    this.ws = null;
    this.state = 'idle';
    this.reconnects = 0;
    this.backoff = 1000;
    this.bookMsgs = 0;
    this.priceTicks = 0;
    this.lastPriceAt = 0;
    this.rollingTicks = 0;
    this.refreshStats = Object.fromEntries(REST_REFRESH_PLAN.map(p => [p.levels.join('+'), { done: 0, total: 0, cycles: 0 }]));
    this.queues = REST_REFRESH_PLAN.map(p => ({ plan: p, items: [], cursor: 0, startedAt: 0 }));
    this.timer = null;
  }

  start() {
    this.openBookTicker();
    if (!this.timer) {
      this.timer = setInterval(() => this.scheduleRefresh().catch(() => { }), 1000);
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    try { this.ws?.close(); } catch { /* 已断开 */ }
  }

  // ---------------- 实时价格 ----------------

  openBookTicker() {
    if (this.ws && (this.state === 'open' || this.state === 'connecting')) return;
    this.state = 'connecting';
    const ws = new WebSocket(APP.wsUrl);
    this.ws = ws;
    this.market.wsState = 'connecting';

    ws.addEventListener('open', () => {
      this.state = 'open';
      this.market.wsState = 'open';
      this.backoff = 1000;
      this.log.info(`bookTicker 已连接，订阅全市场最优买卖价（${APP.profile.bookTickerStream}）`);
      ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [APP.profile.bookTickerStream], id: 1 }));
    });

    ws.addEventListener('message', ev => {
      const s = ev.data;
      if (typeof s !== 'string') return;
      let m;
      try { m = JSON.parse(s); } catch { return; }
      if (m.result !== undefined) return;            // 订阅回执
      if (m.e !== 'bookTicker' || !m.s) return;
      this.bookMsgs++;
      const bid = Number(m.b), ask = Number(m.a);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
      this.onPrice(m.s, (bid + ask) / 2);
    });

    ws.addEventListener('error', () => { /* close 会随后触发 */ });

    ws.addEventListener('close', ev => {
      this.state = 'closed';
      this.market.wsState = 'closed';
      this.reconnects++;
      const wait = Math.min(this.backoff, 30_000);
      this.backoff = Math.min(this.backoff * 2, 30_000);
      this.log.warn(`bookTicker 断开 (code=${ev.code})，${(wait / 1000).toFixed(0)}s 后重连`);
      setTimeout(() => this.openBookTicker(), wait);
    });
  }

  /** 实时价 -> 推进该币种所有级别的当前K线 */
  onPrice(symbol, price) {
    const st = this.market.symbols.get(symbol);
    if (!st) return;
    const now = Date.now();
    st.price = price;
    st.tickAt = now;
    this.lastPriceAt = now;
    this.market.lastKlineAt = now;      // 与 kline-ws 模式共用同一个"行情新鲜度"指标
    this.priceTicks++;

    let closed = false;
    for (const lv of LEVELS) {
      if (st.series[lv.key].applyTick(price, now)) closed = true;
    }
    // 合成级别（2分/10分/3分）随源级别重建
    for (const lv of LEVELS) {
      if (lv.native) continue;
      st.series[lv.key].rebuildFrom(st.series[lv.from]);
    }
    st.dirty = true;
    // 有K线刚收盘 -> 立刻重估，让确认信号在边界处 1~2 秒内出来
    if (closed) this.market.onCandleClose?.(st);
  }

  // ---------------- 滚动 REST 补K线 ----------------

  async scheduleRefresh() {
    const now = Date.now();
    for (const q of this.queues) {
      const { plan } = q;
      // 重建任务表的时机：周期到 / 上轮跑完 / 任务表还是空的（启动时可能尚未播种完）
      const stale = !q.startedAt || now - q.startedAt >= plan.everyMs;
      const exhausted = q.cursor >= q.items.length;
      if (stale || exhausted || !q.items.length) {
        q.items = [];
        for (const st of this.market.symbols.values()) {
          if (!st.seeded) continue;
          for (const key of plan.levels) q.items.push([st, key]);
        }
        // 打散，避免每轮都按同样的顺序打同一批币
        for (let i = q.items.length - 1; i > 0; i--) {
          const j = (Math.random() * (i + 1)) | 0;
          [q.items[i], q.items[j]] = [q.items[j], q.items[i]];
        }
        q.cursor = 0;
        q.startedAt = now;
        this.refreshStats[plan.levels.join('+')].total += q.items.length;
      }
      if (!q.items.length) continue;
      const perSec = Math.max(1, Math.ceil(q.items.length / (plan.everyMs / 1000)));
      const batch = q.items.slice(q.cursor, q.cursor + perSec);
      q.cursor += batch.length;
      if (!batch.length) continue;
      this.rollingTicks += batch.length;
      for (const [st, key] of batch) this.refreshOne(st, key).catch(() => { });
    }
  }

  async refreshOne(st, levelKey) {
    const lv = LEVELS.find(l => l.key === levelKey);
    if (!lv) return;
    const lim = lv.limit ?? APP.candleLimit;
    const rows = await this.market.rest.get(
      `${APP.klinesPath}?symbol=${st.symbol}&interval=${lv.key}&limit=${lim}`,
      { weight: lim >= 500 ? 5 : lim >= 100 ? 2 : 1, timeout: 15_000, retries: 1 },
    );
    const ms = lv.minutes * 60_000;
    const series = st.series[lv.key];
    // 合并式灌入：保留更早的旧K线，让序列随运行时间累积（不多花权重）
    series.mergeLoad(rows.map(r => parseKline(r, ms)));
    for (const dlv of LEVELS) {
      if (dlv.native || dlv.from !== lv.key) continue;
      st.series[dlv.key].rebuildFrom(series);
    }
    st.seeded = true;
    const s = this.refreshStats[this.queues.find(q => q.plan.levels.includes(levelKey))?.plan.levels.join('+') ?? levelKey];
    if (s) s.done++;
    st.dirty = true;
  }

  get stats() {
    return {
      mode: 'tick-rest',
      state: this.state,
      reconnects: this.reconnects,
      bookMsgs: this.bookMsgs,
      priceTicks: this.priceTicks,
      lastPriceAt: this.lastPriceAt,
      rollingTicks: this.rollingTicks,
      refresh: this.refreshStats,
    };
  }
}
