/**
 * 「配对反转提醒」的额外择时条件。
 *
 * 背景：配对共振（主级别零轴上 + 次级别回踩不破）只管「方向对不对」，
 * 不管「现在是不是该动手」。这里在共振成立的基础上，再加一道**次级别**的确认：
 *
 *   做多：回踩至少 N 根（默认 5）之后，最近两根**已收盘**K线
 *         ① 都是阳线（收 > 开）
 *         ② 低点不再往下移（第二根最低价 ≥ 第一根最低价）—— 即「止跌」
 *
 *   做空：镜像 —— 反弹至少 N 根之后，两根都是阴线，且高点不再往上移（止涨）
 *
 * 只吃已收盘的K线：用盘中那根判断会反复闪烁（一根K线没走完就先报，收完又撤销）。
 */

/** 取第 i 根K线的四个价，任何一个不是有限数就返回 null */
function candleAt(series, i) {
  if (!series || i < 0 || i >= series.t.length) return null;
  const o = series.o[i], h = series.h[i], l = series.l[i], c = series.c[i];
  if (![o, h, l, c].every(Number.isFinite)) return null;
  return { o, h, l, c, t: series.t[i] };
}

/**
 * @param {object} series 次级别K线序列（需要 o/h/l/c/t 数组）
 * @param {number} idx 最后一根**已收盘**K线的下标
 * @param {number} dir 1 = 做多，-1 = 做空
 * @param {number} minPullBars 回踩/反弹至少要几根
 * @param {number} pullBars 实际回踩/反弹根数（来自 levelZeroAt）
 * @returns {object|null} 命中时返回证据，否则 null
 */
export function reboundHit(series, idx, dir, minPullBars, pullBars) {
  const need = Math.max(1, Number(minPullBars) || 5);
  if (!Number.isFinite(idx) || idx < 1) return null;
  if (!Number.isFinite(pullBars) || pullBars < need) return null;

  const c1 = candleAt(series, idx - 1);
  const c2 = candleAt(series, idx);
  if (!c1 || !c2) return null;
  // 两根K线必须相邻（中间有跳空说明数据断了，不算连续）
  if (series.ms && c2.t - c1.t !== series.ms) return null;

  const bull1 = c1.c > c1.o, bull2 = c2.c > c2.o;
  const bear1 = c1.c < c1.o, bear2 = c2.c < c2.o;

  if (dir > 0) {
    if (!(bull1 && bull2)) return null;
    if (!(c2.l >= c1.l)) return null;              // 低点还在往下移 → 没止跌
    return {
      reboundAt: c2.t + series.ms,                 // 这根K线收盘的时刻
      pullBars,
      needBars: need,
      twoUp: true,
      stopMove: true,
      label: `回踩 ${pullBars} 根后连续两根阳K、低点抬高`,
      c1: { o: c1.o, h: c1.h, l: c1.l, c: c1.c },
      c2: { o: c2.o, h: c2.h, l: c2.l, c: c2.c },
    };
  }

  if (!(bear1 && bear2)) return null;
  if (!(c2.h <= c1.h)) return null;                // 高点还在往上移 → 没止涨
  return {
    reboundAt: c2.t + series.ms,
    pullBars,
    needBars: need,
    twoUp: false,
    stopMove: true,
    label: `反弹 ${pullBars} 根后连续两根阴K、高点降低`,
    c1: { o: c1.o, h: c1.h, l: c1.l, c: c1.c },
    c2: { o: c2.o, h: c2.h, l: c2.l, c: c2.c },
  };
}

/** 参数归一化 */
export function reboundOptions(input = {}, cfg = {}) {
  const pick = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    minPullBars: pick(input.minPullBars ?? cfg.pairReboundMinPullBars, 5),
    topN: pick(input.topN ?? cfg.pairReboundTopN, 500),
    side: input.side === 'long' || input.side === 'short' ? input.side : 'all',
  };
}

/** 排序：刚触发的排前面，同一时刻按回踩根数、排名 */
export function compareRebound(x, y) {
  const a = Number.isFinite(y.reboundAt) ? y.reboundAt : 0;
  const b = Number.isFinite(x.reboundAt) ? x.reboundAt : 0;
  if (a !== b) return a - b;
  if ((y.pullBars || 0) !== (x.pullBars || 0)) return (y.pullBars || 0) - (x.pullBars || 0);
  return (x.rank || 9999) - (y.rank || 9999);
}
