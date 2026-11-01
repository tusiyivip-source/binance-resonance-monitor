// 零轴监控只看已收盘数据；靠近程度以「本轮同侧」的振幅为尺度计算。
// 10m 与 3h 都是本地合成级别（10m←5m 2:1，3h←1h 3:1）。
export const MONITOR_LEVEL_KEYS = ['15m', '30m', '1h', '2h', '3h', '4h', '6h'];

export const ZERO_LEVEL_KEYS = ['10m', '15m', '30m', '1h', '2h', '3h', '4h', '6h', '12h', '1d'];

/**
 * 双级别配对：**次级别**做回踩触发，**主级别**定趋势方向。
 *   sub.main / sub.sub 之比约 1:6~1:8
 *   多：主级别金叉，次级别回踩到零轴附近但**不下穿**
 *   空：主级别死叉，次级别反弹到零轴附近但**不上穿**
 */
export const ZERO_PAIRS = [
  { sub: '10m', main: '1h' },
  { sub: '15m', main: '2h' },
  { sub: '30m', main: '3h' },
  { sub: '1h', main: '6h' },
  { sub: '2h', main: '12h' },
  { sub: '4h', main: '1d' },
];

/**
 * 主级别条件：**金叉/死叉成立，且零轴同侧时不能明显背驰**。
 *
 * 为什么不再要求「主级别 DIF 在零轴同侧」：
 *   那样只能捕捉已经在零轴上方的趋势，会漏掉「零轴下方金叉」这种最早的启动形态。
 *   改成看 DIF 与 DEA 的交叉后，主级别在零轴下方金叉也算数。
 *
 * 为什么零轴同侧时要查背驰：
 *   主级别已经在零轴上方还能做多，前提是这波上涨**没有衰竭**。
 *   如果 MACD 柱面积明显萎缩（背驰酝酿中），说明推动力在减弱，此时追多风险很高。
 *
 * @param {object|null} mainZ 主级别 zeroMonitorAt 结果
 * @param {number} dir 1=多 / -1=空
 * @param {{status?:string,dir?:string}|null} div 主级别 beichiState().divergence
 */
export function mainLevelOk(mainZ, dir, div, opt = {}) {
  if (!mainZ) return false;
  const dif = mainZ.dif, dea = mainZ.dea;
  if (!Number.isFinite(dif) || !Number.isFinite(dea)) return false;
  // ① 金叉（多）/ 死叉（空）—— 不要求 DIF 在零轴的哪一侧
  if (dir > 0 ? !(dif > dea) : !(dif < dea)) return false;
  if (opt.requireNoDiv === false) return true;
  // ② 主级别已在零轴同侧（多=上方 / 空=下方）时，不能有明显背驰
  const onSide = dir > 0 ? dif > 0 : dif < 0;
  if (!onSide) return true;                    // 零轴另一侧金叉：不查背驰
  const wantDiv = dir > 0 ? 'top' : 'bottom';
  if (div && div.status === 'pending' && div.dir === wantDiv) return false;
  return true;
}

/**
 * 一只标的的某一对级别是否构成信号。
 *
 *   次级别：必须「已靠近零轴」（回踩/反弹触发点），方向由 DIF 符号决定
 *   主级别：金叉/死叉成立 + 零轴同侧时不背驰（见 mainLevelOk）
 *
 * @param {object|null} subZ  次级别 zeroMonitorAt 结果
 * @param {object|null} mainZ 主级别 zeroMonitorAt 结果
 * @param {number} mainMinHold 主级别金叉/死叉至少要持续的根数
 * @param {{status?:string,dir?:string}|null} div 主级别背驰状态
 * @returns {{dir, subNear, subHold, mainDif, mainHold, mainNear, mainCross}|null}
 */
export function zeroPairHit(subZ, mainZ, mainMinHold = 1, div = null, opt = {}) {
  if (!subZ) return null;
  // 次级别必须「已靠近零轴」——这是回踩/反弹的触发点
  if (subZ.phase !== 'near') return null;
  const subSide = Math.sign(subZ.side);
  if (!subSide) return null;
  const dir = subSide > 0 ? 'long' : 'short';
  if (!mainLevelOk(mainZ, subSide, div, opt)) return null;
  // 金叉/死叉要站稳，避免刚交叉又立刻反向
  const ch = mainZ.crossHold ?? 1;
  if (ch < mainMinHold) return null;
  return {
    dir,
    subNear: subZ.near, subHold: subZ.hold,
    mainDif: mainZ.dif, mainDea: mainZ.dea, mainNear: mainZ.near,
    mainHold: ch,                               // 主级别金叉/死叉已持续的根数
    mainCross: (mainZ.crossSide ?? 0) > 0 ? 'golden' : 'death',
    mainAboveZero: mainZ.dif > 0,
    divBlocked: false,
  };
}

/**
 * 左侧「大级别推动K线 + 回调不破」结构检查。
 *
 * 只看「主级别 DIF 在零轴上方」太弱：任何温和上涨都满足。
 * 真正值得做的是「先有一根放量推动的大阳线，随后回调但没把它的实体吃掉」。
 *
 *   · 大K线：实体 ≥ 近 bigLookback 根平均实体 × bigMult，方向与信号一致（多=阳，空=阴）
 *   · 左侧：在当前K线之前、最近 bigLookback 根之内
 *   · 回调不破：大K线之后**所有收盘**都没跌破它的实体底（多）/ 涨破实体顶（空）
 *
 * 只认**最近一根**大K线：若它已被破位，说明结构失效，不再往前找旧的那根充数。
 *
 * @returns {{idx,open,close,low,high,body,avgBody,line,t}|null}
 */
export function bigCandleSupport(series, idx, dir, opt = {}) {
  const lookback = Math.max(3, opt.bigLookback ?? 20);
  const mult = opt.bigMult ?? 1.5;
  const basis = opt.bigBasis === 'low' ? 'extreme' : 'body';
  if (!series || idx < 5 || dir === 0) return null;

  // 平均实体用当前K线之前的一段算，避免大K线自己把基准抬高
  const from = Math.max(0, idx - lookback - 20);
  let sum = 0, n = 0;
  for (let i = from; i < idx; i++) { sum += Math.abs(series.c[i] - series.o[i]); n++; }
  if (!n) return null;
  const avg = sum / n;
  if (!(avg > 0)) return null;

  // 找最近一根符合方向的「大K线」
  for (let i = idx; i > idx - lookback && i >= 1; i--) {
    const o = series.o[i], c = series.c[i];
    const body = Math.abs(c - o);
    const bullish = c > o;
    if (dir > 0 ? !bullish : bullish) continue;
    if (body < avg * mult) continue;

    // 实体底（多）/ 实体顶（空）；basis=extreme 时改用最低价/最高价
    const line = basis === 'extreme'
      ? (dir > 0 ? series.l[i] : series.h[i])
      : o;
    let broken = false;
    for (let k = i + 1; k <= idx; k++) {
      if (dir > 0 ? series.c[k] < line : series.c[k] > line) { broken = true; break; }
    }
    if (broken) return null;            // 最近这根大K线已被破 → 结构失效
    return {
      idx: i, open: o, close: c, low: series.l[i], high: series.h[i],
      body, avgBody: avg, mult: body / avg, line, t: series.t[i],
    };
  }
  return null;
}

/**
 * 策略：**多 = 靠近零轴不下穿 MACD；空 = 靠近零轴不上穿 MACD**
 *
 *   · 不下穿 / 不上穿：DIF 已经在该侧**持续 hold 根**，全程没有穿越零轴（符号未翻转）
 *   · 靠近零轴：DIF 从**本轮高点**回落到零轴附近 —— 用「|DIF| ÷ 本轮同侧最大 |DIF|」
 *     衡量靠近程度，≤ maxNear 视为已回到零轴附近
 *
 * 不涉及金叉/死叉（DIF 与 DEA 的交叉）：这里衡量的只是 DIF 与**零轴**的关系。
 * 「本轮」以 DIF 穿越零轴（符号翻转）为界 —— hold 天然就是这个计数。
 *
 * 两个关键点（少了任何一个都会把「刚穿上来」误判成「回踩」）：
 *   ① 振幅分母只能用**本轮同侧**的最大 |DIF|。若跨到零轴另一侧取最大值，
 *      DIF 刚从 -1.0 翻到 +0.02 时 near 会算成 0.02，看着像贴到零轴了，
 *      其实是趋势刚起步。
 *   ② 要求 DIF 在该侧先持续 minHold 根，确认「涨上去过」才谈得上回踩。
 */
export function zeroOptions(input = {}, cfg = {}) {
  const number = (value, fallback, min, max) => value == null || value === '' || !Number.isFinite(Number(value))
    ? fallback : Math.max(min, Math.min(max, Number(value)));
  return {
    // 回踩深度上限：|DIF| / 近期最大 |DIF|（0=必须完全贴到零轴，1=不限）
    maxNear: number(input.near, cfg.zeroMaxNear ?? 0.15, 0, 1),
    lookback: Math.round(number(cfg.zeroLookback, 60, 2, 600)),
    // 回踩前 DIF 必须在该侧持续的最少根数（区分「回踩」与「刚上穿」）
    minHold: Math.round(number(input.hold, cfg.zeroMinHoldBars ?? 3, 1, 60)),
    side: ['long', 'short'].includes(input.side) ? input.side : 'all',
    q: String(input.q ?? '').trim().toUpperCase().slice(0, 40),
    onlyUp: input.onlyUp === '1' || input.onlyUp === true,
    onlySignal: input.onlySignal === '1' || input.onlySignal === true,
    onlyConfirmed: input.onlyConfirmed === '1' || input.onlyConfirmed === true,
    onlySeeded: input.onlySeeded === '1' || input.onlySeeded === true,
    minQual: Math.round(number(input.minQual, 1, 0, ZERO_LEVEL_KEYS.length)),
    // —— 左侧「大级别推动K线 + 回调不破」结构 ——
    requireBig: cfg.zeroRequireBigCandle !== false,
    bigLookback: Math.round(number(cfg.zeroBigLookback, 20, 3, 200)),
    bigMult: Number.isFinite(Number(cfg.zeroBigCandleMult)) ? Number(cfg.zeroBigCandleMult) : 1.5,
    bigBasis: cfg.zeroBigBasis === 'low' ? 'low' : 'body',
    // 主级别零轴同侧时是否要求「无明显背驰」
    requireNoDiv: cfg.zeroMainNoDivergence !== false,
  };
}

export function zeroMonitorAt(series, ind, idx, opt) {
  const m = ind?.macd;
  if (!m || idx < 33 || idx >= series.t.length) return null;
  let firstNearIndex = -1, runMax = 0;
  let near = null, pull = false, hold = 0, lastSide = 0;
  // 金叉/死叉状态：sign(DIF − DEA) 连续的根数（主级别判定要用）
  let crossSide = 0, crossHold = 0, lastCross = 0;
  for (let i = 0; i <= idx; i++) {
    const dif = m.dif[i], dea = m.dea[i];
    const gap = i > 0 && series.t[i] !== series.t[i - 1] + series.ms;
    if (gap || !Number.isFinite(dif) || !Number.isFinite(dea)) {
      firstNearIndex = -1; hold = 0; lastSide = 0; runMax = 0;
      crossSide = 0; crossHold = 0; lastCross = 0;
      if (!Number.isFinite(dif) || !Number.isFinite(dea)) { near = null; continue; }
    }
    const abs = Math.abs(dif);
    const side = Math.sign(dif);
    // —— 新一轮（DIF 穿越零轴）开始 ——
    // 分母必须只算**本轮同侧**：否则会带上零轴另一侧的更大 |DIF|，
    // 「刚上穿零轴、只有 3 根」也会算出极小 near，被误判成已回踩。
    // 同时用**整轮**最大值，不再截断到 lookback 根 ——
    // 小级别（5m/10m）的一轮经常超过 60 根，截断会让分母偏小、near 系统性偏高，
    // 结果就是「只有大级别能达标」。实测整轮口径下各等级 5% 分位落在 8%~23%，可比。
    if (side !== lastSide) {
      runMax = 0;
      firstNearIndex = -1;
    }
    if (abs > runMax) runMax = abs;
    near = runMax > 0 ? abs / runMax : null;
    pull = !gap && i > 0 && Number.isFinite(m.dif[i - 1]) && abs < Math.abs(m.dif[i - 1]);
    hold = side && side === lastSide ? hold + 1 : (side ? 1 : 0);
    lastSide = side;
    // 金叉/死叉持续性
    const cs = Math.sign(dif - dea);
    crossHold = cs && cs === lastCross ? crossHold + 1 : (cs ? 1 : 0);
    lastCross = cs;
    crossSide = cs;
    if (i < 33) continue; // 等待 MACD 初始化，避免把种子值当成有效值。
    // 「已回踩到位」：该侧持续够久 + 回到零轴附近（本轮只记第一次）
    if (firstNearIndex < 0 && hold >= opt.minHold && near != null && near <= opt.maxNear) firstNearIndex = i;
  }
  if (near == null) return null;

  const side = Math.sign(m.dif[idx]);
  const holdEnough = hold >= opt.minHold;
  const nearEnough = near <= opt.maxNear;
  const isNear = holdEnough && nearEnough;

  const closeAt = i => i < 0 ? null : series.t[i] + series.ms;
  return {
    near, pull, hold, holdEnough, nearEnough, side, runMax,
    dif: m.dif[idx], dea: m.dea[idx], hist: m.hist[idx],
    crossSide, crossHold,                       // 金叉(+)/死叉(−) 及其持续根数
    phase: isNear ? 'near' : 'idle',
    firstNearAt: closeAt(firstNearIndex), firstNearBarAt: firstNearIndex < 0 ? null : series.t[firstNearIndex],
    at: closeAt(idx),
  };
}

export function zeroMatches(z, opt) {
  return !!z && z.phase === 'near'
    && (opt.side === 'all' || (opt.side === 'long' ? z.side > 0 : z.side < 0));
}

export function compareZero(a, b) {
  // 已回踩的按「首次回踩到位时间」从早到晚，其次回踩更深的（near 更小）优先
  const at = h => h.z.firstNearAt ?? Number.MAX_SAFE_INTEGER;
  return at(a) - at(b) || a.z.near - b.z.near
    || a.sym.localeCompare(b.sym) || ZERO_LEVEL_KEYS.indexOf(a.k) - ZERO_LEVEL_KEYS.indexOf(b.k);
}
