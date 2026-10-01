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
  /** 用币安回报的真实用量校准本地桶：真实配额越紧，本地桶上限压得越低 */
  calibrate(usedWeight) {
    this._refill();
    const remaining = Math.max(0, 6000 - usedWeight);
    const cap = Math.min(this.tokens, this.max * Math.min(1, remaining / 6000));
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
      const waitBan = this.bannedUntil - Date.now();
      if (waitBan > 0) await sleep(Math.min(waitBan, 5000));

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
          if (attempt < retries) { await sleep(backoff); continue; }
          throw new Error(`HTTP ${res.status} rate limited`);
        }
        if (res.status === 451 || res.status === 403) {
          this.rotateHost();
          if (attempt < retries) continue;
          throw new Error(`HTTP ${res.status} 地域限制`);
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
