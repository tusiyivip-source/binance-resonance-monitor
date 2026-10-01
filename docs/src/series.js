/**
 * K线序列：支持原生周期与本地合成周期（10m←5m，3h←1h），
 * 内置惰性指标缓存（MA7/MA25/MA99、EMA7/EMA25、量比）。
 */
import { buildSMA, buildEMA, buildMACD } from './indicators.js';
import { analyzeChan, chanStateAt, strokeInfoAt } from './chan.js';
import { APP } from './config.js';

export class CandleSeries {
  /** @param {{key:string,minutes:number,native:boolean,from?:string,ratio?:number}} level */
  constructor(level) {
    this.level = level;
    this.key = level.key;
    this.ms = level.minutes * 60_000;
    this.t = []; this.o = []; this.h = []; this.l = []; this.c = []; this.v = [];
    this.q = []; this.n = []; this.done = [];
    this.dirty = true;
    this.ind = null;
    this.source = null;
    this.lastUpdate = 0;
    this.lastCloseAt = 0;
    this.version = 0;          // 每次内容变更 +1，用于缠论缓存失效
    this._chan = null;
    this._chanKey = '';
  }

  get length() { return this.t.length; }

  /** 已收盘K线的根数（最后一根若仍在形成中则不计入） */
  get closedCount() {
    const n = this.t.length;
    if (!n) return 0;
    return this.done[n - 1] ? n : n - 1;
  }

  get lastClosedIndex() { return this.closedCount - 1; }
  get formingIndex() { return this.t.length - 1; }

  /** 原生周期：直接 upsert 币安 WS/REST 的K线 */
  upsert(k) {
    const n = this.t.length;
    if (n && this.t[n - 1] === k.t) {
      const i = n - 1;
      this.o[i] = k.o; this.h[i] = k.h; this.l[i] = k.l; this.c[i] = k.c;
      this.v[i] = k.v; this.q[i] = k.q; this.n[i] = k.n; this.done[i] = k.done;
    } else if (n && k.t < this.t[n - 1]) {
      // 乱序/补历史
      let i = n - 1;
      while (i >= 0 && this.t[i] > k.t) i--;
      if (i >= 0 && this.t[i] === k.t) {
        this.o[i] = k.o; this.h[i] = k.h; this.l[i] = k.l; this.c[i] = k.c;
        this.v[i] = k.v; this.q[i] = k.q; this.n[i] = k.n; this.done[i] = k.done;
      } else {
        const at = i + 1;
        this.t.splice(at, 0, k.t); this.o.splice(at, 0, k.o); this.h.splice(at, 0, k.h);
        this.l.splice(at, 0, k.l); this.c.splice(at, 0, k.c); this.v.splice(at, 0, k.v);
        this.q.splice(at, 0, k.q); this.n.splice(at, 0, k.n); this.done.splice(at, 0, k.done);
      }
    } else {
      this.t.push(k.t); this.o.push(k.o); this.h.push(k.h); this.l.push(k.l);
      this.c.push(k.c); this.v.push(k.v); this.q.push(k.q); this.n.push(k.n); this.done.push(k.done);
    }
    if (k.done) this.lastCloseAt = Math.max(this.lastCloseAt, k.t + this.ms);
    this.trim();
    this.dirty = true;
    this.version++;
  }

  /**
   * 用实时价格推进/构建当前K线（tick-rest 模式专用）。
   *  - 价格落在当前K线区间内：更新 close / high / low
   *  - 跨入新的时间区间：把上一根标记为已收盘，并开启新的一根
   * 返回是否发生了「K线收盘」事件（调用方可据此立刻重新评估信号）。
   * @param {number} price
   * @param {number} now 毫秒时间戳
   */
  applyTick(price, now) {
    if (!Number.isFinite(price) || price <= 0) return false;
    const bucket = Math.floor(now / this.ms) * this.ms;
    const n = this.t.length;
    if (n === 0) {
      this.t.push(bucket); this.o.push(price); this.h.push(price); this.l.push(price);
      this.c.push(price); this.v.push(0); this.q.push(0); this.n.push(0); this.done.push(false);
      this.dirty = true;
    this.version++;
      return false;
    }
    const last = n - 1;
    if (bucket === this.t[last]) {
      this.c[last] = price;
      if (price > this.h[last]) this.h[last] = price;
      if (price < this.l[last]) this.l[last] = price;
      this.dirty = true;
    this.version++;
      return false;
    }
    if (bucket > this.t[last]) {
      const rolled = !this.done[last];
      this.done[last] = true;
      this.lastCloseAt = this.t[last] + this.ms;
      // 只开一根当前K线；中间若有缺口，由下一次 REST 对账补回
      this.t.push(bucket); this.o.push(price); this.h.push(price); this.l.push(price);
      this.c.push(price); this.v.push(0); this.q.push(0); this.n.push(0); this.done.push(false);
      this.trim();
      this.dirty = true;
    this.version++;
      return rolled;
    }
    return false;                       // 迟到的 tick，忽略
  }

  /** REST 批量灌入（覆盖式） */
  bulkLoad(rows) {
    this.t = []; this.o = []; this.h = []; this.l = []; this.c = [];
    this.v = []; this.q = []; this.n = []; this.done = [];
    for (const r of rows) {
      this.t.push(r.t); this.o.push(r.o); this.h.push(r.h); this.l.push(r.l);
      this.c.push(r.c); this.v.push(r.v); this.q.push(r.q); this.n.push(r.n);
      this.done.push(r.done);
    }
    this.trim();
    this.dirty = true;
    this.version++;
  }

  trim() {
    const max = APP.maxCandlesKept;
    const extra = this.t.length - max;
    if (extra > 0) {
      this.t.splice(0, extra); this.o.splice(0, extra); this.h.splice(0, extra);
      this.l.splice(0, extra); this.c.splice(0, extra); this.v.splice(0, extra);
      this.q.splice(0, extra); this.n.splice(0, extra); this.done.splice(0, extra);
      this.version++;
    }
  }

  /**
   * REST 合并式灌入：保留比新数据更早的旧K线，只覆盖新数据覆盖到的区间。
   *
   * 为什么需要它：REST 每次只拉 limit 根（合约权重敏感，多数周期 limit=99），
   * 若用覆盖式，序列永远只有 99 根 —— 缠论笔数不够、K线图也画不长。
   * 合并后序列会随运行时间逐步累积到 maxCandlesKept，而**不多花一分权重**。
   * 已收盘的旧K线不会变，所以合并是安全的；正在形成的那根由新数据覆盖。
   */
  mergeLoad(rows) {
    if (!rows.length) return;
    const first = rows[0].t;
    const n = this.t.length;
    if (!n || this.t[n - 1] < first) {          // 旧数据全在新数据之前 → 直接追加
      for (const r of rows) {
        this.t.push(r.t); this.o.push(r.o); this.h.push(r.h); this.l.push(r.l);
        this.c.push(r.c); this.v.push(r.v); this.q.push(r.q); this.n.push(r.n); this.done.push(r.done);
      }
      this.trim();
      this.dirty = true;
      this.version++;
      return;
    }
    // 二分找第一个 >= first 的位置，之前的一律保留
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.t[mid] < first) lo = mid + 1; else hi = mid; }
    const keep = lo;
    const T = this.t.slice(0, keep), O = this.o.slice(0, keep), H = this.h.slice(0, keep);
    const L = this.l.slice(0, keep), C = this.c.slice(0, keep), V = this.v.slice(0, keep);
    const Q = this.q.slice(0, keep), N = this.n.slice(0, keep), D = this.done.slice(0, keep);
    for (const r of rows) {
      T.push(r.t); O.push(r.o); H.push(r.h); L.push(r.l);
      C.push(r.c); V.push(r.v); Q.push(r.q); N.push(r.n); D.push(r.done);
    }
    this.t = T; this.o = O; this.h = H; this.l = L; this.c = C;
    this.v = V; this.q = Q; this.n = N; this.done = D;
    this.trim();
    this.dirty = true;
    this.version++;
  }

  /** 由源级别重新合成（10m←5m，3h←1h） */
  rebuildFrom(source) {
    this.source = source;
    const sms = source.ms;
    const t = source.t, o = source.o, h = source.h, l = source.l, c = source.c,
      v = source.v, q = source.q, nn = source.n, dn = source.done;

    const T = [], O = [], H = [], L = [], C = [], V = [], Q = [], N = [], D = [];
    let bt = -1, idx = -1;
    for (let i = 0; i < t.length; i++) {
      const bucket = Math.floor(t[i] / this.ms) * this.ms;
      if (bucket !== bt) {
        bt = bucket; idx++;
        T.push(bucket); O.push(o[i]); H.push(h[i]); L.push(l[i]); C.push(c[i]);
        V.push(v[i]); Q.push(q[i]); N.push(nn[i]); D.push(false);
      } else {
        H[idx] = h[i] > H[idx] ? h[i] : H[idx];
        L[idx] = l[i] < L[idx] ? l[i] : L[idx];
        C[idx] = c[i]; V[idx] += v[i]; Q[idx] += q[i]; N[idx] += nn[i];
      }
      // 该 bucket 的最后一根源K线若已收盘且刚好铺满 bucket，则合成K线收盘
      D[idx] = dn[i] && (t[i] + sms >= bucket + this.ms);
    }
    this.t = T; this.o = O; this.h = H; this.l = L; this.c = C;
    this.v = V; this.q = Q; this.n = N; this.done = D;
    this.trim();
    this.dirty = true;
    this.version++;
  }

  /** 惰性构建指标 */
  ensure() {
    if (!this.dirty && this.ind) return this.ind;
    const c = this.c;
    const ind = {
      ma7: buildSMA(c, 7),
      ma25: buildSMA(c, 25),
      ma99: buildSMA(c, 99),
      ema7: buildEMA(c, 7),
      ema25: buildEMA(c, 25),
      volMa20: buildSMA(this.v, 20),
      macd: buildMACD(c),
    };
    this.ind = ind;
    this.dirty = false;
    return ind;
  }

  /**
   * 惰性构建缠论结构（包含处理/分型/笔/MACD面积前缀和）。
   * 结构与参数无关，按 version 缓存，回测里对同一序列只算一次。
   */
  ensureChan(minBars = 5) {
    const key = this.version + '|' + minBars;
    if (this._chan && this._chanKey === key) return this._chan;
    const chan = analyzeChan(this, minBars);
    this._chan = chan;
    this._chanKey = key;
    return chan;
  }

  /** 截至 idx 的缠论与背驰状态 */
  beichiState(idx, opt) {
    const chan = this.ensureChan(opt?.minBars ?? 5);
    return chanStateAt(chan, this, idx, opt);
  }

  /** 截至 idx 的「笔」状态（最近一个完成的向下笔 / 最近一个已确认顶分型） */
  strokeInfo(idx, minBars = 5) {
    return strokeInfoAt(this.ensureChan(minBars), this, idx);
  }
}

/** 币安原始K线数组 -> 内部结构（收盘判定用 closeTime，避免本地时钟偏差） */
export function parseKline(raw, ms) {
  const t = raw[0];
  return {
    t,
    o: +raw[1], h: +raw[2], l: +raw[3], c: +raw[4],
    v: +raw[5], q: +raw[7], n: +raw[8] || 0,
    done: t + ms <= Date.now(),
  };
}

/** WS kline 事件 -> 内部结构 */
export function parseWsKline(k) {
  return {
    t: k.t,
    o: +k.o, h: +k.h, l: +k.l, c: +k.c,
    v: +k.v, q: +k.q, n: +k.n,
    done: k.x === true,
  };
}
