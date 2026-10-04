/**
 * REST 客户端：令牌桶限频 + 并发闸门 + 429/418 退避 + 多域名故障切换。
 * 币安现货权重上限 6000/分钟，本模块默认只用 3600，留足余量。
 */
import { APP } from './config.js';

export class TokenBucket {
  constructor(perMinute, burst) {
    this.rate = perMinute / 60_000; // 每毫秒补充
    this.max = burst;
    this.tokens = burst;
    this.last = Date.now();
  }
  _refill() {
    const now = Date.now();
    const dt = now - this.last;
    if (dt > 0) {
      this.tokens = Math.min(this.max, this.tokens + dt * this.rate);
      this.last = now;
    }
  }
  /** 阻塞直到可以取走 n 个令牌 */
  async take(n = 1) {
    for (;;) {
      this._refill();
      if (this.tokens >= n) { this.tokens -= n; return; }
      const need = (n - this.tokens) / this.rate;
      await sleep(Math.max(5, Math.min(need, 500)));
    }
  }
  /**
   * 用币安回报的真实用量校准本地桶。
   *
   * 口径要点（踩过坑，务必按这个来）：
   *   · `x-mbx-used-weight-1m` 是**已用量**，合约下这个值本身的上限就是 2400。
   *   · 不能简单用 `limit - used` 当余量：跑到满额时余量为 0，本地桶会被压到 0 → **彻底停摆**。
   *     （把硬编码的 6000 改成 profile 的 2400 时就犯过这个错，播种直接卡死。）
   *   · 正确做法：拿**我们自己的预算**（weightPerMinute，合约 1900）当基准 ——
   *     用量没超过预算就不限速；超过预算才线性收紧，为的是补上本地记账与实际用量之间的偏差。
   *   · 再留一个下限，保证任何情况下都不会完全停滞（真被限流由 429/418 分支处理）。
   */
  calibrate(usedWeight) {
    this._refill();
    const limit = APP.profile.officialWeightCap || APP.weightPerMinute;
    const budget = Math.min(APP.weightPerMinute, limit);
    const over = Math.max(0, usedWeight - budget);          // 超出自身预算多少
    const span = Math.max(1, limit - budget);               // 从预算到硬上限的余量
    const ratio = Math.max(0, 1 - over / span);
    const cap = Math.max(this.max * 0.2, this.max * ratio);
    if (cap < this.tokens) this.tokens = cap;
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export class RestClient {
  constructor(bucket, concurrency = APP.concurrency) {
    this.bucket = bucket;
    this.active = 0;
    this.queue = [];
    this.hostIndex = 0;
    this.bannedUntil = 0;
    this.stats = { requests: 0, errors: 0, weightUsed: 0, lastUsedWeight: 0, lastLatency: 0, avgLatency: 0 };
  }

  get base() { return APP.baseUrls[this.hostIndex % APP.baseUrls.length]; }

  rotateHost() { this.hostIndex++; }

  _acquireSlot() {
    if (this.active < APP.concurrency) { this.active++; return Promise.resolve(); }
    return new Promise(res => this.queue.push(res));
  }
  _releaseSlot() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }

  /**
   * @param {string} path 形如 /api/v3/klines?...
   * @param {{weight?:number, timeout?:number, retries?:number}} opts
   */
  async get(path, opts = {}) {
    const weight = opts.weight ?? 1;
    const retries = opts.retries ?? 3;
    const timeout = opts.timeout ?? 15_000;

    for (let attempt = 0; attempt <= retries; attempt++) {
      // —— 被限流时要**真的等满**，不能每 5 秒试探一次 ——
      // 币安的 418 惩罚是「持续触碰就持续累加」，每 5 秒重试会让 retry-after 一直续期、
      // 永远解不开（实测：等了半小时仍是 418，retry-after 反复刷新）。
      // 这里睡满剩余封禁时间（单次上限 5 分钟，避免超长封禁把任务挂死），
      // 且这次等待**不计入重试次数**。
      const waitBan = this.bannedUntil - Date.now();
      if (waitBan > 0) {
        // 封禁等待期间必须有可见输出：否则服务在启动阶段会静默挂住好几分钟，
        // 日志停在「面板已就绪」，看起来像死了。
        const secs = Math.round(waitBan / 1000);
        if (!this._banNotifiedAt || Date.now() - this._banNotifiedAt > 30_000) {
          this._banNotifiedAt = Date.now();
          this.onBanWait?.(secs, path);
        }
        await sleep(Math.min(waitBan, 300_000));
        attempt--;
        continue;
      }
      // 地域封锁期间不要刷请求（451 与频率无关，重试只是浪费）
      const waitGeo = (this.geoBlockedUntil ?? 0) - Date.now();
      if (waitGeo > 0) {
        await sleep(Math.min(waitGeo, 300_000));
        attempt--;
        continue;
      }

      await this.bucket.take(weight);
      await this._acquireSlot();
      const t0 = Date.now();
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeout);
        const res = await fetch(this.base + path, { signal: ctl.signal });
        clearTimeout(timer);

        const used = Number(res.headers.get('x-mbx-used-weight-1m') || 0);
        if (used) { this.stats.lastUsedWeight = used; this.bucket.calibrate(used); }
        const lat = Date.now() - t0;
        this.stats.lastLatency = lat;
        this.stats.avgLatency = this.stats.avgLatency
          ? Math.round(this.stats.avgLatency * 0.9 + lat * 0.1) : lat;
        this.stats.requests++;
        this.stats.weightUsed += weight;

        if (res.status === 429 || res.status === 418) {
          const retryAfter = Number(res.headers.get('retry-after') || 0);
          const backoff = retryAfter ? retryAfter * 1000 : Math.min(60_000, 2000 * 2 ** attempt);
          this.bannedUntil = Date.now() + backoff;
          this.rotateHost();
          this.stats.errors++;
          // 退避要有上限：Binance 的 retry-after 可能是几十分钟，
          // 无上限地 sleep 会让调用方（探测脚本 / 批量任务）看起来像卡死。
          if (attempt < retries) { await sleep(Math.min(backoff, 30_000)); continue; }
          throw new Error(`HTTP ${res.status} rate limited`);
        }
        if (res.status === 451 || res.status === 403) {
          // —— 地域限制（451 Unavailable For Legal Reasons / 403）——
          // 这是币安按 **IP / 地区** 做的封锁，跟请求频率无关：
          //   · 换域名没用（合约只有 fapi.binance.com 一个域名，rotateHost 是空转）
          //   · 立刻重试更没用，只会白白刷请求
          // 所以：记一个冷却窗口（至少 5 分钟不再试），并明确告知调用方需要换网络出口。
          const retryAfter = Number(res.headers.get('retry-after') || 0);
          this.stats.errors++;
          this.geoBlockedUntil = Date.now() + Math.max(retryAfter * 1000, 300_000);
          if (!this._geoNotifiedAt || Date.now() - this._geoNotifiedAt > 300_000) {
            this._geoNotifiedAt = Date.now();
            this.onGeoBlock?.(res.status, this.base);
          }
          if (APP.baseUrls.length > 1 && attempt < retries) { this.rotateHost(); continue; }
          throw new Error(`HTTP ${res.status} 地域限制（币安按 IP/地区封锁，换域名无效，需更换网络出口）`);
        }
        if (!res.ok) {
          if (res.status >= 500 && attempt < retries) { await sleep(300 * (attempt + 1)); continue; }
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
        }
        return await res.json();
      } catch (err) {
        this.stats.errors++;
        if (attempt >= retries) throw err;
        await sleep(200 * (attempt + 1));
      } finally {
        this._releaseSlot();
      }
    }
    throw new Error('unreachable');
  }

  /** 有界并发的批量映射 */
  async mapLimit(items, fn) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(APP.concurrency, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        try { results[i] = await fn(items[i], i); }
        catch (e) { results[i] = { __error: e.message ?? String(e) }; }
      }
    });
    await Promise.all(workers);
    return results;
  }
}
