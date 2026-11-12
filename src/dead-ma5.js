/**
/**
 * 「零轴上死叉 → 连续下跌 N 根 → 首次收阳」策略（替换原来的配对共振）。
 *
 * 监控级别：15分 / 30分 / 1小时 / 2小时 / 3小时 / 6小时 / 12小时
 * 每个级别**独立判定**，互不影响。
 *
 * 成立条件（同级别依次满足）：
 *   ① 最近一次 MACD 死叉发生在**零轴上**（死叉那根的 DIF 和 DEA 都 > 0）
 *   ② 死叉之后连续下跌（阴线）至少 N 根（默认 5，可以更长）
 *   ③ 当前这根是下跌结束后的**第一根阳线**（前一根还是阴线）
 *
 * 只做多：这是回调结束、重新走强的第一个信号。
 * MA5 不参与判定，只在卡片上显示供参考。
 */

export const DEAD_MA5_LEVELS = ['15m', '30m', '1h', '2h', '3h', '6h', '12h'];

/**
 * 死叉之后 DIF 有没有跌破零轴。
 * 「零上死叉」不只是死叉那一刻在零轴上，**之后也不能穿下去**，
 * 否则就变成水下死叉了，方向判断完全不同。
 */
function neverBelowZero(dif, from, to) {
  if (!(from >= 0) || !(to >= from)) return false;
  for (let i = from; i <= to; i++) {
    const v = dif[i];
    if (!Number.isFinite(v)) continue;
    if (!(v > 0)) return false;
  }
  return true;
}

/** 5 周期均线（收盘价） */
function maAt(series, i, n = 5) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const v = series.c[k];
    if (!Number.isFinite(v)) return null;
    s += v;
  }
  return s / n;
}

/**
 * 判定 idx 处是否成立。
 * @param {object} series 该级别的K线序列（需要 o/c）
 * @param {object} ind series.ensure() 的结果（要 macd.dif / macd.dea）
 * @param {number} idx 最后一根**已收盘**K线的下标
 * @param {object} opt { minBars 死叉后至少几根 }
 * @returns {object|null}
 */
export function deadMa5At(series, ind, idx, opt = {}) {
  if (!series || !Number.isFinite(idx) || idx < 20) return null;
  const m = ind?.macd;
  if (!m || !m.dif || !m.dea) return null;
  const minBars = Math.max(1, Number(opt.minBars ?? 5));
  const needMa5 = opt.requireMa5 === true;      // 默认不要求站上 MA5

  const dif = m.dif, dea = m.dea;

  // ① 找最近一次死叉（DIF 从上往下穿 DEA）
  let deadIdx = -1;
  const from = Math.max(1, idx - 240);
  for (let i = idx; i >= from; i--) {
    const d0 = dif[i - 1], e0 = dea[i - 1], d1 = dif[i], e1 = dea[i];
    if (![d0, e0, d1, e1].every(Number.isFinite)) continue;
    if (d0 >= e0 && d1 < e1) { deadIdx = i; break; }
  }
  if (deadIdx < 0) return null;

  // ② 死叉必须发生在**零轴上**：死叉那根的 DIF 和 DEA 都要在零轴上方
  if (!(dif[deadIdx] > 0) || !(dea[deadIdx] > 0)) return null;

  // ②b 死叉之后 DIF 不能跌破零轴（穿轴就不算「零上死叉」了）
  if (!neverBelowZero(dif, deadIdx, idx)) return null;

  // ③ 死叉之后要有一段连续下跌（阴线），至少 N 根
  //    从当前这根的前一根往前数，遇到阳线就停 —— 这段就是「下跌 N 根」
  let downBars = 0;
  for (let k = idx - 1; k > deadIdx; k--) {
    const ok = series.c[k] < series.o[k];        // 阴线（收 < 开）
    if (!ok) break;
    downBars++;
    if (downBars >= 200) break;
  }
  if (downBars < minBars) return null;

  // ④ 当前这根是**下跌之后的第一次收阳**
  const o = series.o[idx], c = series.c[idx];
  if (!(c > o)) return null;                     // 必须是阳线
  const prevO = series.o[idx - 1], prevC = series.c[idx - 1];
  if (!(prevC <= prevO)) return null;            // 前一根不能是阳线 → 保证是「第一次」

  // ⑤ 可选：还要站上 MA5（默认关，想加回来把 opt.requireMa5 设 true）
  const ma1 = maAt(series, idx);
  const ma0 = maAt(series, idx - 1);
  if (needMa5) {
    if (!Number.isFinite(ma1) || !Number.isFinite(ma0)) return null;
    if (!(c > ma1)) return null;
    if (!(prevC < ma0)) return null;
  }

  return {
    dir: 'long',
    variant: 'first',
    variantLabel: '连跌' + downBars + '根·首次收阳',
    deadIdx,
    deadT: series.t[deadIdx] + series.ms,
    deadDif: Math.round(dif[deadIdx] * 1e8) / 1e8,
    deadDea: Math.round(dea[deadIdx] * 1e8) / 1e8,
    barsSinceDead: idx - deadIdx,                // 死叉那根算第 0 根
    downBars,                                    // 连续下跌（阴线）根数
    dif: Math.round(dif[idx] * 1e8) / 1e8,
    dea: Math.round(dea[idx] * 1e8) / 1e8,
    ma5: Number.isFinite(ma1) ? Math.round(ma1 * 1e8) / 1e8 : null,
    prevMa5: Number.isFinite(ma0) ? Math.round(ma0 * 1e8) / 1e8 : null,
    open: o, close: c,
    bodyPct: o > 0 ? Math.round(((c - o) / o) * 10000) / 100 : 0,
    at: series.t[idx] + series.ms,
  };
}

/**
 * 策略 B「零上死叉状态 + 阳K站上 MA5」——照搬看板那套判定。
 *
 * 与 deadMa5At 的区别：这不是「死叉事件」，而是**当前状态**：
 *   ① DIF > 0 且 DEA > 0（双线都在零轴上方）
 *   ② 柱子 < 0（已经死叉，柱子翻绿）
 *   ③ 最新一根已收盘K线是阳线，且收盘 > MA5
 *
 * 没有「≥N 根」的门槛 —— 只要还处在这个状态里就会一直命中，
 * 所以同一个币会在列表里持续出现，直到回踩结束。
 */
export function zeroStateAt(series, ind, idx, opt = {}) {
  if (!series || !Number.isFinite(idx) || idx < 40) return null;
  const m = ind?.macd;
  if (!m || !m.dif || !m.dea || !m.hist) return null;

  const d = m.dif[idx], e = m.dea[idx], h = m.hist[idx];
  if (![d, e, h].every(Number.isFinite)) return null;
  // ① 双线在零轴上方 ② 柱子翻绿 = 已死叉
  if (!(d > 0 && e > 0 && h < 0)) return null;

  // ③ 最新一根：阳K 且站上 MA5
  const k = series, o = k.o[idx], c = k.c[idx];
  if (!(c > o)) return null;
  const ma5 = maAt(k, idx);
  if (!Number.isFinite(ma5) || !(c > ma5)) return null;

  // ②b 死叉之后 DIF 不能跌破零轴
  //     （B 套本来就是「当前 d>0 && e>0」，这里再补一道「全程没穿」）

  // 找本轮死叉的位置（柱子由正转负那一根），用于展示
  let deadIdx = -1;
  const from = Math.max(1, idx - 240);
  for (let i2 = idx; i2 >= from; i2--) {
    const h0 = m.hist[i2 - 1], h1 = m.hist[i2];
    if (!Number.isFinite(h0) || !Number.isFinite(h1)) continue;
    if (h0 >= 0 && h1 < 0) { deadIdx = i2; break; }
  }

  if (deadIdx >= 0 && !neverBelowZero(m.dif, deadIdx, idx)) return null;

  return {
    dir: 'long',
    variant: 'state',
    variantLabel: '零上死叉·阳收MA5',
    deadIdx: deadIdx >= 0 ? deadIdx : null,
    deadT: deadIdx >= 0 ? series.t[deadIdx] + series.ms : null,
    deadDif: deadIdx >= 0 ? Math.round(m.dif[deadIdx] * 1e8) / 1e8 : Math.round(d * 1e8) / 1e8,
    deadDea: deadIdx >= 0 ? Math.round(m.dea[deadIdx] * 1e8) / 1e8 : Math.round(e * 1e8) / 1e8,
    barsSinceDead: deadIdx >= 0 ? idx - deadIdx : null,
    downBars: null,
    dif: Math.round(d * 1e8) / 1e8,
    dea: Math.round(e * 1e8) / 1e8,
    hist: Math.round(h * 1e8) / 1e8,
    ma5: Math.round(ma5 * 1e8) / 1e8,
    prevMa5: null,
    open: o, close: c,
    bodyPct: o > 0 ? Math.round(((c - o) / o) * 10000) / 100 : 0,
    at: series.t[idx] + series.ms,
  };
}

/** 参数归一化 */
export function deadMa5Options(input = {}, cfg = {}) {
  const num = (v, d, min, max) => (v == null || v === '' || !Number.isFinite(Number(v))
    ? d : Math.max(min, Math.min(max, Number(v))));
  return {
    minBars: Math.round(num(input.minBars, cfg.deadMa5MinBars ?? 5, 1, 60)),
    topN: Math.round(num(input.topN, cfg.deadMa5TopN ?? 500, 1, 800)),
  };
}

/** 排序：刚成立的在前，然后死叉后根数多的在前 */
export function compareDeadMa5(x, y) {
  // 按**先后顺序**排：先出现的在前（旧 → 新），和「配对全景」的报警顺序一致。
  // 原来是最新在前，列表会随刷新不断重排；改成升序后新信号稳定追加到末尾。
  const a = Number.isFinite(x.at) ? x.at : 0;
  const b = Number.isFinite(y.at) ? y.at : 0;
  if (a !== b) return a - b;
  // 同一时刻：死叉更早的在前（回踩走得更久）
  return (y.barsSinceDead || 0) - (x.barsSinceDead || 0);
}
