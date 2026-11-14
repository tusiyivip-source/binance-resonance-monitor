/**
 * 引擎：定时评估全部标的 -> 生成/去重共振报警 -> 通过事件推送
 */
import { Emitter } from './emitter.js';
import { LEVELS, LEVEL_KEYS, LEVEL_INDEX, VISIBLE_LEVELS, STATE, EVENT, APP } from './config.js';
import { evaluateSymbol, describe, defaultSignalConfig, encodeZero } from './signals.js';
import { MONITOR_LEVEL_KEYS, ZERO_LEVEL_KEYS, ZERO_PAIRS, zeroOptions, zeroMonitorAt, zeroMatches, zeroPairHit, bigCandleSupport, compareZero } from './zero-monitor.js';
import { SINGLE_K_LEVELS, SINGLE_K_CONFIRM, confirmLevelOf, singleKOptions, singleKAt } from './single-k.js';
import { NN_INTERVALS, nnState } from './nn.js';
import { PAIR_ZERO_PAIRS, pairZeroOptions, levelZeroAt, pairZeroHit, comparePairZero } from './pair-zero.js';
import { reboundHit, reboundOptions, compareRebound } from './pair-rebound.js';
import { HALF_PAIRS, halfHit, halfOptions, compareHalf } from './chan-half.js';
import { DEAD_MA5_LEVELS, deadMa5At, zeroStateAt, deadMa5Options, compareDeadMa5 } from './dead-ma5.js';
import { CROSS_PB_LEVELS, crossPullbackAt, crossPbOptions, compareCrossPb } from './cross-pullback.js';
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
    try { this.crossPbAlertSweep(); } catch (e) { this.log?.warn?.('阳内阴报警异常：' + (e && e.message)); }
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
   * 报警扫描：同时产出两套策略的报警。
   *
   *   A) 连跌 N 根 · 首次收阳      variant=first
   *   B) 零上死叉中 · 阳K站上MA5   variant=state
   *
   * 两套各自按 (币种|级别|变体) 做状态跃迁，互不干扰；
   * 报警进历史（配对全景要用），但不推钉钉（noPush）。
   */
  /**
   * 「阳内阴 / 阴内阳」的报警扫描 —— 钉钉只推这一套。
   *
   * 只扫 crossPbAlertLevels 里的级别（默认 30分 / 1小时 / 2小时），两个方向都推：
   *   阳内阴（做多）：阳线之后一根被它完全包含、且没跌破它最低价的阴线
   *   阴内阳（做空）：镜像
   *
   * 每根K线只报一次：key = 币种|级别|方向|该K线收盘时间
   */
  crossPbAlertSweep() {
    if (this.cfg.crossPbAlertEnabled !== true) return;
    const levels = Array.isArray(this.cfg.crossPbAlertLevels) ? this.cfg.crossPbAlertLevels : ['30m', '1h', '2h'];
    // 钉钉只推「单K包覆」这两种（阳内阴 / 阴内阳）；双K结构只在页面看
    const opt = crossPbOptions({ pattern: this.cfg.crossPbAlertPattern || 'inner' }, this.cfg);
    const maxStale = (this.cfg.crossPbAlertStaleSec ?? 120) * 1000;
    const now = Date.now();
    if (!this.crossPbSeen) this.crossPbSeen = new Map();
    for (const st of this.market.symbols.values()) {
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;
      for (const k of levels) {
        const s = st.series?.[k];
        if (!s || s.t.length < 20) continue;
        let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
        while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
        if (ci < 2) continue;
        const closedAt = s.t[ci] + s.ms;
        if (now - closedAt > maxStale) continue;
        let ind = null;
        try { ind = s.ensure(); } catch { ind = null; }
        let hits = [];
        try { hits = crossPullbackAt(s, ind, ci, opt) || []; } catch { hits = []; }
        for (const h of hits) {
          const key = st.symbol + '|' + k + '|' + h.dir + '|' + closedAt;
          if (this.crossPbSeen.has(key)) continue;
          this.crossPbSeen.set(key, now);
          const label = (LEVELS.find(l => l.key === k) || {}).label || k;
          const a = {
            kind: 'crosspb', id: ++this.alertSeq, symbol: st.symbol,
            mode: 'closed', noPush: false,
            level: k, levelLabel: label,
            sub: k, main: k, pair: label, subLabel: label, mainLabel: '',
            side: h.dir, dir: h.dir, confirmed: true, score: 0,
            rank: st.rank ?? 0,
            price: Math.round((st.price ?? 0) * 1e8) / 1e8,
            changePct: Math.round((st.changePct ?? 0) * 100) / 100,
            quoteVolume: Math.round(st.quoteVolume ?? 0),
            variant: h.variant, variantLabel: h.variantLabel,
            axisSide: h.axisSide, dif: h.crossDif, dea: h.crossDea,
            open: h.open, close: h.close, high: h.high, low: h.low,
            prevOpen: h.prevOpen, prevClose: h.prevClose, prevHigh: h.prevHigh, prevLow: h.prevLow,
            retrace: h.surge?.retrace, bodyPct: h.surge?.gainPct,
            ts: closedAt, candleT: s.t[ci],
            text: h.variant === 'long'
              ? label + ' 阳内阴：阴线收 ' + h.close + '，被阳线 ' + h.prevOpen + '→' + h.prevClose + ' 包住，回吐 ' + h.surge?.retrace + '%'
              : label + ' 阴内阳：阳线收 ' + h.close + '，被阴线 ' + h.prevOpen + '→' + h.prevClose + ' 包住，收回 ' + h.surge?.retrace + '%',
          };
          this.alerts.push(a);
          this.signalCount++;
          this.emit('alert', a);
          this.log.signal('🔔 ' + a.symbol + ' ' + a.text);
        }
      }
    }
    if (this.crossPbSeen.size > 4000) {
      const keys = [...this.crossPbSeen.keys()].slice(0, this.crossPbSeen.size - 4000);
      for (const kk of keys) this.crossPbSeen.delete(kk);
    }
  }

  pairZeroAlertSweep() {
    const opt = deadMa5Options({}, this.cfg);
    const maxStale = (this.cfg.pairZeroAlertStaleSec ?? 120) * 1000;
    const minQv = this.cfg.pairZeroMinQuoteVolume ?? 0;
    const now = Date.now();
    for (const st of this.market.symbols.values()) {
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;
      for (const k of DEAD_MA5_LEVELS) {
        const s = st.series?.[k];
        let ci = -1, first = null, state = null;
        if (s && s.t.length >= 40) {
          ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
          while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
          if (ci >= 30) {
            let ind = null;
            try { ind = s.ensure(); } catch { ind = null; }
            if (ind) {
              try { first = deadMa5At(s, ind, ci, opt); } catch { first = null; }
              try { state = zeroStateAt(s, ind, ci, opt); } catch { state = null; }
            }
          }
        }
        const hits = [first && { v: 'first', h: first }, state && { v: 'state', h: state }].filter(Boolean);

        for (const v of ['first', 'state']) {
          const onKey = st.symbol + '|' + k + '|' + v;
          const found = hits.find(x => x.v === v);
          if (!found) {
            if (this.pairZeroOn.get(onKey) === true) this.pairZeroOn.set(onKey, false);
            continue;
          }
          if (this.pairZeroOn.get(onKey) === true) continue;   // 状态持续中
          const h = found.h;
          const closedAt = s.t[ci] + s.ms;
          if (maxStale > 0 && now - closedAt > maxStale) { this.pairZeroSkippedStale++; continue; }
          if (minQv > 0 && !(Number(st.quoteVolume) >= minQv)) { this.pairZeroSkippedQv++; continue; }

          this.pairZeroOn.set(onKey, true);
          const key = 'dz|' + onKey + '|' + closedAt;
          if (this.pairZeroSeen.has(key)) continue;
          this.pairZeroSeen.set(key, now);

          const label = (LEVELS.find(l => l.key === k) || {}).label || k;
          const a = {
            kind: 'pairzero', id: ++this.alertSeq, symbol: st.symbol, mode: 'closed',
            noPush: this.cfg.pairZeroAlertEnabled === false,
            level: k, levelLabel: label,
            sub: k, main: k, pair: label, subLabel: label, mainLabel: '',
            side: 'long', dir: 'long', confirmed: true, score: 0,
            rank: st.rank ?? 0,
            price: Math.round((st.price ?? 0) * 1e8) / 1e8,
            changePct: Math.round((st.changePct ?? 0) * 100) / 100,
            quoteVolume: Math.round(st.quoteVolume ?? 0),
            variant: h.variant, variantLabel: h.variantLabel,
            subPullBars: h.downBars ?? h.barsSinceDead,
            mainDif: h.dif, subDif: h.ma5,
            dif: h.dif, dea: h.dea, ma5: h.ma5,
            deadT: h.deadT, deadDif: h.deadDif, deadDea: h.deadDea,
            barsSinceDead: h.barsSinceDead, downBars: h.downBars,
            open: h.open, close: h.close, bodyPct: h.bodyPct,
            ts: closedAt, candleT: s.t[ci],
            text: h.variant === 'state'
              ? `${label} 零上死叉中（柱 ${h.hist}），阳线收 ${h.close} 站上 MA5 ${h.ma5}`
              : `${label} 零上死叉（DIF ${h.deadDif}）后连跌 ${h.downBars} 根，首次收阳 ${h.close}`,
          };
          this.alerts.push(a);
          this.signalCount++;
          this.pairZeroCount++;
          this.emit('alert', a);
          this.log.signal('🔴 ' + a.symbol + ' ' + a.text);
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
        // 只做多的「单K不破」时，不再扫空的「反弹」那一支
        const dirs = this.cfg.singleKLongOnly === false ? [1, -1] : [1];
        for (const dir of dirs) {
          const onKey = st.symbol + '|' + k + '|' + dir;
          let hit = null;
          const ind = s.ensure ? s.ensure() : null;   // 零轴筛选要读 DIF
          try { hit = singleKAt(s, ci, opt, dir, ind); } catch { hit = null; }
          const wasOn = this.singleKOn.get(onKey) === true;
          // 上级确认（例如 15分 → 2时 必须金叉同向）——
          // 和页面用的是同一个判定，保证「推出去的就是页面上看到的」
          const conf = hit ? this.singleKConfirm(st, k, dir, now) : null;
          if (!hit || !conf) { if (wasOn) this.singleKOn.set(onKey, false); continue; }
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
            barsAfter: hit.barsAfter, line: hit.line, bigT: hit.t, confirm: conf,
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
   * 配对全景屏的数据：**已经推送过（已提醒）**的全部配对信号，去重后出图。
   *
   * 与 pairZeroCharts 的区别：
   *   pairZeroCharts —— 当前时刻还在成立的信号（实时状态）
   *   pairGridData   —— 报警历史里出现过的信号（已经提醒过的那批）
   * 只读，不产生任何新报警。
   */
  pairGridData(bars = 120, limit = 200, pins = []) {
    const now = Date.now();
    const seen = new Map();          // 去重：同一 (币种|配对|方向) 只留最新一条
    for (const a of this.alerts) {
      if (a.kind !== 'pairzero') continue;
      const key = a.symbol + '|' + a.pair + '|' + a.side;
      const prev = seen.get(key);
      if (!prev || (a.ts || 0) > (prev.ts || 0)) seen.set(key, a);
    }
    // 时间正序：最早提醒的在前，**新产生的排到最后**（用户要求新信号落到底部）
    const list = [...seen.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
    const items = [];
    const cap = Math.max(1, Math.min(400, Number(limit) || 200));
    for (const a of list) {
      if (items.length >= cap) break;
      const st = this.market.symbols.get(a.symbol);
      if (!st) continue;
      const lvl = this.levelPayload(st, a.sub, bars);
      if (!lvl) continue;
      items.push({
        ...lvl, symbol: a.symbol, kind: 'pair', side: a.side,
        pair: {
          sub: a.sub, main: a.main, pair: a.pair,
          subLabel: a.subLabel, mainLabel: a.mainLabel,
          dir: a.side, rank: a.rank,
          mainDif: a.mainDif, mainHold: a.mainHold,
          subDif: a.subDif, subHold: a.subHold,
          subPullBars: a.subPullBars, subPeak: a.subPeak, subPeakT: null, subAt: a.candleT,
          levelLabel: a.levelLabel, barsSinceDead: a.barsSinceDead,
          variant: a.variant, variantLabel: a.variantLabel,
          ma5: a.ma5, deadDif: a.deadDif, deadDea: a.deadDea, deadT: a.deadT, close: a.close, downBars: a.downBars, barsSinceDead: a.barsSinceDead,
          price: a.price, changePct: a.changePct,
          quoteVolume: Math.round(st.quoteVolume ?? 0),   // 24h 成交额（实时取，不用报警里那份旧的）
          alertedAt: a.ts,
        },
      });
    }

    // 记住被固定的币种，交给 market 保住它的行情状态
    // （跌出涨跌幅榜/成交额榜时 symbols 会被删掉，卡片就没数据、凭空消失）
    this.pinnedSince = this.pinnedSince || new Map();
    for (const raw of (Array.isArray(pins) ? pins : [])) {
      const sym = String(raw).split('|')[1];
      if (sym) this.pinnedSince.set(sym, now);
    }
    for (const [sym, ts] of this.pinnedSince) {
      if (now - ts > 30 * 60_000) this.pinnedSince.delete(sym);   // 半小时没再请求就放开
    }
    this.market.pinnedKeep = new Set(this.pinnedSince.keys());

    /* 用户「固定」的面板：即使它的报警已经从历史里过期清掉，也一定要画出来，
     * 否则钉住的图会突然消失。这里用当前行情现算一份元信息补上。 */
    const have = new Set(items.map(it => it.symbol + '|' + it.pair.sub + '-' + it.pair.main));
    for (const raw of (Array.isArray(pins) ? pins : [])) {
      const parts = String(raw).split('|');
      if (parts[0] !== 'p' || parts.length < 3) continue;
      const sym = parts[1], pairStr = parts[2];
      const cut = pairStr.indexOf('-');
      if (cut <= 0) continue;
      const sub = pairStr.slice(0, cut), main = pairStr.slice(cut + 1);
      if (have.has(sym + '|' + sub + '-' + main)) continue;
      const st = this.market.symbols.get(sym);
      if (!st) continue;
      const lvl = this.levelPayload(st, sub, bars);
      if (!lvl) continue;

      // 现算主/次级别状态（拿不到就留空，不影响画图）
      let subZ = null, mainZ = null;
      try {
        const subS = st.series?.[sub], mainS = st.series?.[main];
        const ci = s => {
          if (!s) return -1;
          let i = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
          while (i >= 0 && s.t[i] + s.ms > now) i--;
          return i;
        };
        const a1 = ci(subS), a2 = ci(mainS);
        if (a1 >= 35) subZ = levelZeroAt(subS, subS.ensure(), a1);
        if (a2 >= 35) mainZ = levelZeroAt(mainS, mainS.ensure(), a2);
      } catch { /* 忽略 */ }

      const dir = (subZ && subZ.side < 0) ? 'short' : 'long';
      const lab = k => (LEVELS.find(l => l.key === k) || {}).label || k;
      items.push({
        ...lvl, symbol: sym, kind: 'pair', side: dir,
        pair: {
          sub, main, pair: sub + '-' + main,
          subLabel: lab(sub), mainLabel: lab(main),
          dir, rank: st.rank ?? 0,
          mainDif: mainZ ? mainZ.dif : null, mainHold: mainZ ? mainZ.hold : null,
          subDif: subZ ? subZ.dif : null, subHold: subZ ? subZ.hold : null,
          subPullBars: subZ ? subZ.pullBars : null, subPeak: subZ ? subZ.peak : null,
          subPeakT: subZ ? subZ.peakT : null, subAt: subZ ? subZ.at : null,
          price: Math.round((st.price ?? 0) * 1e8) / 1e8,
          changePct: Math.round((st.changePct ?? 0) * 100) / 100,
          quoteVolume: Math.round(st.quoteVolume ?? 0),   // 24h 成交额
          alertedAt: null,
          pinnedOnly: true,     // 标记：这条只是被固定，当前未必还成立
        },
      });
    }

    return {
      generatedAt: now, total: list.length, shown: items.length,
      limit: cap, bars, items,
    };
  }

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
          mainDif: h.deadDif, mainHold: null,     // 零轴上死叉那一刻的 DIF
          subDif: h.ma5, subHold: null,             // 复用旧字段承载 MA5
          subPullBars: h.barsSinceDead, subPeak: null, subPeakT: null, subAt: h.deadT,
          levelLabel: h.levelLabel, barsSinceDead: h.barsSinceDead,
          variant: h.variant, variantLabel: h.variantLabel,
          ma5: h.ma5, deadDif: h.deadDif, deadDea: h.deadDea, deadT: h.deadT, close: h.close, downBars: h.downBars,
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
   * 「背驰 50%」策略：多级别（6 组配对）+ 缠论笔 + 50% 分位。
   *
   * 方向固定对应：主级别 DIF 零轴上 → 只做多（找向下一笔的反弹）；
   *               零轴下 → 只做空（找向上一笔的回落）。
   *
   * 次级别：最后一笔高低点之间 ≥5 根K线，且回调/反弹 ≥5 根；
   *         价格最近 2 根已收盘K线内越过该笔的 50%（high+low)/2。
   *
   * 提醒分两种，都产出：
   *   mode1 = 背驰 + 突破 50%（MACD 面积比前一笔小且创新低/新高）
   *   mode2 = 单纯突破 50%
   *
   * 只读、不推送。
   */
  chanHalfCharts(bars = 120, limit = 200, input = {}) {
    const opt = halfOptions(input, this.cfg);
    const now = Date.now();
    const hits = [];

    for (const sym of this.market.universe) {
      const st = this.market.symbols.get(sym);
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;

      // 主级别只要 DIF 的正负，按 key 缓存
      const zcache = new Map();
      const axisOf = key => {
        if (zcache.has(key)) return zcache.get(key);
        const s = st.series?.[key];
        let out = null;
        if (s && s.t.length >= 40) {
          let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
          while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
          if (ci >= 35) {
            try {
              const z = levelZeroAt(s, s.ensure(), ci);
              if (z) out = z.dif > 0 ? 'above' : 'below';
            } catch { out = null; }
          }
        }
        zcache.set(key, out);
        return out;
      };

      for (const p of HALF_PAIRS) {
        const axis = axisOf(p.main);
        if (!axis) continue;
        if (opt.axis !== 'all' && axis !== opt.axis) continue;
        const side = axis === 'above' ? 'down' : 'up';

        const subS = st.series?.[p.sub];
        if (!subS || subS.t.length < 40) continue;
        let ci = Math.min(subS.lastClosedIndex ?? subS.t.length - 1, subS.t.length - 1);
        while (ci >= 0 && subS.t[ci] + subS.ms > now) ci--;
        if (ci < 40) continue;

        let hit = null;
        try {
          const chan = subS.ensureChan(opt.minBars);
          hit = halfHit(chan, subS, ci, side, opt);
        } catch { hit = null; }
        if (!hit) continue;
        if (opt.mode === '1' && !hit.mode1) continue;
        if (opt.mode === '2' && !hit.mode2) continue;

        hits.push({
          symbol: sym,
          sub: p.sub, main: p.main, pair: p.sub + '-' + p.main,
          subLabel: (LEVELS.find(l => l.key === p.sub) || {}).label || p.sub,
          mainLabel: (LEVELS.find(l => l.key === p.main) || {}).label || p.main,
          rank: st.rank,
          axis,
          dir: side === 'down' ? 'long' : 'short',
          price: Math.round((st.price ?? 0) * 1e8) / 1e8,
          changePct: Math.round((st.changePct ?? 0) * 100) / 100,
          quoteVolume: Math.round(st.quoteVolume ?? 0),
          ...hit,
        });
      }
    }

    hits.sort(compareHalf);
    const cap = Math.max(1, Math.min(400, Number(limit) || 200));
    const items = [];
    for (const h of hits.slice(0, cap)) {
      const st = this.market.symbols.get(h.symbol);
      const lvl = st && this.levelPayload(st, h.sub, bars);
      if (!lvl) continue;
      items.push({
        ...lvl, symbol: h.symbol, kind: 'half', side: h.dir,
        pair: {
          sub: h.sub, main: h.main, pair: h.pair,
          subLabel: h.subLabel, mainLabel: h.mainLabel,
          dir: h.dir, rank: h.rank, axis: h.axis,
          price: h.price, changePct: h.changePct, quoteVolume: h.quoteVolume,
          stroke: h.stroke, pullBars: h.pullBars, crossAt: h.crossAt,
          crossPct: h.crossPct, divergence: h.divergence,
          mode1: h.mode1, mode2: h.mode2, label: h.label,
        },
      });
    }

    return {
      generatedAt: now, total: hits.length,
      longs: hits.filter(i => i.dir === 'long').length,
      shorts: hits.filter(i => i.dir === 'short').length,
      mode1: hits.filter(i => i.mode1).length,
      mode2: hits.filter(i => !i.mode1).length,
      shown: items.length, limit: cap, bars,
      options: opt, pairs: HALF_PAIRS, items,
    };
  }

  /**
   * 「金叉回踩 / 死叉反弹」策略。
   *
   * 多级别（15分~12小时）各自独立：
   *   做多：金叉后走出阳线，回踩第 N 根阴线 → 提醒
   *   做空：死叉后走出阴线，反弹第 N 根阳线 → 提醒
   *
   * @param {object} input { depth: 1|2, axis: 'all'|'above'|'below' }
   */
  crossPullbackCharts(bars = 120, limit = 200, input = {}) {
    const opt = crossPbOptions(input, this.cfg);
    const now = Date.now();
    const items = [];
    for (const sym of this.market.universe) {
      const st = this.market.symbols.get(sym);
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;
      for (const k of CROSS_PB_LEVELS) {
        if (opt.level !== 'all' && k !== opt.level) continue;   // 级别筛选
        const s = st.series?.[k];
        if (!s || s.t.length < 40) continue;
        let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
        while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
        if (ci < 30) continue;
        // 必须基于**最新一根已收盘K线**：数据超过一个周期没更新（停更/缓存过期）就不算
        if (now - (s.t[ci] + s.ms) >= s.ms + 90_000) continue;
        let ind = null;
        try { ind = s.ensure(); } catch { ind = null; }
        if (!ind) continue;
        let hits = [];
        try { hits = crossPullbackAt(s, ind, ci, opt) || []; } catch { hits = []; }
        if (!Array.isArray(hits) || !hits.length) continue;
        const label = (LEVELS.find(l => l.key === k) || {}).label || k;
        const lvl = this.levelPayload(st, k, bars);
        if (!lvl) continue;
        for (const hit of hits) {
          items.push({
            ...lvl, symbol: sym, kind: 'crosspb', side: hit.dir, at: hit.at,
            pair: {
              sub: k, main: k, pair: label, subLabel: label, mainLabel: '',
              levelLabel: label, dir: hit.dir, rank: st.rank,
              crossDif: hit.crossDif, crossDea: hit.crossDea, crossT: hit.crossT,
              axisSide: hit.axisSide, depth: hit.depth,
              barsSinceCross: hit.barsSinceCross, pullFirst: hit.pullFirst, surge: hit.surge,
              open: hit.open, close: hit.close, pivot: hit.pivot,
              variant: hit.variant, variantLabel: hit.variantLabel, depthLabel: hit.depthLabel,
              price: Math.round((st.price ?? 0) * 1e8) / 1e8,
              changePct: Math.round((st.changePct ?? 0) * 100) / 100,
              quoteVolume: Math.round(st.quoteVolume ?? 0),
            },
          });
        }
      }
    }
    items.sort((x, y) => compareCrossPb(
      { at: x.at, retrace: x.pair.surge?.retrace, quoteVolume: x.pair.quoteVolume },
      { at: y.at, retrace: y.pair.surge?.retrace, quoteVolume: y.pair.quoteVolume }));
    const cap = Math.max(1, Math.min(400, Number(limit) || 200));
    return {
      generatedAt: now, total: items.length,
      longs: items.filter(i => i.side === 'long').length,
      shorts: items.filter(i => i.side === 'short').length,
      shown: Math.min(items.length, cap), limit: cap, bars,
      options: opt, levels: CROSS_PB_LEVELS,
      items: items.slice(0, cap),
    };
  }


  /**
   * 「配对反转提醒」：配对共振成立 **且** 次级别满足反转条件。
   *
   * 与 pairZeroCharts 的区别：
   *   · 不看报警历史，而是**实时**用当前行情算（本页不推送，只在界面看）
   *   · 在共振成立的基础上，额外要求次级别「回踩 ≥ N 根 + 连续两根阳K + 低点抬高」
   *
   * @param {number} bars 每张图画多少根K线
   * @param {number} limit 最多返回多少条
   * @param {object} input 覆盖项：minPullBars / topN / side
   */
  pairReboundCharts(bars = 120, limit = 200, input = {}) {
    const opt = reboundOptions(input, this.cfg);
    const zopt = pairZeroOptions(input, this.cfg);
    const now = Date.now();
    const hits = [];

    for (const sym of this.market.universe) {
      const st = this.market.symbols.get(sym);
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;

      // 同一个币的级别只算一次（七组配对共用），顺带把 series 和收盘下标留住
      const cache = new Map();
      const zof = key => {
        if (cache.has(key)) return cache.get(key);
        const s = st.series?.[key];
        let out = null;
        if (s && s.t.length >= 40) {
          let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
          while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
          if (ci >= 35) {
            try {
              const z = levelZeroAt(s, s.ensure(), ci);
              if (z) out = { z, series: s, idx: ci };
            } catch { out = null; }
          }
        }
        cache.set(key, out);
        return out;
      };

      for (const p of PAIR_ZERO_PAIRS) {
        const sub = zof(p.sub), main = zof(p.main);
        if (!sub || !main) continue;
        for (const dir of [1, -1]) {
          const hit = pairZeroHit(sub.z, main.z, dir, zopt);
          if (!hit) continue;
          if (opt.side !== 'all' && hit.dir !== opt.side) continue;
          // 反转头只认次级别：主级别管方向，次级别管时机
          const rb = reboundHit(sub.series, sub.idx, dir, opt.minPullBars, hit.subPullBars);
          if (!rb) continue;
          hits.push({
            symbol: sym,
            sub: p.sub, main: p.main, pair: p.sub + '-' + p.main,
            subLabel: (LEVELS.find(l => l.key === p.sub) || {}).label || p.sub,
            mainLabel: (LEVELS.find(l => l.key === p.main) || {}).label || p.main,
            rank: st.rank,
            price: Math.round((st.price ?? 0) * 1e8) / 1e8,
            changePct: Math.round((st.changePct ?? 0) * 100) / 100,
            quoteVolume: Math.round(st.quoteVolume ?? 0),
            subMinutes: (LEVELS.find(l => l.key === p.sub) || {}).minutes || 15,
            ...hit,
            rebound: rb,
          });
        }
      }
    }

    hits.sort(compareRebound);
    const cap = Math.max(1, Math.min(400, Number(limit) || 200));
    const items = [];
    for (const h of hits.slice(0, cap)) {
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
          quoteVolume: h.quoteVolume,
          rebound: h.rebound,
        },
      });
    }

    return {
      generatedAt: now, total: hits.length,
      longs: hits.filter(i => i.dir === 'long').length,
      shorts: hits.filter(i => i.dir === 'short').length,
      shown: items.length, limit: cap, bars,
      options: opt, pairs: PAIR_ZERO_PAIRS, items,
    };
  }

  /**
   * 「零轴上死叉 → 回调 → 阳K站上 MA5」扫描。
   *
   * 替换了原来的配对共振逻辑。监控级别：
   *   15分 / 30分 / 1小时 / 2小时 / 3小时 / 6小时 / 12小时
   *
   * 每个 (币种 × 级别) 独立判定，只做多：
   *   零轴上死叉 → 死叉后 ≥N 根 → 出现阳线 → 收盘刚上穿 MA5
   */
  pairZeroScan(input = {}) {
    const opt = deadMa5Options(input, this.cfg);
    const now = Date.now();
    const items = [];
    for (const sym of this.market.universe) {
      const st = this.market.symbols.get(sym);
      if (!st?.seeded) continue;
      if (!(st.rank > 0 && st.rank <= opt.topN)) continue;
      for (const k of DEAD_MA5_LEVELS) {
        const s = st.series?.[k];
        if (!s || s.t.length < 40) continue;
        let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
        while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
        if (ci < 30) continue;
        // 必须基于**最新一根已收盘K线**：数据超过一个周期没更新就不算
        if (now - (s.t[ci] + s.ms) >= s.ms + 90_000) continue;
        let ind = null;
        try { ind = s.ensure(); } catch { ind = null; }
        if (!ind) continue;
        // 两套策略并列：A 连跌N根·首次收阳 / B 零上死叉中·阳K站上MA5
        let first = null, state = null;
        try { first = deadMa5At(s, ind, ci, opt); } catch { first = null; }
        try { state = zeroStateAt(s, ind, ci, opt); } catch { state = null; }
        const label = (LEVELS.find(l => l.key === k) || {}).label || k;
        for (const hit of [first, state]) {
          if (!hit) continue;
          items.push({
            symbol: sym,
            level: k, levelLabel: label,
            // 兼容前端既有字段：单级别策略，sub/main 都指向同一个级别
            sub: k, main: k, pair: label,
            subLabel: label, mainLabel: '',
            rank: st.rank,
            price: Math.round((st.price ?? 0) * 1e8) / 1e8,
            changePct: Math.round((st.changePct ?? 0) * 100) / 100,
            quoteVolume: Math.round(st.quoteVolume ?? 0),
            ...hit,
          });
        }
      }
    }
    items.sort(compareDeadMa5);
    return {
      t: now, total: items.length,
      longs: items.length, shorts: 0,
      pairs: DEAD_MA5_LEVELS, options: opt, items,
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
          confirm: h.confirm || null,
        },
      });
    }
    return {
      generatedAt: scan.t, total: scan.total, shown: items.length, limit, bars,
      topN: scan.topN, levels: SINGLE_K_LEVELS, options: scan.options, items,
    };
  }

  /**
   * 单K的「上级确认」：确认级别要和单K同方向，并且该级别处于对应的交叉状态。
   *
   *   做多：确认级别 DIF > DEA（金叉状态）
   *   做空：确认级别 DIF < DEA（死叉状态）
   *
   * @returns {object|null} 命中返回可展示的信息，否则 null
   */
  singleKConfirm(st, level, dir, now) {
    const key = confirmLevelOf(level);
    if (!key) return null;
    const s = st.series?.[key];
    if (!s || s.t.length < 40) return null;
    let ci = Math.min(s.lastClosedIndex ?? s.t.length - 1, s.t.length - 1);
    while (ci >= 0 && s.t[ci] + s.ms > now) ci--;
    if (ci < 35) return null;
    let ind = null;
    try { ind = s.ensure(); } catch { return null; }
    const m = ind?.macd;
    if (!m) return null;
    const dif = m.dif[ci], dea = m.dea[ci];
    if (!Number.isFinite(dif) || !Number.isFinite(dea)) return null;
    const golden = dif > dea;                 // 金叉状态（DIF 在 DEA 上方）
    const agree = dir > 0 ? golden : !golden; // 做多要金叉，做空要死叉
    if (!agree) return null;
    return {
      level: key,
      label: (LEVELS.find(l => l.key === key) || {}).label || key,
      dif: Math.round(dif * 1e8) / 1e8,
      dea: Math.round(dea * 1e8) / 1e8,
      golden,
      agree,
      cross: golden ? '金叉' : '死叉',
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
        // 只做多的「单K不破」时，不再扫空的「反弹」那一支
        const dirs = this.cfg.singleKLongOnly === false ? [1, -1] : [1];
        for (const dir of dirs) {
          let hit = null;
          const ind = s.ensure ? s.ensure() : null;   // 零轴筛选要读 DIF
          try { hit = singleKAt(s, ci, opt, dir, ind); } catch { hit = null; }
          if (!hit) continue;
          // 上级确认：不同方向或确认级别没有对应交叉状态的，直接丢弃
          const conf = this.singleKConfirm(st, k, dir, now);
          if (!conf) continue;
          items.push({
            symbol: sym, level: k, levelLabel: label, side: hit.dir, confirm: conf,
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
      pinned: {
        // 被固定的币种：pinnedSince 是我们记的，pinnedKeep 是交给 market 的
        since: (this.pinnedSince ? this.pinnedSince.size : 0),
        keep: (this.market.pinnedKeep ? this.market.pinnedKeep.size : 0),
        list: this.pinnedSince ? [...this.pinnedSince.keys()] : [],
        inUniverse: this.pinnedSince
          ? [...this.pinnedSince.keys()].filter(s => this.market.universe.includes(s))
          : [],
      },
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
