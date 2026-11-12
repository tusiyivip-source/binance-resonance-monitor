/**
 * 「背驰 50%」策略（多级别 + 缠论笔）。
 *
 * 级别关系（次级别 → 主级别）：
 *   3m-15m / 5m-30m / 10m-1h / 15m-2h / 30m-3h / 1h-6h
 *
 * 方向（固定对应，不做四组合）：
 *   主级别 DIF 在零轴上 → 只找**回调做多**
 *   主级别 DIF 在零轴下 → 只找**反弹做空**
 *
 * 次级别要求：回调（反弹）K线根数 ≥ 5 根，不设上限（回调 N 根都行）。
 *
 * 两种提醒方式，同一策略里都算：
 *   方式1「背驰 50%」：次级别最后一笔（高→低）不少于 5 根K线，
 *                      该笔相对**前一同向笔**构成 MACD 面积背驰，
 *                      且价格突破到该笔高低点的 50% → 提醒
 *   方式2「反弹 50%」：不要求背驰，只要次级别最后一笔 ≥5 根、
 *                      价格反弹到 50% → 提醒
 *
 * 50% 的定义：最后一笔**高点到低点的一半**，即 (high + low) / 2。
 *
 * 「突破」按**事件**算，不是「现在在 50% 上方就一直报」：
 * 只在最近 2 根已收盘K线里越过 50% 才算命中，否则满屏都是陈旧信号。
 */
import { macdArea } from './chan.js';
/** 级别配对（次级别 → 主级别） */
export const HALF_PAIRS = [
  { sub: '3m', main: '15m' },
  { sub: '5m', main: '30m' },
  { sub: '10m', main: '1h' },
  { sub: '15m', main: '2h' },
  { sub: '30m', main: '3h' },
  { sub: '1h', main: '6h' },
];


/** 取截至 idx 的最后一笔（side: 'down' = 顶→底，'up' = 底→顶） */
export function lastStrokeOf(chan, series, idx, side) {
  if (!chan || !series) return null;
  const i = Math.max(0, Math.min(idx, chan.n - 1));
  const cnt = chan.confirmCount[i];
  if (cnt < 2) return null;
  for (let k = cnt - 1; k >= 1; k--) {
    const a = chan.pts[k - 1], b = chan.pts[k];
    const want = side === 'down'
      ? (a.type === 'top' && b.type === 'bottom')
      : (a.type === 'bottom' && b.type === 'top');
    if (!want) continue;
    const high = Math.max(a.price, b.price);
    const low = Math.min(a.price, b.price);
    return {
      side,
      fromIdx: a.origIdx, toIdx: b.origIdx,
      fromT: series.t[a.origIdx], toT: series.t[b.origIdx],
      high, low,
      mid: (high + low) / 2,
      bars: b.origIdx - a.origIdx,
      area: macdArea(chan, a.origIdx, b.origIdx, side),
    };
  }
  return null;
}

/** 再往前找一笔同向的，用来比背驰 */
function prevSameStroke(chan, series, idx, side, exclude) {
  if (!chan || !series) return null;
  const i = Math.max(0, Math.min(idx, chan.n - 1));
  const cnt = chan.confirmCount[i];
  let skipped = false;
  for (let k = cnt - 1; k >= 1; k--) {
    const a = chan.pts[k - 1], b = chan.pts[k];
    const want = side === 'down'
      ? (a.type === 'top' && b.type === 'bottom')
      : (a.type === 'bottom' && b.type === 'top');
    if (!want) continue;
    if (!skipped) { skipped = true; continue; }   // 跳过最后一笔本身
    if (exclude && b.origIdx >= exclude.toIdx) continue;
    return {
      side,
      high: Math.max(a.price, b.price),
      low: Math.min(a.price, b.price),
      bars: b.origIdx - a.origIdx,
      area: macdArea(chan, a.origIdx, b.origIdx, side),
    };
  }
  return null;
}

/** 最近 2 根已收盘K线里，收盘价是否刚越过 mid（做多向上穿、做空向下穿） */
function crossedRecently(series, idx, mid, side, lookback = 2) {
  if (!Number.isFinite(mid)) return null;
  for (let k = 0; k < lookback; k++) {
    const i = idx - k;
    if (i < 1) break;
    const cur = series.c[i], prev = series.c[i - 1];
    if (!Number.isFinite(cur) || !Number.isFinite(prev)) continue;
    if (side === 'down') {
      if (cur >= mid && prev < mid) return { at: series.t[i] + series.ms, idx: i, crossPct: (cur - mid) / mid };
    } else {
      if (cur <= mid && prev > mid) return { at: series.t[i] + series.ms, idx: i, crossPct: (mid - cur) / mid };
    }
  }
  return null;
}

/**
 * 判定一次命中。
 *
 * @param {object} chan 次级别的 analyzeChan 结果
 * @param {object} series 次级别序列
 * @param {number} idx 最后一根已收盘K线下标
 * @param {string} side 'down'（做多，找向下一笔的反弹）| 'up'（做空，找向上一笔的回落）
 * @param {object} opt { minBars, minPullBars, needDivergence }
 * @returns {object|null}
 */
export function halfHit(chan, series, idx, side, opt = {}) {
  const minBars = Number(opt.minBars ?? 5);
  const minPullBars = Number(opt.minPullBars ?? 5);
  const st = lastStrokeOf(chan, series, idx, side);
  if (!st) return null;
  if (!(st.bars >= minBars)) return null;          // 最后一笔高低点之间不少于 5 根K线

  // 次级别回调（反弹）根数：从这笔的终点到当前已经走了多少根
  const pullBars = Math.max(0, idx - st.toIdx);
  if (!(pullBars >= minPullBars)) return null;

  const cross = crossedRecently(series, idx, st.mid, side);
  if (!cross) return null;

  // 背驰：价格创新低/新高，但这一笔的 MACD 面积比前一同向笔小
  const prev = prevSameStroke(chan, series, idx, side, st);
  let div = null;
  if (prev && prev.area > 0) {
    const newExtreme = side === 'down' ? st.low < prev.low : st.high > prev.high;
    const ratio = st.area / prev.area;
    div = { newExtreme, areaRatio: Math.round(ratio * 1000) / 1000, weaker: ratio < 1, ok: newExtreme && ratio < 1 };
  }

  const mode1 = !!(div && div.ok);      // 背驰 + 突破 50%
  const mode2 = true;                    // 只要突破 50%（背驰是加分项）
  if (!mode1 && !mode2) return null;

  return {
    side,
    stroke: { high: st.high, low: st.low, mid: st.mid, bars: st.bars, fromT: st.fromT, toT: st.toT, area: st.area },
    pullBars,
    crossAt: cross.at,
    crossPct: Math.round(cross.crossPct * 1e6) / 1e6,
    divergence: div,
    mode1, mode2,
    label: side === 'down'
      ? `最后一笔 ${st.bars} 根，反弹 ${(cross.crossPct * 100).toFixed(2)}% 越过 50%`
      : `最后一笔 ${st.bars} 根，回落 ${(cross.crossPct * 100).toFixed(2)}% 跌破 50%`,
  };
}

/** 参数归一化 */
export function halfOptions(input = {}, cfg = {}) {
  const pick = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const axis = input.axis === 'above' || input.axis === 'below' ? input.axis : 'all';
  const mode = input.mode === '1' || input.mode === '2' ? input.mode : 'all';
  return {
    minBars: pick(input.minBars ?? cfg.halfMinBars, 5),
    minPullBars: pick(input.minPullBars ?? cfg.halfMinPullBars, 5),
    topN: pick(input.topN ?? cfg.halfTopN, 500),
    axis,     // all | above（只看零轴上/只做多）| below（只看零轴下/只做空）
    mode,     // all | 1（只要背驰）| 2（只要 50% 突破）
  };
}

/** 排序：刚突破的在前，然后笔越长、排名越前 */
export function compareHalf(x, y) {
  const a = Number.isFinite(y.crossAt) ? y.crossAt : 0;
  const b = Number.isFinite(x.crossAt) ? x.crossAt : 0;
  if (a !== b) return a - b;
  if ((y.stroke?.bars || 0) !== (x.stroke?.bars || 0)) return (y.stroke?.bars || 0) - (x.stroke?.bars || 0);
  return (x.rank || 9999) - (y.rank || 9999);
}
