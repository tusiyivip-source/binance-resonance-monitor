/**
 * 两阶段盯盘状态机（预备 → 触发）
 *
 * 与原有信号引擎的根本区别：
 *   engine.js 是**无状态**的 —— 「某一刻所有条件同时成立」才算信号。
 *   这里要的是**有状态**的：
 *     阶段一  大级别出现「两根阴K收盘不破 MA7/EMA7」 → 进入预备名单（此时不报警）
 *     阶段二  之后盯最小级别：先收盘跌破 MA7 与 EMA7，**首次**收盘重新站上两条线 → ★ 报警
 *
 * 所以每个 (币种 × 大级别组) 都要维护状态：待机 → 已预备 → 已报警。
 * 报警时机从「评估那一刻」变成「状态迁移那一刻」。
 *
 * 纯逻辑模块，不依赖任何 Node 净内置，浏览器版同样可用。
 */

export class Watcher {
  /**
   * @param {object} log 日志器
   * @param {Array} groups 级别对应表 [{big, mid, base, inner[], adjacent, enabled}]
   * @param {{enabled?:boolean, bigBars?:number, requireBear?:boolean}} opt
   */
  constructor(log, groups, opt = {}) {
    this.log = log;
    this.groups = groups;
    this.cfg = {
      enabled: opt.enabled !== false,
      bigBars: opt.bigBars ?? 2,        // 大级别要求连续几根「不破均线」
      requireBear: opt.requireBear !== false,  // 是否要求那几根是阴K
    };
    this.state = new Map();   // `${symbol}|${big}` -> 状态
    this.seq = 0;
    this.stats = { armed: 0, fired: 0, reset: 0, evaluations: 0 };
  }

  setConfig(patch = {}) {
    if (patch.watchEnabled !== undefined) this.cfg.enabled = !!patch.watchEnabled;
    if (patch.watchBigBars !== undefined) this.cfg.bigBars = Math.max(1, Math.min(5, patch.watchBigBars | 0));
    if (patch.watchRequireBear !== undefined) this.cfg.requireBear = !!patch.watchRequireBear;
    if (Array.isArray(patch.watchGroups)) this.groups = patch.watchGroups;
    if (patch.watchReset === true) { this.state.clear(); this.stats = { armed: 0, fired: 0, reset: 0, evaluations: 0 }; }
    return { ...this.cfg, groups: this.groups };
  }

  _key(symbol, big) { return `${symbol}|${big}`; }

  /**
   * 用一次评估结果推进状态。
   *
   * @param {string} symbol
   * @param {object} levels 形如 { '1h': {twoBear, aboveBoth, belowBoth, above7, close, ma7, ema7, candleT}, ... }
   * @param {number} now
   * @returns {Array} 本次新触发的报警（通常 0 或 1 条）
   */
  update(symbol, levels, now = Date.now()) {
    if (!this.cfg.enabled) return [];
    const out = [];
    this.stats.evaluations++;

    for (const g of this.groups) {
      if (g.enabled === false) continue;
      const big = levels[g.big], base = levels[g.base], mid = levels[g.mid];
      if (!big || !base) continue;

      const key = this._key(symbol, g.big);
      let s = this.state.get(key);
      if (!s) {
        s = { phase: 'idle', armedAt: 0, armCandleT: 0, baseBroke: false, firedAt: 0, cycles: 0 };
        this.state.set(key, s);
      }

      // 大级别形态：连续 bigBars 根收盘不破 MA7/EMA7（可选要求阴K）
      const bigOk = this.cfg.requireBear ? !!big.twoBear : !!big.holdMa;

      // 大级别条件消失 → 周期结束，回到待机（允许下一轮重新预备）
      if (!bigOk) {
        if (s.phase !== 'idle') { s.phase = 'idle'; s.baseBroke = false; this.stats.reset++; }
        continue;
      }

      // —— 阶段一：首次满足 → 预备 ——
      if (s.phase === 'idle') {
        s.phase = 'armed';
        s.armedAt = now;
        s.armCandleT = big.candleT ?? 0;
        s.baseBroke = false;
        s.cycles++;
        this.stats.armed++;
        continue;   // 预备的这一轮不立刻触发，等阶段二
      }

      if (s.phase === 'fired') continue;   // 一个周期内只报一次

      // —— 阶段二：最小级别先跌破、再首次站回 ——
      if (base.belowBoth) s.baseBroke = true;

      const firstReclaim = s.baseBroke && base.aboveBoth;
      // 同一根K线只触发一次（避免 tick 抖动重复报警）
      if (firstReclaim && s.firedAt !== (base.candleT ?? 0)) {
        s.phase = 'fired';
        s.firedAt = base.candleT ?? now;
        this.stats.fired++;
        out.push(this._makeAlert(symbol, g, levels, s, now));
      }
    }
    return out;
  }

  _makeAlert(symbol, g, levels, s, now) {
    const L = k => levels[k];
    const inner = (g.inner ?? []).map(k => {
      const v = levels[k];
      return { level: k, hasStroke: !!v?.strokeOk, above7: !!v?.above7 };
    });
    const adj = g.adjacent ? levels[g.adjacent] : null;
    return {
      kind: 'watch',
      id: ++this.seq,
      symbol,
      mode: 'watch',
      confirmed: true,
      group: `${g.base}<${g.mid}<${g.big}`,
      base: g.base, mid: g.mid, big: g.big,
      score: 0,
      price: L(g.base)?.close ?? null,
      candleT: L(g.base)?.candleT ?? now,
      ts: now,
      armedAt: s.armedAt,
      initial: false,
      // 参考信息（不拦截，只展示）
      inner,
      innerAllStroke: inner.length > 0 && inner.every(x => x.hasStroke),
      adjacent: g.adjacent ?? null,
      adjacentCross: adj ? !!adj.above7 : null,
      baseStroke: !!L(g.base)?.strokeOk,
      midStroke: !!L(g.mid)?.strokeOk,
      text: `【盯盘触发】${g.big} 首次两根阴K不破均线 → 预备；`
        + `${g.base} 跌破后首次收盘站上 MA7/EMA7`
        + ` · 参考：${g.mid}${L(g.mid)?.strokeOk ? '已' : '未'}够笔`
        + `，${(g.inner ?? []).map(k => `${k}${levels[k]?.strokeOk ? '已' : '未'}够笔`).join('、')}`
        + `${g.adjacent ? `，${g.adjacent}${adj?.above7 ? '已' : '未'}上穿` : ''}`,
    };
  }

  /** 供界面展示当前预备/已触发的名单 */
  snapshot(limit = 60) {
    const rows = [];
    for (const [key, s] of this.state) {
      if (s.phase === 'idle') continue;
      const i = key.lastIndexOf('|');
      rows.push({
        symbol: key.slice(0, i), big: key.slice(i + 1),
        phase: s.phase, armedAt: s.armedAt, baseBroke: s.baseBroke, firedAt: s.firedAt, cycles: s.cycles,
      });
    }
    rows.sort((a, b) => (b.firedAt || b.armedAt) - (a.firedAt || a.armedAt));
    return {
      total: rows.length,
      armed: rows.filter(r => r.phase === 'armed').length,
      fired: rows.filter(r => r.phase === 'fired').length,
      stats: this.stats,
      cfg: this.cfg,
      groups: this.groups,
      rows: rows.slice(0, limit),
    };
  }

  /** 清理长期没有变化的条目，避免状态表无限增长 */
  prune(now = Date.now(), maxAgeMs = 6 * 3600_000) {
    for (const [key, s] of this.state) {
      const last = s.firedAt || s.armedAt || 0;
      if (last && now - last > maxAgeMs) this.state.delete(key);
    }
  }
}
