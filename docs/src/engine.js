/**
 * 引擎：定时评估全部标的 -> 生成/去重共振报警 -> 通过事件推送
 */
import { Emitter } from './emitter.js';
import { LEVELS, LEVEL_KEYS, LEVEL_INDEX, VISIBLE_LEVELS, STATE, EVENT, APP } from './config.js';import { evaluateSymbol, describe, defaultSignalConfig } from './signals.js';
import { Watcher } from './watch.js';
import { DEFAULT_WATCH_GROUPS } from './config.js';

const SWEEP_MS = 1000;
const ALERT_TTL = 45 * 60_000;

export class Engine extends Emitter {
  constructor(market, log) {
    super();
    this.market = market;
    this.log = log;
    this.cfg = defaultSignalConfig();
    this.alerts = [];
    this.seenKeys = new Map();
    this.activeBySymbol = new Map();
    this.alertSeq = 0;
    this.sweepCount = 0;
    this.initialPhase = true;
    this.lastSweepMs = 0;
    this.lastSweepAt = 0;
    this.evaluations = 0;
    this.signalCount = 0;
    this.beichiBlocked = 0;        // 累计拦截次数（按每轮评估累加）
    // 两阶段盯盘：大级别预备 → 最小级别首次站上触发
    this.watcher = new Watcher(log, DEFAULT_WATCH_GROUPS.map(g => ({ ...g })));
    this.watchDbg = { seen: 0, enabled: 0, hasWatch: 0, called: 0, err: null };
    // 独立形态提醒的去重表：同一 (币种, 级别, K线) 只提醒一次
    this.dualSeen = new Map();
    this.dualCount = { long: 0, short: 0 };
    this.strokeBlocked = 0;        // 因「回踩不够成笔」被拦下的次数
    this.beichiPerMin = 0;         // 近一分钟拦截次数
    this._beichiSnap = 0;
    this.timer = null;
  }

  start() {
    const tick = () => {
      const t0 = Date.now();
      try { this.sweep(); }
      catch (e) { this.log.error('评估异常：' + (e.stack || e.message)); }
      this.lastSweepMs = Date.now() - t0;
      this.lastSweepAt = Date.now();
      this.timer = setTimeout(tick, SWEEP_MS);
    };
    this.timer = setTimeout(tick, 500);
    // 每分钟统计一次「背驰拦截速率」——累计值随评估轮次增长，不适合直接展示
    this.statTimer = setInterval(() => {
      this.beichiPerMin = this.beichiBlocked - this._beichiSnap;
      this._beichiSnap = this.beichiBlocked;
    }, 60_000);
  }

  stop() { clearTimeout(this.timer); clearInterval(this.statTimer); }

  setConfig(patch) {
    const before = JSON.stringify(this.cfg);
    this.cfg = { ...this.cfg, ...patch };
    if (patch.watchEnabled !== undefined || patch.watchBigBars !== undefined
      || patch.watchRequireBear !== undefined || Array.isArray(patch.watchGroups)) {
      this.watcher.setConfig({
        watchEnabled: this.cfg.watchEnabled,
        watchBigBars: this.cfg.watchBigBars,
        watchRequireBear: this.cfg.watchRequireBear,
        ...(Array.isArray(patch.watchGroups) ? { watchGroups: patch.watchGroups } : {}),
      });
    }
    if (JSON.stringify(this.cfg) !== before) {
      this.log.info('信号参数已更新：' + JSON.stringify(this.cfg));
      // 参数变化后允许同一形态重新报警
      this.seenKeys.clear();
    }
    return this.cfg;
  }

  sweep() {
    this.sweepCount++;
    this.initialPhase = this.sweepCount <= 2;   // 启动后的头两轮 = 存量扫描，不鸣笛
    const active = new Map();
    let initialCount = 0;

    for (const st of this.market.symbols.values()) {
      const r = this.evaluateOne(st);
      if (r >= 1) active.set(st.symbol, st.best);
      if (r === 3) initialCount++;              // 3 = 本轮新产生的"存量"信号
    }

    this.activeBySymbol = active;
    if (initialCount) this.log.info(`存量扫描完成：本轮载入 ${initialCount} 个已有的多级别共振形态（不鸣笛）`);
    this.prune();
  }

  /**
   * 评估单个标的。抽出来是为了让"K线刚收盘"能立刻触发一次评估，
   * 而不必等下一个 1 秒轮询 —— 这是 tick-rest 模式下低延迟的关键。
   * @returns {0|1|2|3}
   *   0 = 无信号
   *   1 = 有信号，但已提醒过（或低于推送评分）
   *   2 = 新产生的实时信号
   *   3 = 新产生的存量信号（启动扫描期，不鸣笛）
   */
  evaluateOne(st, forceNew = false) {
    if (!st.seeded) { st.levels = null; return 0; }
    // 僵尸标的护栏：最小级别K线长期未更新则不参与评估
    const s3 = st.series['3m'];
    const lastT = s3.t[s3.t.length - 1];
    st.stale = !lastT || (Date.now() - lastT) > APP.staleMs;
    if (st.stale) { st.levels = null; st.best = null; return 0; }

    let res;
    try {
      res = evaluateSymbol(st.symbol, st.series, this.cfg, this.cfg.useLiveCandle);
    } catch (e) {
      this.log.warn(`评估 ${st.symbol} 失败：${e.message}`);
      return 0;
    }
    this.evaluations++;
    st.levels = res.levels;
    st.bullCount = res.bullCount;
    st.aboveCount = res.aboveCount;
    st.best = res.best;
    st.evaluatedAt = Date.now();
    this.beichiBlocked += res.beichiBlocked || 0;
    this.watchDbg.seen++;
    if (this.cfg.watchEnabled) this.watchDbg.enabled++;
    if (res.watch) this.watchDbg.hasWatch++;
    // 盯盘状态机（与信号引擎并行；它只在状态迁移那一刻报警）
    if (this.cfg.watchEnabled && res.watch) {
      let fired = [];
      this.watchDbg.called++;
      try { fired = this.watcher.update(st.symbol, res.watch, Date.now()); }
      catch (e) { this.watchDbg.err = e.message; this.log.warn('盯盘状态机异常：' + e.message); }
      for (const a of fired) {
        this.alerts.push(a);
        this.signalCount++;
        this.emit('alert', a);
        this.log.signal('👁 ' + a.symbol + ' ' + a.text);
      }
    }
    // —— 独立形态提醒：双阴不破均线（多） / 双阳不穿破均线（空）——
    //    只看**已收盘**的那根K线（analyzeLevel 的 closed 模式），第二根一收盘立刻提醒。
    if (this.cfg.dualEnabled && res.dual) {
      for (const [lv, d] of Object.entries(res.dual)) {
        const dir = d.bear ? 'long' : (d.bull ? 'short' : null);
        if (!dir) continue;
        const key = 'dual|' + st.symbol + '|' + lv + '|' + d.candleT;
        if (this.dualSeen.has(key)) continue;
        this.dualSeen.set(key, Date.now());
        this.dualCount[dir]++;
        const label = (LEVELS.find(l => l.key === lv) || {}).label || lv;
        const a = {
          kind: 'dual', id: ++this.alertSeq, symbol: st.symbol, mode: 'dual',
          side: dir, confirmed: true, level: lv, levelLabel: label,
          group: dir === 'long' ? '双阴不破' : '双阳不穿',
          base: lv, mid: null, big: null,
          score: 0, price: d.close, candleT: d.candleT, ts: Date.now(), initial: false,
          ma7: d.ma7, ema7: d.ema7,
          // 右侧报警卡片要用的字段（形态提醒没有共振级别数，用当前多头排列级别数代替展示）
          bullCount: st.bullCount ?? 0,
          distBaseMa7Pct: (Number.isFinite(d.ma7) && d.ma7) ? ((d.close - d.ma7) / d.ma7) * 100 : null,
          combos: [],
          text: dir === 'long'
            ? `【双阴不破】${label} 连续 ${this.cfg.dualBars} 根阴K收盘都没跌破 MA7/EMA7 —— 上涨途中浅回调、抛压枯竭`
            : `【双阳不穿】${label} 连续 ${this.cfg.dualBars} 根阳K收盘都没涨破 MA7/EMA7 —— 下跌途中浅反弹、买盘枯竭`,
        };
        this.alerts.push(a);
        this.signalCount++;
        this.emit('alert', a);
        this.log.signal((dir === 'long' ? '🔴 ' : '🟢 ') + a.symbol + ' ' + a.text);
      }
      // 去重表只保留最近 2000 条
      if (this.dualSeen.size > 2000) {
        const keys = [...this.dualSeen.keys()].slice(0, this.dualSeen.size - 2000);
        for (const k of keys) this.dualSeen.delete(k);
      }
    }
    this.strokeBlocked += res.strokeBlocked || 0;
    // —— 共振信号引擎总闸 ——
    //    关掉之后不再产生「多级别共振」报警；上面的双阴/双阳形态提醒不受影响。
    if (!this.cfg.signalEnabled) { st.combos = null; st.best = null; return 0; }
    if (!res.best) { st.combos = null; return 0; }

    const initial = forceNew ? false : !!this.initialPhase;
    // 同一币种、同一组合、同一根K线内只提醒一次；其余命中组合作为明细附上
    const key = `${res.best.symbol}|${res.best.group}|${res.best.mode}|${res.best.candleT}`;
    if (this.seenKeys.has(key)) { st.combos = res.matches; return 1; }
    if (res.best.score < this.cfg.minScore) { st.combos = res.matches; return 1; }
    this.seenKeys.set(key, Date.now());

    const combos = res.matches.map(m => ({
      group: m.group, base: m.base, mid: m.mid, big: m.big, score: m.score, mode: m.mode,
    }));
    const extra = Math.max(0, (res.matchCount ?? combos.length) - 1);
    const alert = {
      ...res.best,
      id: ++this.alertSeq,
      initial,
      matchCount: res.matchCount ?? combos.length,
      combos,
      text: describe(res.best) + (extra > 0 ? ` · 另有 ${extra} 组级别组合同时命中` : ''),
    };
    st.combos = res.matches;
    this.alerts.push(alert);
    this.signalCount++;
    this.emit('alert', alert);
    if (!initial) this.log.signal(`🔔 ${res.best.symbol} [${res.best.score}分] ${alert.text}`);
    return initial ? 3 : 2;
  }

  prune() {
    const cutoff = Date.now() - ALERT_TTL;
    for (const [k, t] of this.seenKeys) if (t < cutoff) this.seenKeys.delete(k);
    if (this.alerts.length > 500) this.alerts.splice(0, this.alerts.length - 500);
  }

  /** 紧凑快照，用于 SSE 推送（避免每帧几十KB的对象开销） */
  snapshot() {
    const symbols = [];
    const rows = [];
    for (const sym of this.market.universe) {
      const st = this.market.symbols.get(sym);
      if (!st) continue;
      const codes = [];
      for (const k of LEVEL_KEYS) {
        const lv = st.levels?.[k];
        codes.push(lv ? lv.code + lv.event * 10 : 0);
      }
      const best = st.best;
      rows.push([
        Math.round(st.price * 1e8) / 1e8,
        Math.round(st.changePct * 100) / 100,
        Math.round(st.quoteVolume),
        st.bullCount ?? 0,
        st.aboveCount ?? 0,
        best ? best.score : 0,
        best ? (best.confirmed ? 1 : 2) : 0,
        st.seeded ? 1 : 0,
        ...codes,
      ]);
      symbols.push(sym);
    }
    return { t: Date.now(), symbols, levels: LEVEL_KEYS, rows, revision: this.market.revision };
  }

  /**
   * 单个币种的多级别K线图数据（供前端画蜡烛图）。
   * @param {string} symbol
   * @param {number} bars 每个级别取多少根K线
   */
  chart(symbol, bars = 150) {
    const st = this.market.symbols.get(symbol);
    if (!st) return null;
    const levels = [];
    for (const lv of VISIBLE_LEVELS) levels.push(this.levelPayload(st, lv.key, bars));
    // 每个级别在当前配置里扮演的角色（基准/确认/最大）
    const roles = {};
    for (const g of (this.cfg.groups ?? [])) {
      if (g.enabled === false) continue;
      for (const [k, role] of [[g.base, 'base'], [g.mid, 'mid'], [g.big, 'big']]) {
        if (!k) continue;
        (roles[k] ??= []).push(role);
      }
    }
    return {
      symbol,
      price: st.price,
      changePct: st.changePct,
      quoteVolume: st.quoteVolume,
      tickAt: st.tickAt,
      evaluatedAt: st.evaluatedAt,
      bullCount: st.bullCount ?? 0,
      levels,
      roles,
      groups: (this.cfg.groups ?? []).filter(g => g.enabled !== false),
    };
  }

  /**
   * 单个级别的图表数据（K线 / 均线 / MACD / 缠论笔）。
   * 多级别视图与报警视图共用，避免两套实现漂移。
   */
  levelPayload(st, key, bars = 150) {
    const idx = LEVEL_INDEX[key];
    const lv = idx == null ? null : LEVELS[idx];
    if (!lv) return null;
    const s = st.series[key];
    if (!s) return null;
    const n = s.t.length;
    const from = Math.max(0, n - bars);
    const r10 = x => (Number.isFinite(x) ? +x.toPrecision(10) : null);
    const empty = {
      key, label: lv.label, minutes: lv.minutes, ms: s.ms,
      candles: [], ma7: [], ema7: [], ma25: [], macd: { dif: [], dea: [], hist: [] },
      strokes: [], divergence: null, chanState: null,
      lastClosedIndex: -1, state: 0, event: 0, distMa7Pct: null,
    };
    if (!n) return empty;
    const ind = s.ensure();
    const candles = [], ma7 = [], ema7 = [], ma25 = [];
    const dif = [], dea = [], hist = [];
    const macd = ind.macd;
    for (let i = from; i < n; i++) {
      candles.push([s.t[i], r10(s.o[i]), r10(s.h[i]), r10(s.l[i]), r10(s.c[i]), Math.round(s.v[i])]);
      ma7.push(r10(ind.ma7[i]));
      ema7.push(r10(ind.ema7[i]));
      ma25.push(r10(ind.ma25[i]));
      dif.push(r10(macd.dif[i]));
      dea.push(r10(macd.dea[i]));
      hist.push(r10(macd.hist[i]));
    }
    // 缠论笔（只取窗口内的端点，下标换算成窗口内偏移）
    let strokes = [];
    let divergence = null;
    let chanState = null;
    try {
      const chan = s.ensureChan(this.cfg.beichiMinBars ?? 5);
      if (chan) {
        strokes = chan.pts
          .filter(p => Number.isFinite(p.confirmIdx) && p.origIdx >= from && p.origIdx < n)
          .map(p => [p.origIdx - from, r10(p.price), p.type === 'top' ? 1 : -1]);
        const last = s.beichiState(n - 1, {
          minBars: this.cfg.beichiMinBars ?? 5,
          ratio: this.cfg.beichiRatio ?? 1.0,
          minProgress: this.cfg.beichiMinProgress ?? 0.3,
        });
        if (last?.ok) {
          chanState = {
            dir: last.dir,
            divergence: last.divergence?.status ?? 'none',
            divDir: last.divergence?.dir ?? null,
            areaRatio: last.areaRatio,
            newExtreme: last.newExtreme,
          };
          divergence = last.divergence ?? null;
        }
      }
    } catch { /* 缠论失败不影响画图 */ }
    const lvl = st.levels?.[key];
    return {
      key, label: lv.label, minutes: lv.minutes, ms: s.ms,
      candles, ma7, ema7, ma25,
      macd: { dif, dea, hist },
      lastClosedIndex: s.closedCount - 1 - from,
      state: lvl?.code ?? 0,
      event: lvl?.event ?? 0,
      distMa7Pct: lvl?.distMa7Pct ?? null,
      strokes, divergence, chanState,
      price: r10(s.c[n - 1]),
      candleT: s.t[n - 1],
    };
  }

  /**
   * 报警视图：每条报警取它**组合里的确认级别**（如 3m>15m>2h 取 15m）画一张K线。
   * 顺序与右侧报警面板一致（最新在前）。
   */
  alertCharts(bars = 150, limit = 24) {
    const items = [];
    const skipped = [];
    for (let k = this.alerts.length - 1; k >= 0 && items.length < limit; k--) {
      const a = this.alerts[k];
      const st = this.market.symbols.get(a.symbol);
      if (!st) { skipped.push({ symbol: a.symbol, why: 'no-symbol' }); continue; }
      // 取级别，三类报警分别处理：
      //   共振信号 → mid（组合里的确认级别）
      //   形态提醒 → level（双阴/双阳只看一个级别）
      //   两阶段盯盘 → base（最小级别）
      const key = (a.mid && LEVEL_INDEX[a.mid] != null) ? a.mid
        : (a.level && LEVEL_INDEX[a.level] != null) ? a.level
          : (a.base && LEVEL_INDEX[a.base] != null) ? a.base
            : (typeof a.group === 'string' && a.group.includes('>') ? a.group.split('>')[1] : null);
      if (!key || LEVEL_INDEX[key] == null) { skipped.push({ symbol: a.symbol, why: 'no-level-key', group: a.group }); continue; }
      const lvl = this.levelPayload(st, key, bars);
      if (!lvl) { skipped.push({ symbol: a.symbol, why: 'no-level' }); continue; }
      items.push({
        ...lvl,
        symbol: a.symbol,
        alertId: a.id,
        kind: a.kind ?? 'resonance',
        side: a.side ?? null,
        // 形态提醒是「K线已收盘」的确认信号，用 closed 让卡片按已确认样式渲染
        mode: a.kind === 'dual' ? 'closed' : a.mode,
        score: a.score,
        group: a.group,
        base: a.base, mid: a.mid, big: a.big,
        at: a.ts ?? a.candleT,
        alertPrice: a.price ?? null,
        text: a.text ?? '',
        initial: !!a.initial,
      });
    }
    return {
      generatedAt: Date.now(),
      total: this.alerts.length,
      shown: items.length,
      limit,
      skipped: skipped.length,
      items,
    };
  }

  /** 盯盘名单（预备 / 已触发） */
  watchSnapshot(limit = 60) { return this.watcher.snapshot(limit); }

  /** 单币种明细 */
  detail(symbol) {    const st = this.market.symbols.get(symbol);
    if (!st) return null;
    const out = { symbol, price: st.price, changePct: st.changePct, quoteVolume: st.quoteVolume, seeded: st.seeded, levels: {} };
    for (const lv of VISIBLE_LEVELS) {
      const s = st.series[lv.key];
      const ind = s.ensure();
      const n = s.t.length;
      const i = s.done[n - 1] ? n - 1 : n - 2;
      const num = v => (Number.isFinite(v) ? v : null);
      out.levels[lv.key] = {
        label: lv.label,
        candles: s.t.length,
        closed: s.closedCount,
        lastCandleAt: s.t[n - 1] ?? null,
        price: s.c[n - 1] ?? null,
        ma7: num(ind.ma7[i]), ma25: num(ind.ma25[i]), ma99: num(ind.ma99[i]),
        ema7: num(ind.ema7[i]), ema25: num(ind.ema25[i]),
        hi: s.h[n - 1] ?? null, lo: s.l[n - 1] ?? null,
        state: st.levels?.[lv.key]?.code ?? STATE.NODATA,
        event: st.levels?.[lv.key]?.event ?? EVENT.NONE,
        distMa7Pct: st.levels?.[lv.key]?.distMa7Pct ?? null,
      };
    }
    out.matches = st.best ? [st.best] : [];
    out.evaluatedAt = st.evaluatedAt;
    return out;
  }

  stats() {
    return {
      sweepCount: this.sweepCount,
      lastSweepMs: this.lastSweepMs,
      lastSweepAt: this.lastSweepAt,
      evaluations: this.evaluations,
      signalCount: this.signalCount,
      beichiBlocked: this.beichiBlocked,
      watch: this.watcher.snapshot(0),
      watchDbg: this.watchDbg,
      dual: { ...this.dualCount, seen: this.dualSeen.size, cfg: {
        enabled: this.cfg.dualEnabled, levels: this.cfg.dualLevels, bars: this.cfg.dualBars,
      } },
      watchArmed: this.watcher.stats.armed,
      watchFired: this.watcher.stats.fired,
      strokeBlocked: this.strokeBlocked,
      beichiPerMin: this.beichiPerMin,
      activeSignals: this.activeBySymbol.size,
      alertBuffer: this.alerts.length,
      cfg: this.cfg,
      levels: LEVEL_KEYS,
    };
  }
}
