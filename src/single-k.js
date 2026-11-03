/**
 * 策略：**单K推动 + 回调不破**
 *
 *   做多（大阳线）：
 *     ① 单K：阳线，实体涨幅 ≥ minGainPct，且实体 ≥ 近 N 根平均实体 × mult
 *     ② 回踩：这根K线之后出现回调（当前收盘低于它的收盘价）
 *     ③ 不破：回调期间**所有收盘都没跌破这根K线的最低价**
 *     ④ 涨幅大于回踩：回调幅度（%）小于这根K线的涨幅（%）
 *
 *   做空（大阴线，反向镜像）：
 *     ① 单K：阴线，实体跌幅 ≥ minGainPct，且实体 ≥ 平均实体 × mult
 *     ② 反抽：当前收盘高于它的收盘价
 *     ③ 不破：反抽期间**所有收盘都没涨破这根K线的最高价**
 *     ④ 跌幅大于反抽：反抽幅度（%）小于这根K线的跌幅（%）
 *
 * 只监控涨幅榜前 N 名（默认 200）——这类形态靠的是资金推动，
 * 排名靠后的币缺乏承接，同样的K线更容易假突破。
 */

/** 参与扫描的级别 */
export const SINGLE_K_LEVELS = ['15m', '30m', '1h', '2h', '3h', '4h', '6h'];

/** 那根单K发生时，MACD 的 DIF 在零轴的哪一侧 */
export const SINGLE_K_ZERO_SIDES = ['all', 'above', 'below'];

const ZERO_SIDE_LABEL = { all: '不限', above: '零轴上', below: '零轴下' };
export const zeroSideLabel = s => ZERO_SIDE_LABEL[s] || ZERO_SIDE_LABEL.all;

export function singleKOptions(input = {}, cfg = {}) {
  const num = (v, d, min, max) => v == null || v === '' || !Number.isFinite(Number(v))
    ? d : Math.max(min, Math.min(max, Number(v)));
  const wantZero = String(input.zero ?? cfg.singleKZeroSide ?? 'all');
  return {
    minGainPct: num(input.gain, cfg.singleKMinGainPct ?? 2, 0.1, 50),   // 单K涨/跌幅下限（%）
    mult: num(input.mult, cfg.singleKMult ?? 1.5, 1, 20),               // 实体 ≥ 平均实体 × mult
    lookback: Math.round(num(input.lookback, cfg.singleKLookback ?? 20, 3, 120)),
    maxAfter: Math.round(num(input.after, cfg.singleKMaxAfter ?? 12, 1, 60)), // 回踩/反抽最多持续多少根
    topN: Math.round(num(input.topN, cfg.singleKTopN ?? 200, 1, 400)),
    // 单K发生在零轴上方 / 下方；'all' 不限
    zeroSide: SINGLE_K_ZERO_SIDES.includes(wantZero) ? wantZero : 'all',
  };
}

/**
 * 在 series 的 idx 处判定「单K推动 + 回调不破」。
 * @param {number} dir 1 = 做多（大阳线）；-1 = 做空（大阴线）
 * @param {object|null} ind series.ensure() 的结果，用来读 DIF 判断零轴位置
 * @returns {{dir,zeroSide,dif,bigIdx,...}|null}
 */
export function singleKAt(series, idx, opt, dir = 1, ind = null) {
  if (!series || !Number.isFinite(idx) || idx < 10) return null;
  const long = dir > 0;
  const look = opt.lookback;
  const from = Math.max(0, idx - look);
  const wantZero = opt.zeroSide && opt.zeroSide !== 'all' ? opt.zeroSide : null;
  // 要求按零轴方向筛选、却没给指标 → 不猜，直接不成立（fail closed）
  if (wantZero && !ind?.macd?.dif) return null;

  // 基准实体：用候选K线**之前**的一段算，不能把自己算进去
  const avgBody = (i) => {
    const a = Math.max(0, i - look - 10), b = i;
    if (b <= a) return 0;
    let s = 0;
    for (let k = a; k < b; k++) s += Math.abs(series.c[k] - series.o[k]);
    return s / (b - a);
  };

  // 从当前往前找最近一根「大阳线 / 大阴线」
  for (let i = idx; i >= from && i >= 1; i--) {
    const o = series.o[i], c = series.c[i];
    if (long ? !(c > o) : !(c < o)) continue;           // 方向要对
    const body = Math.abs(c - o);
    const pct = o > 0 ? (body / o) * 100 : 0;
    if (pct < opt.minGainPct) continue;                  // ① 幅度够大
    const avg = avgBody(i);
    if (!(avg > 0) || body < avg * opt.mult) continue;   // ① 实体够大

    const barsAfter = idx - i;
    if (barsAfter < 1 || barsAfter > opt.maxAfter) continue;   // ② 之后有回调，且不过期

    // 零轴位置：看「这根单K发生时」的 DIF 在哪一侧。
    // 用单K当根的 DIF，而不是当前根 —— 形态的意义在于推动发生时的动能位置。
    const dif = ind?.macd?.dif ? ind.macd.dif[i] : NaN;
    const side = Number.isFinite(dif) ? (dif > 0 ? 'above' : 'below') : null;
    if (wantZero && side !== wantZero) continue;               // 指定的那一侧才要

    // ②③④ 回调期间的表现
    const bigLow = series.l[i], bigHigh = series.h[i];
    let minClose = c, maxClose = c;
    for (let k = i + 1; k <= idx; k++) {
      if (series.c[k] < minClose) minClose = series.c[k];
      if (series.c[k] > maxClose) maxClose = series.c[k];
    }
    const closeNow = series.c[idx];
    let retracePct, line;
    if (long) {
      if (!(closeNow < c)) continue;                     // ② 确实在回踩
      if (minClose < bigLow) continue;                   // ③ 收盘跌破最低价 → 破位
      retracePct = ((c - minClose) / c) * 100;
      line = bigLow;
    } else {
      if (!(closeNow > c)) continue;                     // ② 确实在反抽
      if (maxClose > bigHigh) continue;                  // ③ 收盘涨破最高价 → 破位
      retracePct = ((maxClose - c) / c) * 100;
      line = bigHigh;
    }
    if (!(retracePct < pct)) continue;                   // ④ 回踩/反抽幅度 < 单K幅度

    return {
      dir: long ? 'long' : 'short',
      bigIdx: i, open: o, close: c, low: bigLow, high: bigHigh,
      line,                                              // 不破线（多=最低价 / 空=最高价）
      bodyPct: pct, mult: body / avg, body,
      minClose, maxClose, closeNow, retracePct, barsAfter,
      // 那根单K发生时 MACD DIF 在零轴的哪一侧
      dif: Number.isFinite(dif) ? dif : null,
      zeroSide: side,
      t: series.t[i], at: series.t[idx] + series.ms,
    };
  }
  return null;
}
