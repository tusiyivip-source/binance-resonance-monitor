/**
 * 引擎：定时评估全部标的 -> 生成/去重共振报警 -> 通过事件推送
 */
import { Emitter } from './emitter.js';
import { LEVELS, LEVEL_KEYS, LEVEL_INDEX, VISIBLE_LEVELS, STATE, EVENT, APP } from './config.js';
import { evaluateSymbol, describe, defaultSignalConfig, encodeZero } from './signals.js';
import { MONITOR_LEVEL_KEYS, ZERO_LEVEL_KEYS, ZERO_PAIRS, zeroOptions, zeroMonitorAt, zeroMatches, zeroPairHit, bigCandleSupport, compareZero } from './zero-monitor.js';
import { SINGLE_K_LEVELS, singleKOptions, singleKAt } from './single-k.js';
import { NN_INTERVALS, nnState } from './nn.js';
import { PAIR_ZERO_PAIRS, pairZeroOptions, levelZeroAt, pairZeroHit, comparePairZero } from './pair-zero.js';
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
    // 前 N / 后 N 分组计数（缺了它下面自增那行会抛错，
    // 而它位于 emit('alert') 之前，会连带把 SSE 与钉钉推送一起打断）
    this.dualTierCount = { top: 0, tail: 0 };
    this.dualStarCount = 0;        // 星标（涨幅榜前 N 名）提醒条数
    // 零轴配对报警：去重表 + 计数（缺了会刷屏或抛错）
    this.zeroSeen = new Map();
    this.zeroOn = new Map();       // (币种|配对) → 上一轮是否已成立，用于状态跃迁去重
    this.zeroSkippedStale = 0;     // 因「次级别K线收盘太久」被挡下的配对
    this.zeroCount = 0;            // 已产生的配对报警条数
    // 单K回踩不破 的报警去重与计数（缺了 singleKAlertSweep 会抛 TypeError）
    // 配对策略（次级别回踩 / 主级别零轴）的报警去重与计数
    this.pairZeroSeen = new Map();
    this.pairZeroOn = new Map();
    this.pairZeroSkippedStale = 0;
    this.pairZeroSkippedQv = 0;
    this.pairZeroCount = 0;
    this.singleKSeen = new Map();
    this.singleKOn = new Map();    // (币种|级别|方向) → 上一轮是否已成立
    this.singleKSkippedStale = 0;
    this.singleKSkippedQv = 0;     // 因成交额不足被挡下的单K报警
    this.singleKCount = 0;
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
    // 配对报警出问题不能拖垮整个扫描（sweep 里还要做 prune、统计等）
    try { this.zeroAlertSweep(); } catch (e) { this.log?.warn?.('零轴配对报警异常：' + (e && e.message)); }
    try { this.pairZeroAlertSweep(); } catch (e) { this.log?.warn?.('配对报警异常：' + (e && e.message)); }
    try { this.singleKAlertSweep(); } catch (e) { this.log?.warn?.('单K报警异常：' + (e && e.message)); }
    this.prune();
  }

  /**
   * 主级别「左侧大K线 + 回调不破」结构检查。
   * @returns {object|null} 命中的那根大K线信息，null 表示结构不成立
   */
  /** 主级别背驰状态（金叉/死叉已在零轴同侧时才需要查） */
  mainDivergence(st, key, now) {
    const s = st.series?.[key];
    if (!s || s.t.length < 40) return null;
    let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
    while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
    if (ci < 30) return null;
    try {
      return s.beichiState(ci, { ratio: this.cfg.beichiRatio ?? 1, minProgress: this.cfg.beichiMinProgress ?? 0.3 })?.divergence ?? null;
    } catch { return null; }
  }

  zeroStructure(st, mainKey, dir, opt, now) {
    const s = st.series?.[mainKey];
    if (!s || s.t.length < 40) return null;
    let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
    while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
    if (ci < 5) return null;
    try { return bigCandleSupport(s, ci, dir, opt); } catch { return null; }
  }

  /**
   * 零轴配对信号的报警扫描。
   *
   * 与 zeroScan（给前端表格用）分开：这里只负责「产生新报警」，
   * 而且必须带两道闸门，否则会刷屏：
   *   ① 去重 —— 同一 (币种, 配对, 次级别收盘时间) 只报一次；
   *   ② 时效 —— 次级别K线收盘超过 zeroMaxStaleSec 就不再报。
   *      重启后去重表是空的，没有这道闸门会把所有存量配对一次性推出去。
   */
  zeroAlertSweep() {
    if (this.cfg.zeroAlertEnabled === false) return;
    const opt = zeroOptions({}, this.cfg);
    const mainMinHold = this.cfg.zeroMainMinHold ?? 3;
    const maxStale = (this.cfg.zeroMaxStaleSec ?? 120) * 1000;
    const now = Date.now();
    const L = (k) => (LEVELS.find(l => l.key === k) || {}).label || k;

    for (const st of this.market.symbols.values()) {
      if (!st?.seeded) continue;
      // 先把这个标的用到的级别算一遍，6 组配对共用，避免重复计算
      const memo = {};
      const mon = (k) => {
        if (k in memo) return memo[k];
        const series = st.series?.[k];
        if (!series || series.t.length < 40) return (memo[k] = null);
        let ci = Math.min(series.lastClosedIndex ?? series.t.length - 1, series.t.length - 1);
        while (ci >= 0 && series.t[ci] + series.ms > now) ci--;
        if (ci < 33) return (memo[k] = null);
        const closedAt = series.t[ci] + series.ms;
        try {
          return (memo[k] = { z: zeroMonitorAt(series, series.ensure(), ci, opt), closedAt, candleT: series.t[ci] });
        } catch { return (memo[k] = null); }
      };

      for (const pr of ZERO_PAIRS) {
        const sub = mon(pr.sub), main = mon(pr.main);
        let hit = (sub?.z && main?.z)
          ? zeroPairHit(sub.z, main.z, mainMinHold, this.mainDivergence(st, pr.main, now), opt)
          : null;
        // ③ 结构闸门：主级别左侧必须有一根未被回调吃掉的推动K线
        // stc 必须在循环作用域声明 —— 下面构造报警对象时还要用它。
        // （之前写成 if 块内的 const，块外引用会抛 ReferenceError，
        //   而 sweep 里那层 try/catch 会把它吞掉，表现为「一条报警都发不出去」）
        let stc = null;
        if (hit && opt.requireBig) {
          stc = this.zeroStructure(st, pr.main, hit.dir === 'long' ? 1 : -1, opt, now);
          if (!stc) hit = null; else hit.structure = stc;
        }

        // —— 状态跃迁去重 ——
        // 配对成立是个「状态」而不是「事件」：只要状态持续，每根次级别K线收盘都会满足。
        // 若按 (币种,配对,收盘时间) 去重，3m-15m 会每 3 分钟重报一次，严重刷屏。
        // 所以只在「从未成立 → 成立」的那一轮报一次；状态消失后再次成立才会再报。
        const onKey = st.symbol + '|' + pr.sub + '-' + pr.main;
        const wasOn = this.zeroOn.get(onKey) === true;
        if (!hit) { if (wasOn) this.zeroOn.set(onKey, false); continue; }
        if (wasOn) continue;                       // 状态持续中，不重复报
        // ② 时效：次级别必须「刚刚收盘」。
        // 注意顺序：被时效挡下时**不能**把状态标记为 on，
        // 否则这轮存量的状态会永远「已成立」，之后再也不会报（重启后就没有信号了）。
        // 不标记的话，等次级别下一根收盘（那时 now−closedAt 很小）就会正常报出来。
        if (maxStale > 0 && now - sub.closedAt > maxStale) { this.zeroSkippedStale++; continue; }
        this.zeroOn.set(onKey, true);
        // ① 去重（同一根收盘 + 同一配对，防止同一轮内重复）
        const key = 'zp|' + st.symbol + '|' + pr.sub + '-' + pr.main + '|' + sub.candleT;
        if (this.zeroSeen.has(key)) continue;
        this.zeroSeen.set(key, now);

        const up = hit.dir === 'long';
        const a = {
          kind: 'zeropair', id: ++this.alertSeq, symbol: st.symbol, mode: 'zeropair',
          side: hit.dir, confirmed: true, score: 0,
          pair: pr.sub + '-' + pr.main, sub: pr.sub, main: pr.main,
          level: pr.sub, levelLabel: L(pr.sub), mainLabel: L(pr.main),
          subNear: hit.subNear, subHold: hit.subHold,
          bigT: stc?.t ?? null, bigMult: stc ? Math.round(stc.mult*10)/10 : null, bigLine: stc?.line ?? null,
          mainDif: hit.mainDif, mainHold: hit.mainHold, mainNear: hit.mainNear,
          price: Math.round((st.price ?? 0) * 1e8) / 1e8,
          candleT: sub.candleT, ts: now,
          rank: st.rank ?? 0,
          tier: (this.cfg.dualTierSplit ?? 50) > 0 && st.rank > 0
            ? (st.rank <= (this.cfg.dualTierSplit ?? 50) ? 'top' : 'tail') : null,
          initial: this.initialPhase,     // 启动头两轮算存量，只入面板不推送
          text: `【${pr.sub}-${pr.main}】主级别 ${L(pr.main)} ${up ? '金叉' : '死叉'}已 ${hit.mainHold} 根`
            + `（DIF 在零轴${hit.mainAboveZero ? '上方' : '下方'}`
            // 只有「主级别在零轴同侧」时才真的查了背驰，别的地方不能写「无背驰」
            + (up === hit.mainAboveZero ? `，${up ? '无顶背驰' : '无底背驰'}` : '，不在同侧未查背驰')
            + '），'
            + `次级别 ${L(pr.sub)} 回踩到零轴附近 ${(hit.subNear * 100).toFixed(1)}% 但未${up ? '下穿' : '上穿'}零轴`,
        };
        this.alerts.push(a);
        this.signalCount++;
        this.zeroCount++;
        this.emit('alert', a);
        this.log.signal((up ? '🔴 ' : '🟢 ') + a.symbol + ' ' + a.text);
      }
    }
    // 去重表只保留最近 3000 条
    if (this.zeroSeen.size > 3000) {
      const keys = [...this.zeroSeen.keys()].slice(0, this.zeroSeen.size - 3000);
      for (const k of keys) this.zeroSeen.delete(k);
    }
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
        // —— 成交额门槛：24H 成交额低于阈值直接不提醒 ——
        // 小成交额的币容易凑出「两根K线勉强不破均线」的假形态，且滑点大不好成交。
        const minQv = this.cfg.dualMinQuoteVolume ?? 0;
        if (minQv > 0 && !(Number(st.quoteVolume) >= minQv)) {
          this.dualSkippedQv = (this.dualSkippedQv || 0) + 1;
          continue;
        }
        // —— 时效闸门：只报「刚刚收盘」的那根K线 ——
        // 没有这道闸门时会出现两类"延迟报送"：
        //   ① 标的刚进涨幅榜、被补播种后立刻评估 → 把一两小时前就收盘的K线当成新信号报出来
        //   ② 服务重启后去重表清空 → 当前所有已成立的形态被重新报一遍
        // 判定依据是「这根K线真正收盘的时刻」，超过 dualMaxStaleSec 就不再提醒。
        const maxStale = (this.cfg.dualMaxStaleSec ?? 120) * 1000;
        if (maxStale > 0) {
          const meta = LEVELS.find(l => l.key === lv);
          const lvMs = meta ? meta.minutes * 60_000 : 0;
          if (lvMs > 0 && d.candleT) {
            const closedAt = d.candleT + lvMs;
            if (Date.now() - closedAt > maxStale) {
              this.dualSkippedStale = (this.dualSkippedStale || 0) + 1;
              continue;
            }
          }
        }
        const key = 'dual|' + st.symbol + '|' + lv + '|' + d.candleT;
        if (this.dualSeen.has(key)) continue;
        this.dualSeen.set(key, Date.now());
        this.dualCount[dir]++;
        const label = (LEVELS.find(l => l.key === lv) || {}).label || lv;
        // —— 前 N / 后 N 分组 ——
        // 涨幅榜前 50 与后 50 的可靠性差别很大（后者涨幅小、流动性差、形态更易失真），
        // 报警里明确标出属于哪一段，方便分开看、分开处理。
        const split = this.cfg.dualTierSplit ?? 50;
        const rank = st.rank ?? 0;
        const tier = split > 0 && rank > 0 ? (rank <= split ? 'top' : 'tail') : null;
        const tierLabel = tier === 'top' ? `前${split}`
          : tier === 'tail' ? (APP.topN ? `后${APP.topN - split}` : '后段') : '';
        const tierTag = tier ? `【${tierLabel}】` : '';
        // —— 星标：涨幅榜前 dualStarRank 名 ——
        // 名单越靠前涨幅越猛、资金关注度越高，这类提醒单独打个星，扫消息时一眼能挑出来。
        const starRank = this.cfg.dualStarRank ?? 20;
        const star = starRank > 0 && rank > 0 && rank <= starRank;
        const starTag = star ? '★ ' : '';
        const a = {
          kind: 'dual', id: ++this.alertSeq, symbol: st.symbol, mode: 'dual',
          side: dir, confirmed: true, level: lv, levelLabel: label,
          group: dir === 'long' ? '双阴不破' : '双阳不穿',
          base: lv, mid: null, big: null,
          score: 0, price: d.close, candleT: d.candleT, ts: Date.now(), initial: false,
          ma7: d.ma7, ema7: d.ema7,
          // 分组 + 星标信息
          rank, tier, tierLabel, star, starRank,
          // 右侧报警卡片要用的字段（形态提醒没有共振级别数，用当前多头排列级别数代替展示）
          bullCount: st.bullCount ?? 0,
          distBaseMa7Pct: (Number.isFinite(d.ma7) && d.ma7) ? ((d.close - d.ma7) / d.ma7) * 100 : null,
          combos: [],
          text: starTag + tierTag + (dir === 'long'
            ? `【双阴不破】${label} 连续 ${this.cfg.dualBars} 根阴K收盘都没跌破 MA7/EMA7 —— 上涨途中浅回调、抛压枯竭`
            : `【双阳不穿】${label} 连续 ${this.cfg.dualBars} 根阳K收盘都没涨破 MA7/EMA7 —— 下跌途中浅反弹、买盘枯竭`),
        };
        this.alerts.push(a);
        this.signalCount++;
        this.dualTierCount[tier ?? 'none'] = (this.dualTierCount[tier ?? 'none'] || 0) + 1;
        if (star) this.dualStarCount++;
        this.emit('alert', a);
        // 星标的用 ⭐ 前缀打日志，方便在日志里直接筛出来
        this.log.signal((star ? '⭐ ' : '') + (dir === 'long' ? '🔴 ' : '🟢 ') + a.symbol + ' ' + a.text);
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

  /**
   * 「次级别回踩 / 主级别零轴」配对的报警扫描。
   *
   * 两道闸门同其他策略：
   *   ① 状态跃迁 —— 同一 (币种|配对|方向) 只在「不成立 → 成立」时报一次；
   *   ② 时效 —— 次级别K线必须刚收盘，否则是重启后翻出来的存量。
   */
  pairZeroAlertSweep() {
    if (this.cfg.pairZeroAlertEnabled === false) return;
    const opt = pairZeroOptions({}, this.cfg);
    const maxStale = (this.cfg.pairZeroAlertStaleSec ?? 120) * 1000;
    const minQv = this.cfg.pairZeroMinQuoteVolume ?? 0;
    const now = Date.now();
    for (const st of this.market.symbols.values()) {
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;
      const cache = new Map();
      const zof = key => {
        if (cache.has(key)) return cache.get(key);
        const s = st.series?.[key];
        let z = null;
        if (s && s.t.length >= 40) {
          let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
          while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
          if (ci >= 35) { try { z = levelZeroAt(s, s.ensure(), ci); } catch { z = null; } }
        }
        cache.set(key, z);
        return z;
      };
      for (const p of PAIR_ZERO_PAIRS) {
        const sub = zof(p.sub), main = zof(p.main);
        if (!sub || !main) continue;
        for (const dir of [1, -1]) {
          const onKey = st.symbol + '|' + p.sub + '|' + p.main + '|' + dir;
          const hit = pairZeroHit(sub, main, dir, opt);
          const wasOn = this.pairZeroOn.get(onKey) === true;
          if (!hit) { if (wasOn) this.pairZeroOn.set(onKey, false); continue; }
          if (wasOn) continue;                                  // 状态持续中
          if (maxStale > 0 && now - sub.at > maxStale) {        // 次级别刚收盘才报
            this.pairZeroSkippedStale++; continue;
          }
          if (minQv > 0 && !(Number(st.quoteVolume) >= minQv)) {
            this.pairZeroSkippedQv++; continue;
          }
          this.pairZeroOn.set(onKey, true);
          const key = 'pz|' + onKey + '|' + sub.at;
          if (this.pairZeroSeen.has(key)) continue;
          this.pairZeroSeen.set(key, now);

          const up = dir > 0;
          const subLabel = (LEVELS.find(l => l.key === p.sub) || {}).label || p.sub;
          const mainLabel = (LEVELS.find(l => l.key === p.main) || {}).label || p.main;
          const a = {
            kind: 'pairzero', id: ++this.alertSeq, symbol: st.symbol, mode: 'closed',
            side: hit.dir, confirmed: true, score: 0,
            sub: p.sub, main: p.main, pair: p.sub + '-' + p.main,
            subLabel, mainLabel,
            subDif: hit.subDif, subHold: hit.subHold, subPullBars: hit.subPullBars, subPeak: hit.subPeak,
            mainDif: hit.mainDif, mainHold: hit.mainHold,
            rank: st.rank ?? 0,
            price: Math.round((st.price ?? 0) * 1e8) / 1e8,
            changePct: Math.round((st.changePct ?? 0) * 100) / 100,
            quoteVolume: Math.round(st.quoteVolume ?? 0),
            candleT: sub.at, ts: now,
            initial: this.initialPhase,
            text: `【${subLabel}→${mainLabel}】${up ? '主级别零轴上' : '主级别零轴下'}`
              + `（DIF ${hit.mainDif > 0 ? '+' : ''}${Number(hit.mainDif).toPrecision(3)}，持续 ${hit.mainHold} 根），`
              + `${subLabel} ${up ? '回踩' : '反弹'} ${hit.subPullBars} 根仍在零轴${up ? '上' : '下'}`
              + `（DIF ${hit.subDif > 0 ? '+' : ''}${Number(hit.subDif).toPrecision(3)}）`,
          };
          this.alerts.push(a);
          this.signalCount++;
          this.pairZeroCount++;
          this.emit('alert', a);
          this.log.signal((up ? '🔴 ' : '🟢 ') + a.symbol + ' ' + a.text);
        }
      }
    }
    if (this.pairZeroSeen.size > 3000) {
      const keys = [...this.pairZeroSeen.keys()].slice(0, this.pairZeroSeen.size - 3000);
      for (const kk of keys) this.pairZeroSeen.delete(kk);
    }
  }

  /**
   * 单K回踩不破 的报警扫描（替代原来的零轴配对推送）。
   *
   * 与 singleKScan（给前端表格/图表用）分开：这里只负责「产生新报警」。
   * 两道闸门同 zeroAlertSweep：
   *   ① 状态跃迁 —— 只在「未成立 → 成立」时报一次，避免同一形态反复推；
   *   ② 时效 —— 当前K线必须刚收盘，否则是重启后翻出来的存量。
   */
  singleKAlertSweep() {
    if (this.cfg.singleKAlertEnabled === false) return;
    const opt = singleKOptions({}, this.cfg);
    const maxStale = (this.cfg.singleKAlertStaleSec ?? 120) * 1000;
    const now = Date.now();
    for (const st of this.market.symbols.values()) {
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;
      for (const k of SINGLE_K_LEVELS) {
        const s = st.series?.[k];
        if (!s || s.t.length < 40) continue;
        let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
        while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
        if (ci < 30) continue;
        const closedAt = s.t[ci] + s.ms;
        const label = (LEVELS.find(l => l.key === k) || {}).label || k;
        for (const dir of [1, -1]) {
          const onKey = st.symbol + '|' + k + '|' + dir;
          let hit = null;
          const ind = s.ensure ? s.ensure() : null;   // 零轴筛选要读 DIF
          try { hit = singleKAt(s, ci, opt, dir, ind); } catch { hit = null; }
          const wasOn = this.singleKOn.get(onKey) === true;
          if (!hit) { if (wasOn) this.singleKOn.set(onKey, false); continue; }
          if (wasOn) continue;                                  // 状态持续中
          if (maxStale > 0 && now - closedAt > maxStale) {      // 刚收盘才报
            this.singleKSkippedStale++; continue;
          }
          // 成交额门槛：24H 成交额太小的币，同样的K线更容易假突破、滑点也大。
          // 放在「标记已成立」之前 —— 否则低成交额的形态会被标记为已报过，
          // 等成交额涨上来后也不会再提醒。
          const minQv = this.cfg.singleKMinQuoteVolume ?? 0;
          if (minQv > 0 && !(Number(st.quoteVolume) >= minQv)) {
            this.singleKSkippedQv++; continue;
          }
          this.singleKOn.set(onKey, true);
          const key = 'sk|' + onKey + '|' + s.t[ci];
          if (this.singleKSeen.has(key)) continue;
          this.singleKSeen.set(key, now);

          const up = dir > 0;
          const split = this.cfg.dualTierSplit ?? 50;
          const a = {
            kind: 'singlek', id: ++this.alertSeq, symbol: st.symbol, mode: 'singlek',
            side: hit.dir, confirmed: true, score: 0,
            level: k, levelLabel: label,
            rank: st.rank ?? 0,
            price: Math.round((st.price ?? 0) * 1e8) / 1e8,
            changePct: Math.round((st.changePct ?? 0) * 100) / 100,
            quoteVolume: Math.round(st.quoteVolume ?? 0),
            bodyPct: hit.bodyPct, mult: hit.mult, retracePct: hit.retracePct,
            barsAfter: hit.barsAfter, line: hit.line, bigT: hit.t,
            open: hit.open, close: hit.close, low: hit.low, high: hit.high,
            candleT: s.t[ci], ts: now,
            zeroSide: hit.zeroSide, dif: hit.dif,
            tier: split > 0 && st.rank > 0 ? (st.rank <= split ? 'top' : 'tail') : null,
            initial: this.initialPhase,
            text: `【${label}】${hit.zeroSide === 'above' ? '零轴上 ' : hit.zeroSide === 'below' ? '零轴下 ' : ''}`
              + `${up ? '大阳线' : '大阴线'} ${up ? '+' : '−'}${hit.bodyPct.toFixed(1)}%（实体放大 ${hit.mult.toFixed(1)} 倍），`
              + `${up ? '回踩' : '反抽'} ${hit.retracePct.toFixed(1)}% 未破 ${hit.line}`,
          };
          this.alerts.push(a);
          this.signalCount++;
          this.singleKCount++;
          this.emit('alert', a);
          this.log.signal((up ? '🔴 ' : '🟢 ') + a.symbol + ' ' + a.text);
        }
      }
    }
    if (this.singleKSeen.size > 3000) {
      const keys = [...this.singleKSeen.keys()].slice(0, this.singleKSeen.size - 3000);
      for (const kk of keys) this.singleKSeen.delete(kk);
    }
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

  /** Seven independent timeframes; no other timeframe or pair gates a monitor. */
  zeroScan(input = {}) {
    const opt = zeroOptions(input, this.cfg), now = Date.now();
    const entries = [], hits = [];
    for (const sym of this.market.universe) {
      const st = this.market.symbols.get(sym);
      if (!st?.seeded || (opt.q && !sym.includes(opt.q)) || (opt.onlyUp && !(st.changePct > 0))) continue;
      const monitors = MONITOR_LEVEL_KEYS.map(k => {
        const series = st.series?.[k];
        if (!series || series.t.length < 40) return null;
        let ci = Math.min(series.lastClosedIndex ?? series.t.length - 1, series.t.length - 1);
        while (ci >= 0 && series.t[ci] + series.ms > now) ci--;
        if (ci < 33 || now - (series.t[ci] + series.ms) >= series.ms + 90_000) return null;
        let z;
        try { z = zeroMonitorAt(series, series.ensure(), ci, opt); } catch { return null; }
        return z ? { ...z, selected: zeroMatches(z, opt) } : null;
      });
      const matching = monitors.flatMap((z,i) => z?.selected ? [{sym,k:MONITOR_LEVEL_KEYS[i],z}] : []);
      if (!matching.length || matching.length < opt.minQual) continue;
      matching.sort(compareZero); hits.push(...matching);
      entries.push({sym,monitors,first:matching[0],row:[
        Math.round(st.price*1e8)/1e8, Math.round((st.changePct??0)*100)/100,
        Math.round(st.quoteVolume??0),matching.length,
        matching.filter(h=>h.z.side>0).length,matching.filter(h=>h.z.side<0).length,
        1,...monitors.map(z=>encodeZero(z)),
      ]});
    }
    hits.sort(compareZero); entries.sort((a,b)=>compareZero(a.first,b.first));
    const items=hits.map(({sym,k,z})=>{
      const st=this.market.symbols.get(sym);
      return {symbol:sym,level:k,dir:z.side>0?'long':'short',near:z.near,hold:z.hold,
        dif:z.dif,dea:z.dea,cross:z.crossSide>0?'golden':z.crossSide<0?'death':null,
        at:z.at,firstNearAt:z.firstNearAt,firstNearBarAt:z.firstNearBarAt,
        confirmed:true,signal:true,seeded:true,price:st.price,changePct:st.changePct??0,quoteVolume:st.quoteVolume??0};
    });
    return {hits,snapshot:{mode:'single',t:now,symbols:entries.map(e=>e.sym),rows:entries.map(e=>e.row),
      monitors:entries.map(e=>e.monitors),levels:MONITOR_LEVEL_KEYS,items,
      options:opt,cfg:{...opt,zeroLookback:opt.lookback,zeroMaxNear:opt.maxNear}}};
  }

  zeroAxis(input = {}) { return this.zeroScan(input).snapshot; }

  /**
   * 配对策略的**平铺 K 线**：每条配对信号出一张**次级别**K线图，
   * 图上标出「回踩起点」（本轮 DIF 极值那根）。
   */
  pairZeroCharts(bars = 120, limit = 24, input = {}) {
    const scan = this.pairZeroScan(input);
    const items = [];
    for (const h of scan.items.slice(0, limit)) {
      const st = this.market.symbols.get(h.symbol);
      const lvl = st && this.levelPayload(st, h.sub, bars);
      if (!lvl) continue;
      items.push({
        ...lvl, symbol: h.symbol, kind: 'pair', side: h.dir,
        pair: {
          sub: h.sub, main: h.main, pair: h.pair,
          subLabel: h.subLabel, mainLabel: h.mainLabel,
          dir: h.dir, rank: h.rank,
          mainDif: h.mainDif, mainHold: h.mainHold,
          subDif: h.subDif, subHold: h.subHold,
          subPullBars: h.subPullBars, subPeak: h.subPeak, subPeakT: h.subPeakT, subAt: h.subAt,
          price: h.price, changePct: h.changePct,
        },
      });
    }
    return {
      generatedAt: scan.t, total: scan.total, longs: scan.longs, shorts: scan.shorts,
      shown: items.length, limit, bars, options: scan.options, pairs: scan.pairs, items,
    };
  }

  /**
   * 「次级别回踩 / 主级别零轴」配对扫描。
   *
   * 七组配对（次 → 主）：5m-30m / 10m-1h / 15m-2h / 30m-3h / 1h-6h / 2h-12h / 4h-1d
   * 多：主级别 DIF 在零轴上，次级别也在零轴上并且已经回踩 ≥ N 根
   * 空：镜像（零轴下 + 反弹 ≥ N 根且没上穿）
   */
  pairZeroScan(input = {}) {
    const opt = pairZeroOptions(input, this.cfg);
    const now = Date.now();
    const items = [];
    let skippedStale = 0;
    for (const sym of this.market.universe) {
      const st = this.market.symbols.get(sym);
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;

      // 同一个币的级别状态只算一次（七组配对共用）
      const cache = new Map();
      const zof = key => {
        if (cache.has(key)) return cache.get(key);
        const s = st.series?.[key];
        let z = null;
        if (s && s.t.length >= 40) {
          let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
          while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
          if (ci >= 35) {
            try { z = levelZeroAt(s, s.ensure(), ci); } catch { z = null; }
          }
        }
        cache.set(key, z);
        return z;
      };

      for (const p of PAIR_ZERO_PAIRS) {
        const sub = zof(p.sub), main = zof(p.main);
        if (!sub || !main) continue;
        for (const dir of [1, -1]) {
          const hit = pairZeroHit(sub, main, dir, opt);
          if (!hit) continue;
          if (opt.side !== 'all' && hit.dir !== opt.side) continue;
          items.push({
            symbol: sym,
            sub: p.sub, main: p.main, pair: p.sub + '-' + p.main,
            subLabel: (LEVELS.find(l => l.key === p.sub) || {}).label || p.sub,
            mainLabel: (LEVELS.find(l => l.key === p.main) || {}).label || p.main,
            rank: st.rank,
            price: Math.round((st.price ?? 0) * 1e8) / 1e8,
            changePct: Math.round((st.changePct ?? 0) * 100) / 100,
            quoteVolume: Math.round(st.quoteVolume ?? 0),
            ...hit,
          });
        }
      }
    }
    items.sort(comparePairZero);
    return {
      t: now, total: items.length,
      longs: items.filter(i => i.dir === 'long').length,
      shorts: items.filter(i => i.dir === 'short').length,
      pairs: PAIR_ZERO_PAIRS, options: opt, items,
    };
  }

  /**
   * 「牛牛盯盘」风格的结构扫描：当前周期 × 全部标的，
   * 每个币算 双阴不破 / MACD 零轴位置 / 顺势回调 三个标记，
   * 按「零上回调置顶、零下反弹垫底」分层排序，并附上画卡片要用的K线。
   */
  nnScan(input = {}) {
    const num = (v, d, min, max) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Math.max(min, Math.min(max, Number(v))));
    const interval = NN_INTERVALS.some(([k]) => k === input.interval) ? input.interval : '15m';
    const mode = ['gain', 'loss', 'vol'].includes(input.mode) ? input.mode : 'gain';
    const pb = ['all', 'top', 'bottom'].includes(input.pb) ? input.pb : 'all';
    const topN = Math.round(num(input.topN, this.cfg.appTopN ?? 200, 1, 400));
    const limit = Math.round(num(input.limit, 60, 1, 200));
    const bars = Math.round(num(input.bars, 80, 30, 300));
    const now = Date.now();

    const rows = [];
    for (const sym of this.market.universe) {
      const st = this.market.symbols.get(sym);
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= topN)) continue;
      const s = st.series?.[interval];
      if (!s || s.t.length < 40) continue;
      let ns;
      try { ns = nnState(s, now); } catch { continue; }
      rows.push({
        sym, tier: ns.tier, pb: ns.pb, mz: ns.mz,
        dbl: !!ns.dbl, dblDir: ns.dblDir, dblType: ns.dblType,
        price: Math.round((st.price ?? 0) * 1e8) / 1e8,
        pct: Math.round((st.changePct ?? 0) * 100) / 100,
        vol: Math.round(st.quoteVolume ?? 0),
        rank: st.rank,
      });
    }

    const counts = {
      coins: rows.length,
      top: rows.filter(r => r.pb === 1).length,
      bottom: rows.filter(r => r.pb === -1).length,
      dbl: rows.filter(r => r.dbl).length,
      macUp: rows.filter(r => r.mz === 1).length,
      macDn: rows.filter(r => r.mz === -1).length,
      up: rows.filter(r => r.pct > 0).length,
      dn: rows.filter(r => r.pct < 0).length,
    };

    let arr = rows.filter(r => pb === 'all' ? true : pb === 'top' ? r.pb === 1 : r.pb === -1);
    // 先按用户选的口径排，再按分层稳定排序（零上回调置顶 / 零下反弹垫底）
    if (mode === 'loss') arr.sort((a, b) => a.pct - b.pct);
    else if (mode === 'vol') arr.sort((a, b) => b.vol - a.vol);
    else arr.sort((a, b) => b.pct - a.pct);
    arr.sort((a, b) => a.tier - b.tier);
    const picked = arr.slice(0, limit);

    // 画卡片用的K线：从服务端取，前端自己算均线和 MACD
    const items = picked.map(r => {
      const st = this.market.symbols.get(r.sym);
      const s = st.series[interval];
      const from = Math.max(0, s.t.length - bars);
      const k = [];
      for (let i = from; i < s.t.length; i++) k.push([s.t[i], s.o[i], s.h[i], s.l[i], s.c[i]]);
      return { ...r, interval, ms: s.ms, k };
    });

    return {
      generatedAt: now, interval, mode, pb, topN, limit, bars,
      counts, matched: arr.length, shown: items.length,
      intervals: NN_INTERVALS, items,
    };
  }

  /**
   * 单K策略的**平铺 K 线**数据：每个命中 (币种 × 级别) 出一张图，
   * 按级别轮转取，避免某一级别占满画面。
   */
  singleKCharts(bars = 120, limit = 24, input = {}) {
    const scan = this.singleKScan(input);
    // 图表与表格保持同一顺序：按大K出现时间从新到旧。
    // （以前为了照顾小级别做成「按级别轮转」，但那样会打乱时间顺序；
    //   现在用户要的是「最新状态排前面」，所以直接取前 limit 个。）
    const picked = scan.items.slice(0, limit);
    const items = [];
    for (const h of picked) {
      const lvl = this.levelPayload(this.market.symbols.get(h.symbol), h.level, bars);
      if (!lvl) continue;
      items.push({
        ...lvl, symbol: h.symbol, kind: 'single', side: h.dir || h.side,
        single: {
          level: h.level, levelLabel: h.levelLabel, rank: h.rank,
          side: h.dir || h.side,
          bodyPct: h.bodyPct, mult: h.mult, retracePct: h.retracePct,
          barsAfter: h.barsAfter, low: h.low, high: h.high, line: h.line,
          zeroSide: h.zeroSide, dif: h.dif,
          open: h.open, close: h.close,
          bigT: h.t, price: h.price, changePct: h.changePct, quoteVolume: h.quoteVolume,
          minClose: h.minClose, maxClose: h.maxClose, at: h.at,
        },
      });
    }
    return {
      generatedAt: scan.t, total: scan.total, shown: items.length, limit, bars,
      topN: scan.topN, levels: SINGLE_K_LEVELS, options: scan.options, items,
    };
  }

  /**
   * 策略：**单K推动 + 回调不破**（只扫涨幅榜前 N 名）
   *
   * 每个 (币种 × 级别 × 方向) 独立判定：
   *   多：大阳线之后回调，没跌破最低价，且回踩幅度小于涨幅
   *   空：大阴线之后反抽，没涨破最高价，且反抽幅度小于跌幅
   */
  singleKScan(input = {}) {
    const opt = singleKOptions(input, this.cfg);
    const now = Date.now();
    const items = [];
    for (const sym of this.market.universe) {
      const st = this.market.symbols.get(sym);
      if (!st?.seeded) continue;
      // 只监控涨幅榜前 N 名
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;
      for (const k of SINGLE_K_LEVELS) {
        const s = st.series?.[k];
        if (!s || s.t.length < 40) continue;
        let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
        while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
        if (ci < 30) continue;
        // 过期数据不入榜（与零轴监控同一套保护）
        if (now - (s.t[ci] + s.ms) >= s.ms + 90_000) continue;
        const label = (LEVELS.find(l => l.key === k) || {}).label || k;
        for (const dir of [1, -1]) {
          let hit = null;
          const ind = s.ensure ? s.ensure() : null;   // 零轴筛选要读 DIF
          try { hit = singleKAt(s, ci, opt, dir, ind); } catch { hit = null; }
          if (!hit) continue;
          items.push({
            symbol: sym, level: k, levelLabel: label, side: hit.dir,
            rank: st.rank, price: Math.round((st.price ?? 0) * 1e8) / 1e8,
            changePct: Math.round((st.changePct ?? 0) * 100) / 100,
            quoteVolume: Math.round(st.quoteVolume ?? 0),
            ...hit,
          });
        }
      }
    }
    // —— 按「最新状态」排序：大K出现得越晚越靠前 ——
    // 同一时间再按推动强度（涨跌幅）、回踩/反抽深浅排。
    // 这样列表最上面永远是刚刚形成、最值得看的形态。
    items.sort((a, b) => (b.t || 0) - (a.t || 0) || b.bodyPct - a.bodyPct || a.retracePct - b.retracePct);
    return {
      t: now, total: items.length, topN: opt.topN,
      longs: items.filter(i => i.side === 'long').length,
      shorts: items.filter(i => i.side === 'short').length,
      zeroAbove: items.filter(i => i.zeroSide === 'above').length,
      zeroBelow: items.filter(i => i.zeroSide === 'below').length,
      zeroSide: opt.zeroSide,
      levels: SINGLE_K_LEVELS, options: opt, items,
    };
  }

  zeroCharts(bars = 150, limit = 24, input = {}) {
    const {hits,snapshot}=this.zeroScan(input),items=[];
    for(const {sym,k,z} of hits.slice(0,limit)) {
      const st=this.market.symbols.get(sym),lvl=this.levelPayload(st,k,bars);
      if(!lvl) continue;
      items.push({...lvl,symbol:sym,kind:'zero',side:z.side>0?'long':'short',
        confirmed:true,signal:true,seeded:true,changePct:st.changePct??0,quoteVolume:st.quoteVolume??0,
        zeroNear:z.near,zeroHold:z.hold,zeroPull:z.pull,zeroDif:z.dif,zero:{...z}});
    }
    return {mode:'single',generatedAt:snapshot.t,total:hits.length,shown:items.length,limit,bars,
      nearCount:hits.length,levels:MONITOR_LEVEL_KEYS,cfg:snapshot.cfg,options:snapshot.options,items};
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
      // 单K报警要按单K的样式渲染：卡片头显示幅度/回踩/不破线，
      // 图上还要画出那根推动K线的标记和「不破线」横线。
      // 这里把 kind 归一成 'single' 并补一个 single 子对象（与 singleKCharts 同构）。
      const isSK = a.kind === 'singlek';
      items.push({
        ...lvl,
        symbol: a.symbol,
        alertId: a.id,
        kind: isSK ? 'single' : (a.kind ?? 'resonance'),
        side: a.side ?? null,
        // 形态提醒是「K线已收盘」的确认信号，用 closed 让卡片按已确认样式渲染
        mode: a.confirmed || a.kind === 'dual' || isSK ? 'closed' : a.mode,
        confirmed: !!a.confirmed || a.kind === 'dual' || isSK,
        pair: a.pair ?? null, sub: a.sub ?? null, main: a.main ?? null,
        score: a.score,
        group: a.group,
        base: a.base, mid: a.mid, big: a.big,
        at: a.ts ?? a.candleT,
        alertPrice: a.price ?? null,
        text: a.text ?? '',
        initial: !!a.initial,
        ...(isSK ? {
          single: {
            level: a.level, levelLabel: a.levelLabel, rank: a.rank,
            side: a.side, bodyPct: a.bodyPct, mult: a.mult, retracePct: a.retracePct,
            barsAfter: a.barsAfter, low: a.low, high: a.high, line: a.line,
            open: a.open, close: a.close, bigT: a.bigT,
            price: a.price, changePct: a.changePct, quoteVolume: a.quoteVolume,
            zeroSide: a.zeroSide, dif: a.dif, minClose: a.minClose, maxClose: a.maxClose,
            at: a.candleT,
          },
        } : {}),
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
      dual: { ...this.dualCount, seen: this.dualSeen.size, skippedByVolume: this.dualSkippedQv || 0, skippedByStale: this.dualSkippedStale || 0, tier: { ...this.dualTierCount }, tierSplit: this.cfg.dualTierSplit,
        star: this.dualStarCount || 0, starRank: this.cfg.dualStarRank, zeroPair: { count: this.zeroCount || 0, seen: this.zeroSeen.size, skippedStale: this.zeroSkippedStale || 0 },
        pairZero: { count: this.pairZeroCount || 0, seen: this.pairZeroSeen.size, skippedStale: this.pairZeroSkippedStale || 0, skippedByVolume: this.pairZeroSkippedQv || 0 },
        singleK: { count: this.singleKCount || 0, seen: this.singleKSeen.size, skippedStale: this.singleKSkippedStale || 0, skippedByVolume: this.singleKSkippedQv || 0, minQuoteVolume: this.cfg.singleKMinQuoteVolume }, cfg: {
        enabled: this.cfg.dualEnabled, levels: this.cfg.dualLevels, bars: this.cfg.dualBars,
        minQuoteVolume: this.cfg.dualMinQuoteVolume,
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
