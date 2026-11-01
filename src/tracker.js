/**
 * 信号绩效追踪：持久化每一条报警，并跟踪其 +1h / +4h / +24h 的实际表现。
 * 目的：让"这套逻辑到底有没有用"这个问题由真实运行数据回答，而不是只看回测。
 *
 * 本模块**零 Node 依赖**（存储走注入的适配器），因此浏览器版可以原样复用：
 *   Node   → fileStorage()   （file-storage.js）
 *   浏览器 → localStorage 适配器（src/browser/boot.js）
 */
const HORIZONS = [
  { key: 'h1', hours: 1 },
  { key: 'h4', hours: 4 },
  { key: 'h24', hours: 24 },
];
const MAX_ENTRIES = 3000;
/** 取价时优先使用的级别（按精度从高到低，覆盖不同时长的历史） */
const PRICE_LEVELS = ['3m', '30m', '1h', '4h', '1d'];

export class Tracker {
  constructor(file, log, storage) {
    this.file = file;
    this.log = log;
    this.store = storage;
    if (!this.store) throw new Error('Tracker 需要传入存储适配器（Node 用 fileStorage()）');
    this.entries = [];
    this.seq = 0;
    this.lastResolve = 0;
    this.load();
  }

  load() {
    try {
      const text = this.store.load();
      if (!text) return;
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines.slice(-MAX_ENTRIES)) {
        try { this.entries.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
      }
      this.seq = this.entries.reduce((m, e) => Math.max(m, e.id ?? 0), 0);
      this.log.info(`绩效库已载入 ${this.entries.length} 条历史信号`);
    } catch (e) {
      this.log.warn('绩效库读取失败：' + e.message);
    }
  }

  /** Keep signal type, direction and pair in the identity and persisted record. */
  record(alert) {
    const kind = alert.kind ?? 'resonance';
    const side = ['long', 'short'].includes(alert.side) ? alert.side : ['resonance', 'watch'].includes(kind) ? 'long' : null;
    const key = JSON.stringify([alert.symbol, kind, side, alert.pair, alert.level, alert.base, alert.mid, alert.big, alert.candleT, alert.mode]);
    if (this.entries.some(e => e.key === key)) return null;
    const e = {
      id: ++this.seq,
      key,
      symbol: alert.symbol,
      ts: alert.ts ?? Date.now(),
      candleT: alert.candleT,
      price: alert.price,
      kind, side, pair: alert.pair ?? null, sub: alert.sub ?? null, main: alert.main ?? null,
      level: alert.level ?? null,
      score: kind === 'resonance' && Number.isFinite(alert.score) ? alert.score : null,
      base: alert.base, mid: alert.mid, big: alert.big,
      bullCount: alert.bullCount,
      confirmed: !!alert.confirmed,
      initial: !!alert.initial,
      returnVersion: 2,
      out: {},
    };
    this.entries.push(e);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    try {
      this.store.append(JSON.stringify(e) + '\n');
    } catch (err) {
      this.log.warn('绩效库写入失败：' + err.message);
    }
    return e;
  }

  /** Latest closed price at or before target, without carrying stale prices across a gap. */
  static priceAt(series, target) {
    if (!series) return null;
    const t = series.t, ms = series.ms, c = series.c;
    for (let i = t.length - 1; i >= 0; i--) {
      if (t[i] + ms <= target) {
        return target - (t[i] + ms) < ms && series.done?.[i] !== false ? c[i] : null;
      }
    }
    return null;
  }

  /** 定期结算已到期但未结算的条目 */
  resolve(market, force = false) {
    const now = Date.now();
    if (!force && now - this.lastResolve < 30_000) return;
    this.lastResolve = now;
    let changed = 0;
    for (const e of this.entries) {
      // Old records did not save direction. Preserve them, without inventing long/short returns.
      if (!['long', 'short'].includes(e.side) || !(e.price > 0)) continue;
      const st = market.symbols.get(e.symbol);
      if (!st || !st.seeded) continue;
      for (const h of HORIZONS) {
        if (e.out[h.key] != null) continue;
        const target = e.ts + h.hours * 3600_000;
        if (now < target) continue;
        let px = null;
        for (const lv of PRICE_LEVELS) {
          px = Tracker.priceAt(st.series[lv], target);
          if (px != null) break;
        }
        if (px == null) continue;
        e.out[h.key] = Math.round(((px - e.price) / e.price) * (e.side === 'short' ? -1 : 1) * 10000) / 100;
        e.out._px = e.out._px || {};
        e.out._px[h.key] = px;
        changed++;
      }
    }
    if (changed) {
      // 结算结果重写整个文件（条目数量可控）
      try {
        this.store.rewrite(this.entries.map(e => JSON.stringify(e)).join('\n') + '\n');
      } catch (err) {
        this.log.warn('绩效库回写失败：' + err.message);
      }
    }
  }

  stats() {
    const recorded = this.entries.filter(e => !e.initial);
    const use = recorded.filter(e => e.returnVersion === 2 && ['long', 'short'].includes(e.side));
    const agg = arr => {
      const v = arr.filter(x => Number.isFinite(x));
      if (!v.length) return { n: 0, avg: null, med: null, win: null, best: null, worst: null, total: arr.length };
      const s = [...v].sort((a, b) => a - b);
      return {
        n: v.length,
        total: arr.length,
        avg: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100,
        med: (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2,
        win: Math.round((v.filter(x => x > 0).length / v.length) * 1000) / 10,
        best: s[s.length - 1],
        worst: s[0],
      };
    };
    const buckets = [
      ['≥80分', e => Number.isFinite(e.score) && e.score >= 80],
      ['70–79分', e => Number.isFinite(e.score) && e.score >= 70 && e.score < 80],
      ['60–69分', e => Number.isFinite(e.score) && e.score >= 60 && e.score < 70],
      ['<60分', e => Number.isFinite(e.score) && e.score < 60],
      ['未评分', e => !Number.isFinite(e.score)],
    ];
    const byScore = buckets.map(([name, f]) => {
      const sub = use.filter(f);
      return { name, n: sub.length, h1: agg(sub.map(e => e.out.h1)), h4: agg(sub.map(e => e.out.h4)), h24: agg(sub.map(e => e.out.h24)) };
    });
    return {
      total: this.entries.length,
      tracked: use.length,
      initialExcluded: this.entries.length - recorded.length,
      legacyExcluded: recorded.length - use.length,
      confirmed: use.filter(e => e.confirmed).length,
      preview: use.filter(e => !e.confirmed).length,
      horizons: HORIZONS.map(h => ({ key: h.key, hours: h.hours, ...agg(use.map(e => e.out[h.key])) })),
      byScore,
      confirmedOnly: {
        h1: agg(use.filter(e => e.confirmed).map(e => e.out.h1)),
        h4: agg(use.filter(e => e.confirmed).map(e => e.out.h4)),
        h24: agg(use.filter(e => e.confirmed).map(e => e.out.h24)),
      },
      recent: recorded.slice(-40).reverse().map(e => ({
        symbol: e.symbol, ts: e.ts, score: e.score, base: e.base, mid: e.mid, big: e.big,
        kind: e.kind ?? 'legacy', side: e.side ?? null, pair: e.pair ?? null,
        sub: e.sub ?? null, main: e.main ?? null, level: e.level ?? null,
        legacy: e.returnVersion !== 2,
        confirmed: e.confirmed, price: e.price, out: e.out,
      })),
    };
  }
}
