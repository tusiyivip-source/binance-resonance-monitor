/**
 * 多级别共振信号引擎
 *
 * 逻辑来源（用户需求）：
 *   1. 至少 3 个级别处于「多头排列」；
 *   2. 基准级别（如 3分钟）先「回踩」MA7，随后收盘「上穿/站上 MA7 与 EMA7」；
 *   3. 相邻级别（如 5分钟）同步「上穿均线」确认；
 *   4. 组合中的最大级别（如 2小时）不得「跌破均线」。
 *   该标准对任意 (基准, 相邻, 最大) 级别三元组通用。
 */
import { LEVELS, LEVEL_INDEX, LEVEL_KEYS, STATE, EVENT, DEFAULT_SIGNAL } from './config.js';

const LIVE_DROP_TOL = 0.006; // 回踩K线允许收盘略低于 MA7 的幅度

/** 读取某序列在索引 i 处的完整快照 */
function at(series, ind, i) {
  if (i < 0 || i >= series.t.length) return null;
  const num = v => (Number.isFinite(v) ? v : null);
  return {
    i,
    t: series.t[i],
    o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i], v: series.v[i],
    done: series.done[i],
    ma7: num(ind.ma7[i]), ma25: num(ind.ma25[i]), ma99: num(ind.ma99[i]),
    ema7: num(ind.ema7[i]), ema25: num(ind.ema25[i]),
    volMa20: num(ind.volMa20[i]),
  };
}

function findCrossUp(series, ma, idx, maxBack) {
  for (let k = 0; k <= maxBack; k++) {
    const i = idx - k;
    if (i - 1 < 0) return null;
    const a = ma[i], b = ma[i - 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (series.c[i] > a && series.c[i - 1] <= b) return k;
  }
  return null;
}

function findCrossDown(series, ma, idx, maxBack) {
  for (let k = 0; k <= maxBack; k++) {
    const i = idx - k;
    if (i - 1 < 0) return null;
    const a = ma[i], b = ma[i - 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (series.c[i] < a && series.c[i - 1] >= b) return k;
  }
  return null;
}

/** 回踩：上行走势中，K线最低价触及/逼近 MA7，但收盘未有效跌破 */
function findPullback(series, ma, idx, maxBack, tol) {
  for (let k = 0; k <= maxBack; k++) {
    const i = idx - k;
    if (i - 1 < 0) return null;
    const m = ma[i], pm = ma[i - 1];
    if (!Number.isFinite(m) || !Number.isFinite(pm)) continue;
    const touched = series.l[i] <= m * (1 + tol);
    const held = series.c[i] >= m * (1 - LIVE_DROP_TOL);
    const trendUp = series.c[i - 1] > pm; // 回踩前必须站在 MA7 之上
    if (touched && held && trendUp) {
      return { bars: k, depth: (m - series.l[i]) / m };
    }
  }
  return null;
}

/**
 * 分析单个级别。
 * @param {import('./series.js').CandleSeries} series
 * @param {'closed'|'live'} mode closed=只用已收盘K线（不重绘）；live=含正在形成的K线（预警）
 */
export function analyzeLevel(series, cfg, mode) {
  const n = series.t.length;
  if (n < 40) return null;
  const ind = series.ensure();
  const ci = series.done[n - 1] ? n - 1 : n - 2;
  const idx = mode === 'live' ? n - 1 : ci;
  if (idx < 30 || ci < 25) return null;

  const cur = at(series, ind, idx);
  const prev = at(series, ind, idx - 1);
  if (!cur || !prev || cur.ma7 == null || cur.ma25 == null || prev.ma7 == null) return null;

  const ma7Up = cur.ma7 > prev.ma7;
  let code;
  if (cur.c > cur.ma7 && cur.ma7 > cur.ma25) code = STATE.BULL_ALIGN;
  else if (cur.c > cur.ma7) code = STATE.BULL;
  else if (cur.c < cur.ma7 && cur.ma7 > cur.ma25) code = STATE.WEAK;
  else if (cur.c < cur.ma7 && cur.ma7 <= cur.ma25) code = STATE.BEAR_ALIGN;
  else code = STATE.NEUTRAL;

  const crossUp7In = findCrossUp(series, ind.ma7, idx, 20);
  const crossUpEma7In = findCrossUp(series, ind.ema7, idx, 20);
  const crossDown7In = findCrossDown(series, ind.ma7, idx, 20);
  const pb = findPullback(series, ind.ma7, idx, 20, cfg.pullbackTolerance);

  // —— 缠论背驰（只在启用过滤时才算，避免无谓开销） ——
  let chanState = null;
  if (cfg.filterBeichi) {
    chanState = series.beichiState(idx, {
      minBars: cfg.beichiMinBars ?? 5,
      ratio: cfg.beichiRatio ?? 1.0,
      minProgress: cfg.beichiMinProgress ?? 0.3,
    });
  }
  // —— 笔状态（回踩成笔链用） ——
  let stroke = null;
  if (cfg.requireStrokeChain) stroke = series.strokeInfo(idx, cfg.beichiMinBars ?? 5);

  return {
    key: series.key,
    code,
    close: cur.c,
    ma7: cur.ma7, ma25: cur.ma25, ma99: cur.ma99,
    ema7: cur.ema7, ema25: cur.ema25,
    ma7Up,
    above7: cur.c > cur.ma7,
    aboveEma7: cur.ema7 != null ? cur.c > cur.ema7 : null,
    bull: cur.c > cur.ma7 && cur.ma7 > cur.ma25,
    bullAlign: cur.c > cur.ma7 && cur.ma7 > cur.ma25 && ma7Up,
    bearAlign: cur.c < cur.ma7 && cur.ma7 < cur.ma25,
    crossUp7In,
    crossUpEma7In,
    crossDown7In,
    pullbackIn: pb ? pb.bars : null,
    pullbackDepth: pb ? pb.depth : null,
    distMa7Pct: ((cur.c - cur.ma7) / cur.ma7) * 100,
    distEma7Pct: cur.ema7 ? ((cur.c - cur.ema7) / cur.ema7) * 100 : null,
    volRatio: cur.volMa20 ? cur.v / cur.volMa20 : null,
    candleT: cur.t,
    candleDone: cur.done,
    ts: cur.t + series.ms,
    chanState,
    stroke,
  };
}

/** 级别事件码（前端色块上的小标记） */
function eventOf(lv, cfg) {
  if (!lv) return EVENT.NONE;
  const cross = lv.crossUp7In != null && lv.crossUp7In <= cfg.triggerLookback;
  const pb = lv.pullbackIn != null && lv.pullbackIn <= cfg.pullbackLookback;
  if (cross && pb) return EVENT.PULLBACK_CROSS;
  if (cross) return EVENT.CROSS_UP;
  if (pb) return EVENT.PULLBACK;
  if (lv.crossDown7In != null && lv.crossDown7In <= 3) return EVENT.CROSS_DOWN;
  return EVENT.NONE;
}

function countBull(views, cfg) {
  let c = 0;
  for (const k of LEVEL_KEYS) {
    const v = views[k];
    if (!v) continue;
    if (cfg.countRule === 'above' ? v.bull : v.bullAlign) c++;
  }
  return c;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 「笔延续链」——从基准级别到确认级别之间（不含确认级别）的全部级别。
 *
 * 例：5m>30m>3h → 5m、10m、15m；3m>15m>2h → 3m、5m、10m；2m>10m>1h → 2m、3m、5m。
 * 含义：一个能撑起 30分 级别延续的回调，必须深/长到让 **5分、10分、15分全部成笔**。
 * 只让最小级别成笔的浅回调，撑不起大级别的延续。
 */
export function strokeChain(baseIdx, midIdx) {
  const out = [];
  for (let i = baseIdx; i < midIdx; i++) out.push(LEVELS[i].key);
  return out;
}

/**
 * 判断「回踩成笔链」是否成立。
 * @returns {{ok:boolean, need:string[], got:string[], missing:string[], topT:number|null, level:string|null}}
 *   topT  = 基准级别最近一个已确认顶分型的时间（回调的起点）
 *   level = **笔延续级别**：从基准级别连续成笔能到达的最高级别
 */
export function checkStrokeChain(views, baseIdx, midIdx, cfg) {
  const need = strokeChain(baseIdx, midIdx);
  const base = views[LEVELS[baseIdx].key];
  // 锚点用「基准级别最近一个**向下笔的起点**」，而不是「最近一个已确认顶分型」：
  // 突破之后若再形成新的顶分型，后者会往后移，导致基准级别自己反而判不过。
  // 向下笔起点一旦这支笔完成就不再变化，是稳定的回调起点。
  const topT = base?.stroke?.down?.topT ?? base?.stroke?.top?.t ?? null;
  const got = [], missing = [];
  let level = null;
  let contiguous = true;
  for (const key of need) {
    const v = views[key];
    const down = v?.stroke?.down;
    // 「在基准级别回调起点之后完成过向下笔」才算这个级别被这波回调带动成笔
    const hit = !!(down && topT != null && down.botT > topT);
    const aboveOk = cfg.chainRequireAboveMa ? !!v?.above7 : true;
    if (hit && aboveOk) {
      got.push(key);
      if (contiguous) level = key;
    } else {
      missing.push(key);
      contiguous = false;
    }
  }
  const ok = topT != null ? missing.length === 0 : false;
  return { ok, need, got, missing, topT, level: ok ? level : (got.length ? level : null) };
}

/**
 * 该级别此刻是否「将要出现背驰笔」。
 * 判定：当前这一笔还没走完，但价格已越过前一同向笔的极值，
 *      而截至当下的 MACD 柱面积已小于前一同向笔 —— 动能衰竭，大概率以背驰收尾。
 */
function isBeichi(v) {
  const st = v?.chanState;
  return !!(st && st.ok && st.divergence && st.divergence.status === 'pending');
}

/**
 * 解析要扫描的「基准 → 确认 → 最大」三元组。
 *  groups 模式：只扫描用户配置的固定组合（允许跨级，如 3分→15分→2时）
 *  auto   模式：基准为 baseMin..baseMax，确认为基准的下一档，最大为任意更高档（兼容旧行为）
 */
let _triCache = null, _triKey = '';
export function triplesFor(cfg) {
  const key = cfg.scanMode + '|' + JSON.stringify(cfg.groups ?? []) + '|' + cfg.baseMinIdx + '|' + cfg.baseMaxIdx;
  if (key === _triKey && _triCache) return _triCache;
  const out = [];
  if (cfg.scanMode !== 'auto') {
    for (const g of cfg.groups ?? []) {
      if (!g || g.enabled === false) continue;
      const b = LEVEL_INDEX[g.base], m = LEVEL_INDEX[g.mid], k = LEVEL_INDEX[g.big];
      if (b == null || m == null || k == null) continue;
      if (!(b < m && m < k)) continue;             // 必须是 基准 < 确认 < 最大
      if (out.some(t => t.b === b && t.m === m && t.k === k)) continue;
      out.push({ b, m, k });
    }
    if (out.length) { _triKey = key; _triCache = out; return out; }
    // 用户把所有组合都停用了 → 不出信号（不静默回退到穷举）
    _triKey = key; _triCache = out; return out;
  }
  const bStart = Math.max(0, cfg.baseMinIdx ?? 0);
  const bEnd = Math.min(cfg.baseMaxIdx ?? LEVELS.length - 3, LEVELS.length - 3);
  for (let b = bStart; b <= bEnd; b++) {
    for (let k = b + 2; k < LEVELS.length; k++) out.push({ b, m: b + 1, k });
  }
  _triKey = key; _triCache = out;
  return out;
}

/**
 * 扫描配置的全部 (基准, 确认, 最大) 三元组，返回按评分降序的命中列表。
 */
export function findResonance(views, cfg, mode) {
  const bullCount = countBull(views, cfg);
  if (bullCount < cfg.minBullLevels) return { bullCount, matches: [], beichiBlocked: 0, strokeBlocked: 0 };

  const matches = [];
  let beichiBlocked = 0;
  let strokeBlocked = 0;
  for (const { b, m: midIdx, k: bigIdx } of triplesFor(cfg)) {
    const baseLv = LEVELS[b], midLv = LEVELS[midIdx], bigLv = LEVELS[bigIdx];
    const base = views[baseLv.key];
    if (!base) continue;

    // —— 基准级别触发条件 ——
    if (cfg.requireBaseBull && !base.bull) continue;
    if (cfg.requireEma7 && base.aboveEma7 !== true) continue;
    if (base.pullbackIn == null || base.pullbackIn > cfg.pullbackLookback) continue;
    if (base.crossUp7In == null || base.crossUp7In > cfg.triggerLookback) continue;
    // 上穿必须发生在回踩之后（或同一根K线）
    if (base.pullbackIn < base.crossUp7In) continue;

    const mid = views[midLv.key];
    if (!mid) continue;
    if (!mid.bull) continue;

    // —— 确认级别上穿 ——
    if (cfg.requireAdjacentCross) {
      if (mid.crossUp7In == null || mid.crossUp7In > cfg.adjacentLookback) continue;
    }

    // —— 缠论背驰过滤：确认级别「将要出现背驰笔」→ 判定上涨衰竭，放弃本组信号 ——
    if (cfg.filterBeichi) {
      const scope = cfg.beichiScope ?? 'mid';
      if (isBeichi(mid) || (scope === 'mid+big' && isBeichi(views[bigLv.key]))) { beichiBlocked++; continue; }
    }

    // —— 回踩成笔链：基准 → 确认级别之间的所有级别都必须被这波回调带动成笔 ——
    let chain = null;
    if (cfg.requireStrokeChain) {
      chain = checkStrokeChain(views, b, midIdx, cfg);
      if (!chain.ok) { strokeBlocked++; continue; }
    }

    // —— 最大级别不得跌破均线 ——
    {
      const big = views[bigLv.key];
      if (!big) continue;
      const line = cfg.bigMa === 'ema7' ? big.ema7 : big.ma7;
      if (line == null) continue;
      if (big.close < line * (1 + cfg.bigTolerance)) continue;
      if (big.bearAlign) continue;
      if (big.close < big.ma25) continue; // 结构性支撑仍在

      // —— 评分 ——
      const volScore = clamp(((base.volRatio ?? 1) - 1) * 10, 0, 8);
      const bigSlope = big.ma7Up ? 5 : 0;
      const pbQuality = clamp(5 - (base.pullbackDepth ?? 0) * 200, 0, 5);
      let score =
        Math.min(bullCount, 13) * 3 +
        bigIdx * 1.2 +
        Math.max(0, 9 - b) * 1.2 +
        Math.max(0, cfg.adjacentLookback - mid.crossUp7In) * 2 +
        Math.max(0, cfg.triggerLookback - base.crossUp7In) * 3 +
        volScore + bigSlope + pbQuality;
      score = Math.round(clamp(score, 0, 100));

      matches.push({
        symbol: views.__symbol,
        mode,
        confirmed: mode === 'closed',
        group: `${baseLv.key}>${midLv.key}>${bigLv.key}`,
        base: baseLv.key,
        baseIdx: b,
        mid: midLv.key,
        midIdx,
        big: bigLv.key,
        bigIdx,
        bullCount,
        score,
        // 笔延续链信息（供界面展示「笔延续级别」）
        strokeChain: chain ? { need: chain.need, got: chain.got, level: chain.level, topT: chain.topT } : null,
        price: base.close,
        baseClose: base.close,
        baseMa7: base.ma7,
        baseEma7: base.ema7,
        bigLine: line,
        bigLineName: cfg.bigMa,
        distBaseMa7Pct: base.distMa7Pct,
        pullbackBars: base.pullbackIn,
        baseCrossBars: base.crossUp7In,
        midCrossBars: mid.crossUp7In,
        volRatio: base.volRatio,
        candleT: base.candleT,
        ts: Date.now(),
        levels: {
          base: pickLevel(base),
          mid: pickLevel(mid),
          big: pickLevel(big),
        },
      });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return { bullCount, matches, beichiBlocked, strokeBlocked };
}
function pickLevel(v) {
  return {
    key: v.key, code: v.code, close: v.close, ma7: v.ma7, ma25: v.ma25,
    ema7: v.ema7, above7: v.above7, bull: v.bull, ma7Up: v.ma7Up,
    distMa7Pct: v.distMa7Pct, crossUp7In: v.crossUp7In, pullbackIn: v.pullbackIn,
  };
}

/** 生成中文提示文案 */
export function describe(sig) {
  const L = k => (LEVELS[LEVEL_INDEX[k]]?.label ?? k);
  const tag = sig.confirmed ? '已确认' : '预警(未收盘)';
  const chain = sig.strokeChain;
  const chainTxt = chain && chain.need?.length
    ? ` · 回踩已带动 ${chain.need.map(L).join('/')} 全部成笔（笔延续至 ${L(chain.level ?? chain.need[chain.need.length - 1])}）`
    : '';
  return `${L(sig.base)}回踩后上穿MA7/EMA7，${L(sig.mid)}同步上穿均线，${L(sig.big)}站稳${sig.bigLineName === 'ema7' ? 'EMA7' : 'MA7'}不破`
    + `${chainTxt} · ${sig.bullCount}个级别多头排列 · [${tag}]`;
}

/**
 * 对一个币种做完整评估。
 * @returns {{bullCount:number, aboveCount:number, levels:object, best:object|null, matches:object[]}}
 */
export function evaluateSymbol(symbol, seriesMap, cfg, includeLive = true) {
  const closedViews = {};
  const liveViews = {};
  for (const lv of LEVELS) {
    const s = seriesMap[lv.key];
    closedViews[lv.key] = analyzeLevel(s, cfg, 'closed');
    if (includeLive && !s.done[s.t.length - 1]) liveViews[lv.key] = analyzeLevel(s, cfg, 'live');
    else liveViews[lv.key] = closedViews[lv.key];
  }
  closedViews.__symbol = symbol;
  liveViews.__symbol = symbol;

  const closedRes = findResonance(closedViews, cfg, 'closed');
  const liveRes = findResonance(liveViews, cfg, 'live');

  // 已确认信号优先；同一组合若已确认则丢弃对应的预警
  const confirmedKeys = new Set(closedRes.matches.map(m => m.group));
  const matched = [
    ...closedRes.matches,
    ...liveRes.matches.filter(m => !confirmedKeys.has(m.group)),
  ];
  matched.sort((a, b) => b.score - a.score);
  const aboveCount = LEVEL_KEYS.reduce((n, k) => {
    const v = closedViews[k];
    return n + (v && v.above7 ? 1 : 0);
  }, 0);

  const levels = {};
  for (const k of LEVEL_KEYS) {
    const v = closedViews[k];
    if (!v) { levels[k] = { code: STATE.NODATA, event: EVENT.NONE }; continue; }
    levels[k] = {
      code: v.code,
      event: eventOf(v, cfg),
      ma7: v.ma7, ema7: v.ema7, ma25: v.ma25,
      close: v.close,
      distMa7Pct: v.distMa7Pct,
      ma7Up: v.ma7Up,
      volRatio: v.volRatio,
    };
  }

  return {
    symbol,
    bullCount: Math.max(closedRes.bullCount, liveRes.bullCount),
    aboveCount,
    levels,
    best: matched[0] ?? null,
    matchCount: matched.length,
    matches: matched.slice(0, 8),
    beichiBlocked: closedRes.beichiBlocked + liveRes.beichiBlocked,
    strokeBlocked: (closedRes.strokeBlocked ?? 0) + (liveRes.strokeBlocked ?? 0),
  };
}

export const defaultSignalConfig = () => ({ ...DEFAULT_SIGNAL });

/** 供回测使用：把 ma7/ma25/ema7 数组与K线一起滑窗评估 */
export function analyzeLevelAtIndex(series, ind, idx, cfg) {
  const n = series.t.length;
  if (idx < 30 || idx >= n) return null;
  const cur = at(series, ind, idx);
  const prev = at(series, ind, idx - 1);
  if (!cur || !prev || cur.ma7 == null || cur.ma25 == null || prev.ma7 == null) return null;
  const ma7Up = cur.ma7 > prev.ma7;
  let code;
  if (cur.c > cur.ma7 && cur.ma7 > cur.ma25) code = STATE.BULL_ALIGN;
  else if (cur.c > cur.ma7) code = STATE.BULL;
  else if (cur.c < cur.ma7 && cur.ma7 > cur.ma25) code = STATE.WEAK;
  else if (cur.c < cur.ma7 && cur.ma7 <= cur.ma25) code = STATE.BEAR_ALIGN;
  else code = STATE.NEUTRAL;
  const pb = findPullback(series, ind.ma7, idx, 20, cfg.pullbackTolerance);
  let chanState = null;
  if (cfg.filterBeichi) {
    chanState = series.beichiState(idx, {
      minBars: cfg.beichiMinBars ?? 5,
      ratio: cfg.beichiRatio ?? 1.0,
      minProgress: cfg.beichiMinProgress ?? 0.3,
    });
  }
  // —— 笔状态（回踩成笔链用） ——
  let stroke = null;
  if (cfg.requireStrokeChain) stroke = series.strokeInfo(idx, cfg.beichiMinBars ?? 5);
  return {
    key: series.key, code, close: cur.c, ma7: cur.ma7, ma25: cur.ma25, ema7: cur.ema7,
    ma7Up,
    above7: cur.c > cur.ma7,
    aboveEma7: cur.ema7 != null ? cur.c > cur.ema7 : null,
    bull: cur.c > cur.ma7 && cur.ma7 > cur.ma25,
    bullAlign: cur.c > cur.ma7 && cur.ma7 > cur.ma25 && ma7Up,
    bearAlign: cur.c < cur.ma7 && cur.ma7 < cur.ma25,
    crossUp7In: findCrossUp(series, ind.ma7, idx, 20),
    crossUpEma7In: findCrossUp(series, ind.ema7, idx, 20),
    crossDown7In: findCrossDown(series, ind.ma7, idx, 20),
    pullbackIn: pb ? pb.bars : null,
    pullbackDepth: pb ? pb.depth : null,
    distMa7Pct: ((cur.c - cur.ma7) / cur.ma7) * 100,
    volRatio: cur.volMa20 ? cur.v / cur.volMa20 : null,
    candleT: cur.t,
    candleDone: true,
    ts: cur.t,
    chanState,
    stroke,
  };
}
