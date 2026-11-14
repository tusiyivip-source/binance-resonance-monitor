/**
 * 「阳内阴回踩」策略。
 *
 * 监控级别：15分 / 30分 / 1小时 / 2小时 / 3小时 / 4小时 / 6小时 / 12小时（各自独立）
 *
 * 形态（看最新一根**已收盘**K线）：
 *   ① 前一根是**阳线**（收 > 开）
 *   ② 当前这根是**阴线**（收 < 开）
 *   ③ 当前这根**被前一根阳线完全包含**：最高 ≤ 前最高，最低 ≥ 前最低
 *   ④ 收盘**没有跌破**前一根阳线的开盘价（收 ≥ 前开盘）
 *
 * 含义：涨了一根之后小幅回踩，整根K线都缩在阳线里面，收盘还守在阳线实体底部之上 ——
 * 抛压不大，是回踩而不是反转。
 *
 * 筛选：级别、零轴位置（按当前这根收盘时的 DIF 判）。
 */

export const CROSS_PB_LEVELS = ['15m', '30m', '1h', '2h', '3h', '4h', '6h', '12h'];

/**
 * @param {object} series 该级别K线
 * @param {object} ind series.ensure()（要 macd.dif 判零轴）
 * @param {number} idx 最后一根已收盘K线下标
 * @param {object} opt { axis, level }
 */
export function crossPullbackAt(series, ind, idx, opt = {}) {
  if (!series || !Number.isFinite(idx) || idx < 2) return [];
  const axis = opt.axis === 'above' || opt.axis === 'below' ? opt.axis : 'all';
  const want = opt.side === 'long' || opt.side === 'short' ? opt.side : 'all';
  // inner = 只单K包覆；dbl = 只双K包覆；all = 全部
  const pat = opt.pattern === 'dbl' ? 'dbl' : opt.pattern === 'inner' ? 'inner' : 'all';

  const o = series.o, c = series.c, h = series.h, l = series.l;
  const i = idx;          // 当前：被包含的那根
  const s = idx - 1;      // 前一根：包含者
  if (s < 0) return [];
  const so = o[s], sc = c[s], sh = h[s], sl = l[s];
  const co = o[i], cc = c[i], ch = h[i], cl = l[i];
  if (![so, sc, sh, sl, co, cc, ch, cl].every(Number.isFinite)) return [];

  // 零轴：按当前这根收盘时的 DIF
  const m = ind?.macd;
  const difv = m?.dif ? m.dif[i] : NaN;
  const deav = m?.dea ? m.dea[i] : NaN;
  const axisSide = Number.isFinite(difv) ? (difv > 0 ? 'above' : 'below') : 'above';
  if (axis !== 'all') {
    if (!Number.isFinite(difv)) return [];
    if (axisSide !== axis) return [];
  }

  const out = [];

  // ① 阳内阴（做多）：前一根阳线，当前阴线被它完全包含，收盘没跌破阳线最低价
  if (want !== 'short' && pat !== 'dbl') {
    const okYangYin = (sc > so) && (cc < co)
      && (ch <= sh) && (cl >= sl)
      && (cc >= sl);
    if (okYangYin) {
      const retrace = ((sc - cc) / (sc - so)) * 100;   // 阴线回吐阳线实体的百分比
      out.push({
        dir: 'long',
        crossIdx: i,
        crossT: series.t[i] + series.ms,
        crossDif: Number.isFinite(difv) ? Math.round(difv * 1e8) / 1e8 : 0,
        crossDea: Number.isFinite(deav) ? Math.round(deav * 1e8) / 1e8 : 0,
        axisSide,
        depth: 0, depthLabel: '当根', barsSinceCross: 0,
        pivot: { o: so, c: sc, h: sh, l: sl, t: series.t[s] + series.ms },
        pullFirst: Math.round(cc * 1e8) / 1e8,
        surge: {
          gainPct: Math.round(((cc - co) / co) * 10000) / 100,
          volRatio: 0,
          retrace: Math.round(retrace * 100) / 100,
        },
        open: co, close: cc, high: ch, low: cl,
        prevOpen: so, prevClose: sc, prevHigh: sh, prevLow: sl,
        at: series.t[i] + series.ms,
        variant: 'long',
        variantLabel: '阳内阴（回吐 ' + Math.round(retrace) + '%）',
      });
    }
  }

  // ② 阴内阳（做空）：前一根阴线，当前阳线被它完全包含，收盘没涨破阴线最高价
  if (want !== 'long' && pat !== 'dbl') {
    const okYinYang = (sc < so) && (cc > co)
      && (ch <= sh) && (cl >= sl)
      && (cc <= sh);
    if (okYinYang) {
      const retrace = ((cc - sc) / (so - sc)) * 100;   // 阳线收复阴线实体的百分比
      out.push({
        dir: 'short',
        crossIdx: i,
        crossT: series.t[i] + series.ms,
        crossDif: Number.isFinite(difv) ? Math.round(difv * 1e8) / 1e8 : 0,
        crossDea: Number.isFinite(deav) ? Math.round(deav * 1e8) / 1e8 : 0,
        axisSide,
        depth: 0, depthLabel: '当根', barsSinceCross: 0,
        pivot: { o: so, c: sc, h: sh, l: sl, t: series.t[s] + series.ms },
        pullFirst: Math.round(cc * 1e8) / 1e8,
        surge: {
          gainPct: Math.round(((cc - co) / co) * 10000) / 100,
          volRatio: 0,
          retrace: Math.round(retrace * 100) / 100,
        },
        open: co, close: cc, high: ch, low: cl,
        prevOpen: so, prevClose: sc, prevHigh: sh, prevLow: sl,
        at: series.t[i] + series.ms,
        variant: 'short',
        variantLabel: '阴内阳（收回 ' + Math.round(retrace) + '%）',
      });
    }
  }

  // ③ 双阳包一阴（做多）：前两根都是阳线，合起来包住更前面那根阴线的实体
  if (want !== 'short' && pat !== 'inner') {
    const y = idx - 2;
    if (y >= 0) {
      const yo2 = o[y], yc2 = c[y];
      const a1o = o[y + 1], a1c = c[y + 1];
      const a2o = o[i], a2c = c[i];
      if ([yo2, yc2, a1o, a1c, a2o, a2c].every(Number.isFinite)
        && yc2 < yo2                       // 被包的那根是阴
        && a1c > a1o && a2c > a2o          // 两根都是阳
        && a1o <= yc2                      // 第一根阳线开盘 ≤ 阴线收盘
        && a2c >= yo2) {                   // 第二根阳线收盘 ≥ 阴线开盘
        const retrace = Math.max(0, Math.min(100, ((a2c - yc2) / (yo2 - yc2)) * 100));   // 包住了阴线实体的百分之多少
        out.push({
          dir: 'long',
          crossIdx: i,
          crossT: series.t[i] + series.ms,
          crossDif: Number.isFinite(difv) ? Math.round(difv * 1e8) / 1e8 : 0,
          crossDea: Number.isFinite(deav) ? Math.round(deav * 1e8) / 1e8 : 0,
          axisSide,
          depth: 0, depthLabel: '当根', barsSinceCross: 0,
          pivot: { o: yo2, c: yc2, h: h[y], l: l[y], t: series.t[y] + series.ms },
          pullFirst: Math.round(a2c * 1e8) / 1e8,
          surge: {
            gainPct: Math.round(((a2c - a2o) / a2o) * 10000) / 100,
            volRatio: 0,
            retrace: Math.round(retrace * 100) / 100,
          },
          open: a2o, close: a2c, high: h[i], low: l[i],
          prevOpen: yo2, prevClose: yc2, prevHigh: h[y], prevLow: l[y],
          at: series.t[i] + series.ms,
          variant: 'long',
          variantLabel: '双阳包阴（包住 ' + Math.round(retrace) + '%）',
        });
      }
    }
  }

  // ④ 双阴包一阳（做空）：前两根都是阴线，合起来包住更前面那根阳线的实体
  if (want !== 'long' && pat !== 'inner') {
    const y = idx - 2;
    if (y >= 0) {
      const yo2 = o[y], yc2 = c[y];
      const a1o = o[y + 1], a1c = c[y + 1];
      const a2o = o[i], a2c = c[i];
      if ([yo2, yc2, a1o, a1c, a2o, a2c].every(Number.isFinite)
        && yc2 > yo2                       // 被包的那根是阳
        && a1c < a1o && a2c < a2o          // 两根都是阴
        && a1o >= yc2                      // 第一根阴线开盘 ≥ 阳线收盘
        && a2c <= yo2) {                   // 第二根阴线收盘 ≤ 阳线开盘
        const retrace = Math.max(0, Math.min(100, ((yc2 - a2c) / (yc2 - yo2)) * 100));   // 包住了阳线实体的百分之多少
        out.push({
          dir: 'short',
          crossIdx: i,
          crossT: series.t[i] + series.ms,
          crossDif: Number.isFinite(difv) ? Math.round(difv * 1e8) / 1e8 : 0,
          crossDea: Number.isFinite(deav) ? Math.round(deav * 1e8) / 1e8 : 0,
          axisSide,
          depth: 0, depthLabel: '当根', barsSinceCross: 0,
          pivot: { o: yo2, c: yc2, h: h[y], l: l[y], t: series.t[y] + series.ms },
          pullFirst: Math.round(a2c * 1e8) / 1e8,
          surge: {
            gainPct: Math.round(((a2c - a2o) / a2o) * 10000) / 100,
            volRatio: 0,
            retrace: Math.round(retrace * 100) / 100,
          },
          open: a2o, close: a2c, high: h[i], low: l[i],
          prevOpen: yo2, prevClose: yc2, prevHigh: h[y], prevLow: l[y],
          at: series.t[i] + series.ms,
          variant: 'short',
          variantLabel: '双阴包阳（包住 ' + Math.round(retrace) + '%）',
        });
      }
    }
  }

  return out;
}

/** 参数归一化 */
export function crossPbOptions(input = {}, cfg = {}) {
  const num = (v, d, min, max) => (v == null || v === '' || !Number.isFinite(Number(v))
    ? d : Math.max(min, Math.min(max, Number(v))));
  const lv = String(input.level ?? 'all');
  return {
    axis: input.axis === 'above' || input.axis === 'below' ? input.axis : 'all',
    // all / long（只阳内阴）/ short（只阴内阳）
    side: input.side === 'long' || input.side === 'short' ? input.side : 'all',
    pattern: input.pattern === 'dbl' ? 'dbl' : input.pattern === 'inner' ? 'inner' : 'all',
    level: CROSS_PB_LEVELS.includes(lv) ? lv : 'all',
    topN: Math.round(num(input.topN, cfg.crossPbTopN ?? 500, 1, 800)),
  };
}


/** 排序：先按收盘时间倒序（刚收的在前），同一根再按回吐/回补从小到大 */
export function compareCrossPb(x, y) {
  const ax = Number.isFinite(x.at) ? x.at : 0;
  const ay = Number.isFinite(y.at) ? y.at : 0;
  if (ax !== ay) return ay - ax;
  const rx = Number.isFinite(x.retrace) ? x.retrace : 1e9;
  const ry = Number.isFinite(y.retrace) ? y.retrace : 1e9;
  if (rx !== ry) return rx - ry;
  return (y.quoteVolume || 0) - (x.quoteVolume || 0);
}
