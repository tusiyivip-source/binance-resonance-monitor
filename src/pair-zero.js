/**
 * 「次级别回踩 / 主级别零轴」配对策略
 *
 * 七组配对（次级别 → 主级别，一律约 6 倍关系）：
 *   5分 → 30分    10分 → 1小时   15分 → 2小时   30分 → 3小时
 *   1小时 → 6小时  2小时 → 12小时  4小时 → 日线
 *
 * 做多：
 *   ① 主级别 DIF 在零轴**上方**
 *   ② 次级别 DIF 也在零轴上方（全程没穿越零轴）
 *   ③ 次级别本轮已经**回踩 ≥ N 根**（当前 DIF 低于本轮峰值，且距峰值 ≥ N 根）
 *
 * 做空：
 *   ① 主级别 DIF 在零轴**下方**
 *   ② 次级别 DIF 也在零轴下方（没上穿零轴）
 *   ③ 次级别本轮已经**反弹 ≥ N 根**（当前 DIF 高于本轮谷值，且距谷值 ≥ N 根）
 */

export const PAIR_ZERO_PAIRS = [
  { sub: '5m', main: '30m' },
  { sub: '10m', main: '1h' },
  { sub: '15m', main: '2h' },
  { sub: '30m', main: '3h' },
  { sub: '1h', main: '6h' },
  { sub: '2h', main: '12h' },
  { sub: '4h', main: '1d' },
];

export const PAIR_ZERO_LEVELS = [...new Set(PAIR_ZERO_PAIRS.flatMap(p => [p.sub, p.main]))];

export function pairZeroOptions(input = {}, cfg = {}) {
  const n = (v, d, min, max) => (v == null || v === '' || !Number.isFinite(Number(v))
    ? d : Math.max(min, Math.min(max, Number(v))));
  return {
    // 次级别回踩/反弹至少多少根
    minPullBars: Math.round(n(input.pull, cfg.pairZeroMinPullBars ?? 5, 1, 60)),
    // 主级别 DIF 最少要在同侧多少根（默认 1，不做额外限制）
    minMainHold: Math.round(n(input.mainHold, cfg.pairZeroMinMainHold ?? 1, 1, 60)),
    // 只算涨幅榜前 N
    topN: Math.round(n(input.topN, cfg.pairZeroTopN ?? 200, 1, 400)),
    // 方向筛选：all / long / short
    side: ['all', 'long', 'short'].includes(input.side) ? input.side : 'all',
  };
}

/**
 * 单个级别的零轴状态：DIF 在哪一侧、本轮持续多少根、距本轮极值多少根。
 * @returns {{dif,dea,side,hold,peak,peakIdx,pullBars}|null}
 */
export function levelZeroAt(series, ind, idx) {
  const m = ind?.macd;
  if (!m || !Number.isFinite(idx) || idx < 35 || idx >= series.t.length) return null;
  const dif = m.dif[idx], dea = m.dea[idx];
  if (!Number.isFinite(dif) || !Number.isFinite(dea) || dif === 0) return null;
  const side = dif > 0 ? 1 : -1;

  // 往前找本轮同号连续段（遇到符号翻转或时间跳空就停）
  let start = idx, peak = dif, peakIdx = idx;
  for (let i = idx; i >= 1; i--) {
    const d = m.dif[i];
    if (!Number.isFinite(d)) break;
    const s = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (s !== side) break;
    // 同一根才算连续，跳空视为断开
    if (i < idx && series.t[i] !== series.t[i + 1] - series.ms) break;
    if (side > 0 ? d > peak : d < peak) { peak = d; peakIdx = i; }
    start = i;
  }
  const hold = idx - start + 1;
  const pullBars = idx - peakIdx;   // 距离本轮极值过了几根
  return { dif, dea, side, hold, peak, peakIdx, peakT: series.t[peakIdx], pullBars, at: series.t[idx] + series.ms };
}

/**
 * 判定一组配对是否成立。
 * @param {object} sub  次级别 levelZeroAt
 * @param {object} main 主级别 levelZeroAt
 * @param {number} dir  1=多 / -1=空
 */
export function pairZeroHit(sub, main, dir, opt) {
  if (!sub || !main) return null;
  if (main.side !== dir) return null;                       // ① 主级别在要求的零轴一侧
  if (sub.side !== dir) return null;                        // ② 次级别同侧（没穿越零轴）
  if (sub.pullBars < opt.minPullBars) return null;          // ③ 回踩/反弹够根数
  if (main.hold < opt.minMainHold) return null;
  return {
    dir: dir > 0 ? 'long' : 'short',
    subDif: sub.dif, subHold: sub.hold, subPullBars: sub.pullBars,
    subPeak: sub.peak, subPeakT: sub.peakT, subAt: sub.at,
    mainDif: main.dif, mainHold: main.hold,
    mainPeak: main.peak, mainAt: main.at,
  };
}

/** 排序：刚够根数的最新鲜，排前面；同根数再按次级别 DIF 距零轴远近 */
export function comparePairZero(a, b) {
  return (a.subPullBars - b.subPullBars)
    || (Math.abs(b.subDif) - Math.abs(a.subDif))
    || String(a.symbol).localeCompare(String(b.symbol));
}
