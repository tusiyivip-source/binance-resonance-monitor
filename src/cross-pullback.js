/**
 * 「阳包阴 / 阴包阳 → 回踩」策略（原「金叉回踩」，本轮去掉金叉、也去掉多根反包）。
 *
 * 监控级别：15分 / 30分 / 1小时 / 2小时 / 3小时 / 6小时 / 12小时（各自独立）
 *
 * 形态：
 *   做多：**阳包阴** —— 一根阳线的实体完全包住前一根阴线的实体
 *          （收 ≥ 前一根开盘，开 ≤ 前一根收盘）
 *   做空：**阴包阳** —— 一根阴线的实体完全包住前一根阳线的实体
 *
 * 触发：
 *   包覆成立后，先继续同向走，**第一次出现反向K线**就提醒（回踩 / 反弹开始），
 *   可以是第 1 根或第 2 根（由「回踩根数」筛选栏决定）。
 *
 * 量能：包覆那根要有量（成交量 ≥ 近 5 根均量 × volMult，默认 1.5）。
 * 零轴：看包覆那一刻 DIF 在零轴哪一侧（只作筛选/标注，不参与方向判断）。
 */

export const CROSS_PB_LEVELS = ['15m', '30m', '1h', '2h', '3h', '6h', '12h'];

/** 近 n 根均量（不含第 i 根本身） */
function avgVol(series, i, n = 5) {
  const v = series.v;
  if (!v) return 0;
  let s = 0, c = 0;
  for (let k = 1; k <= n; k++) {
    const j = i - k;
    if (j >= 0 && Number.isFinite(v[j])) { s += v[j]; c++; }
  }
  return c ? s / c : 0;
}

/**
 * 判断第 i 根是否是「实体包覆」。
 * @param {number} dir 1 = 阳包阴（前一根是阴），-1 = 阴包阳（前一根是阳）
 * @returns {{dir:number, volRatio:number, gainPct:number}|null}
 */
function engulfAt(series, i, dir, opt) {
  if (i < 1) return null;
  const o = series.o, c = series.c;
  const o0 = o[i - 1], c0 = c[i - 1], o1 = o[i], c1 = c[i];
  if (![o0, c0, o1, c1].every(Number.isFinite)) return null;

  if (dir > 0) {
    if (!(c0 < o0)) return null;            // 前一根必须是阴
    if (!(c1 > o1)) return null;            // 这根必须是阳
    if (!(c1 >= o0)) return null;           // 阳线收盘 ≥ 阴线开盘
    if (!(o1 <= c0)) return null;           // 阳线开盘 ≤ 阴线收盘
  } else {
    if (!(c0 > o0)) return null;            // 前一根必须是阳
    if (!(c1 < o1)) return null;            // 这根必须是阴
    if (!(o1 >= c0)) return null;           // 阴线开盘 ≥ 阳线收盘
    if (!(c1 <= o0)) return null;           // 阴线收盘 ≤ 阳线开盘
  }

  const av = avgVol(series, i, 5);
  const mult = Math.max(0, Number(opt.volMult ?? 1.5));
  const volRatio = av > 0 ? series.v[i] / av : 0;
  if (mult > 0 && !(volRatio >= mult)) return null;

  const gain = ((c1 - o1) / o1) * 100;
  return {
    dir,
    volRatio: Math.round(volRatio * 100) / 100,
    gainPct: Math.round(gain * 100) / 100,
  };
}

/**
 * @param {object} series 该级别K线
 * @param {object} ind series.ensure()（要 macd.dif 判零轴）
 * @param {number} idx 最后一根已收盘K线下标
 * @param {object} opt { depth, axis, volMult, lookbackBars }
 */
export function crossPullbackAt(series, ind, idx, opt = {}) {
  if (!series || !Number.isFinite(idx) || idx < 20) return null;
  // depth = 0 → 包覆那根收盘就提醒（默认）；1/2 → 等回踩第 N 根反向K线
  const depth = Math.max(0, Math.min(2, Number(opt.depth) || 0));
  const axis = opt.axis === 'above' || opt.axis === 'below' ? opt.axis : 'all';
  const look = Math.max(10, Math.min(120, Number(opt.lookbackBars ?? 60)));
  const o = series.o, c = series.c;

  // 从当前（或往前）找最近一次「包覆」
  const start = depth === 0 ? idx : idx - 1;
  for (let i = start; i >= Math.max(1, idx - look); i--) {
    for (const dir of [1, -1]) {
      const eng = engulfAt(series, i, dir, opt);
      if (!eng) continue;

      let f = i;                                            // 触发那根的索引
      if (depth === 0) {
        // 最新的收盘K 本身就是包覆K线 —— 直接提醒
        if (i !== idx) continue;
      } else {
        // 包覆之后第一根反向K线
        f = -1;
        for (let k = i + 1; k <= idx; k++) {
          if (!Number.isFinite(c[k]) || !Number.isFinite(o[k])) break;
          const isReverse = dir > 0 ? (c[k] < o[k]) : (c[k] > o[k]);
          if (isReverse) { f = k; break; }
        }
        if (f < 0) continue;                                // 还没开始回踩
        if (idx !== f + depth - 1) continue;                // 当前正好是第 depth 根
        let allReverse = true;
        for (let k = f; k <= idx; k++) {
          const isReverse = dir > 0 ? (c[k] < o[k]) : (c[k] > o[k]);
          if (!isReverse) { allReverse = false; break; }
        }
        if (!allReverse) continue;
      }

      // 零轴：看包覆那一刻的 DIF
      const m = ind?.macd;
      const difv = m?.dif ? m.dif[i] : NaN;
      const deav = m?.dea ? m.dea[i] : NaN;
      const axisSide = Number.isFinite(difv) ? (difv > 0 ? 'above' : 'below') : 'above';
      if (axis !== 'all') {
        if (!Number.isFinite(difv)) continue;
        if (axisSide !== axis) continue;
      }

      return {
        dir: dir > 0 ? 'long' : 'short',
        crossIdx: i,
        crossT: series.t[i] + series.ms,
        crossDif: Number.isFinite(difv) ? Math.round(difv * 1e8) / 1e8 : 0,
        crossDea: Number.isFinite(deav) ? Math.round(deav * 1e8) / 1e8 : 0,
        axisSide,
        depth,
        barsSinceCross: idx - i,
        pivot: { o: o[i], c: c[i], t: series.t[i] + series.ms },
        pullFirst: Math.round(c[f] * 1e8) / 1e8,
        surge: { gainPct: eng.gainPct, volRatio: eng.volRatio },
        open: o[idx], close: c[idx],
        at: series.t[idx] + series.ms,
        variant: dir > 0 ? 'long' : 'short',
        variantLabel: dir > 0 ? '阳包阴' : '阴包阳',
        depthLabel: depth === 0 ? '当根' : ('回踩 ' + depth + ' 根'),
      };
    }
  }
  return null;
}

/** 参数归一化 */
export function crossPbOptions(input = {}, cfg = {}) {
  const num = (v, d, min, max) => (v == null || v === '' || !Number.isFinite(Number(v))
    ? d : Math.max(min, Math.min(max, Number(v))));
  const depth = num(input.depth ?? cfg.crossPbDepth, 0, 0, 2);   // 默认 0 = 包覆当根
  const lv = String(input.level ?? 'all');
  const requireVol = input.surge !== '0' && input.surge !== 'off';
  return {
    depth: Math.round(depth),
    axis: input.axis === 'above' || input.axis === 'below' ? input.axis : 'all',
    level: CROSS_PB_LEVELS.includes(lv) ? lv : 'all',
    volMult: requireVol ? num(input.vol, cfg.crossPbVolMult ?? 1.5, 1, 10) : 0,
    lookbackBars: Math.round(num(input.look, cfg.crossPbLookback ?? 60, 10, 120)),
    topN: Math.round(num(input.topN, cfg.crossPbTopN ?? 500, 1, 800)),
  };
}

/** 排序：包覆越新鲜越靠前 */
export function compareCrossPb(x, y) {
  const bx = Number.isFinite(x.barsSinceCross) ? x.barsSinceCross : 1e9;
  const by = Number.isFinite(y.barsSinceCross) ? y.barsSinceCross : 1e9;
  if (bx !== by) return bx - by;
  const a = Number.isFinite(y.at) ? y.at : 0;
  const b = Number.isFinite(x.at) ? x.at : 0;
  return a - b;
}
