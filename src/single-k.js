/**
 * 「一阳穿三阴」形态（原「单K回踩不破」升级版）。
 *
 * 成立条件：
 *   ① 触发的那根是**阳线**（收 > 开）
 *   ② 它前面最近三根是**阴线**；最近一根可以是十字星，但不能是阳线
 *   ③ 一阳穿三阴：阳线**收盘价 > 这三根里最高的开盘价**
 *   ④ 下跌段至少 5 根（从最近一根往前数「收 ≤ 开」的连续根数）
 *   ⑤ 可选：按那根阳线当时的 DIF 在零轴上/下做筛选
 *
 * 另外两道筛子在引擎侧：只做多、上级级别必须金叉同向。
 */

/** 参与扫描的级别 */
export const SINGLE_K_LEVELS = ['15m', '30m', '1h', '2h', '3h', '4h', '6h'];

/**
 * 单K卡片的「上级确认级别」。
 * 例：15 分钟的单K不破，要跟 2 小时同方向、且 2 小时处于金叉状态才留下。
 * 对应关系沿用多级别配对的思路（15→2时、30→3时、1时→6时）。
 */
export const SINGLE_K_CONFIRM = {
  '15m': '2h',
  '30m': '3h',
  '1h': '6h',
  '2h': '12h',
  '3h': '1d',
  '4h': '1d',
  '6h': '1d',
};

/** 取某个单K级别对应的确认级别；没配就返回 null */
export function confirmLevelOf(level) {
  return SINGLE_K_CONFIRM[level] || null;
}

/** 那根单K发生时，MACD 的 DIF 在零轴的哪一侧 */
export const SINGLE_K_ZERO_SIDES = ['all', 'above', 'below'];

const ZERO_SIDE_LABEL = { all: '不限', above: '零轴上', below: '零轴下' };
export const zeroSideLabel = s => ZERO_SIDE_LABEL[s] || ZERO_SIDE_LABEL.all;

export function singleKOptions(input = {}, cfg = {}) {
  const num = (v, d, min, max) => v == null || v === '' || !Number.isFinite(Number(v))
    ? d : Math.max(min, Math.min(max, Number(v)));
  const wantZero = String(input.zero ?? cfg.singleKZeroSide ?? 'all');
  return {
    minDownBars: Math.round(num(input.down, cfg.singleKMinDownBars ?? 5, 3, 60)),  // 下跌段至少几根
    mult: num(input.mult, cfg.singleKMult ?? 1.5, 1, 20),               // 实体 ≥ 平均实体 × mult
    lookback: Math.round(num(input.lookback, cfg.singleKLookback ?? 20, 3, 120)),
    topN: Math.round(num(input.topN, cfg.singleKTopN ?? 200, 1, 400)),
    // 单K发生在零轴上方 / 下方；'all' 不限
    zeroSide: SINGLE_K_ZERO_SIDES.includes(wantZero) ? wantZero : 'all',
  };
}

/**
 * 在 series 的 idx 处判定「一阳穿三阴」。
 * @param {number} dir 只支持 1（形态本身只做多）
 * @param {object|null} ind series.ensure() 的结果，用来读 DIF 判断零轴位置
 */
export function singleKAt(series, idx, opt, dir = 1, ind = null) {
  // 形态改为「一阳穿三阴」，本质上只做多
  if (dir < 0) return null;
  if (!series || !Number.isFinite(idx) || idx < 8) return null;

  const o = series.o[idx], c = series.c[idx], h = series.h[idx], l = series.l[idx];
  if (![o, c, h, l].every(Number.isFinite)) return null;
  if (!(c > o)) return null;                       // 触发的那根必须是阳线

  // —— 最近三根：阴线；最后一根可以是十字星，但不能是阳 ——
  const k1 = idx - 1, k2 = idx - 2, k3 = idx - 3;
  const o1 = series.o[k1], c1 = series.c[k1];
  const o2 = series.o[k2], c2 = series.c[k2];
  const o3 = series.o[k3], c3 = series.c[k3];
  if (![o1, c1, o2, c2, o3, c3].every(Number.isFinite)) return null;

  if (!(c3 < o3)) return null;                     // 第三根：阴
  if (!(c2 < o2)) return null;                     // 第二根：阴
  if (!(c1 <= o1)) return null;                    // 最近一根：阴或十字星（收 ≤ 开），不能是阳

  // —— 一阳穿三阴：收盘价必须高于这三根里最高的开盘价 ——
  const maxOpen = Math.max(o1, o2, o3);
  if (!(c > maxOpen)) return null;

  // —— 下跌段至少 N 根（默认 5）：从这一段的高点算到最后一根阴线 ——
  //   ⚠ 不能要求「5 根连续阴线」——那样真实命中率只有 0.2%，等于没有信号。
  //     这里按「下跌段」算：在最近一段窗口里找到最高价，从它跌到最后一根阴线走了几根。
  const needDown = Math.max(3, Number(opt.minDownBars ?? 5));
  const winFrom = Math.max(0, k1 - Math.max(30, needDown * 4));
  let peakIdx = k1, peakHigh = -Infinity;
  for (let k = k1; k >= winFrom; k--) {
    const hk = series.h[k];
    if (Number.isFinite(hk) && hk > peakHigh) { peakHigh = hk; peakIdx = k; }
  }
  const downBars = (k1 - peakIdx) + 1;      // 高点到最后一根阴线（含）
  if (!(downBars >= needDown)) return null;   // 「下跌段至少 N 根」

  // 连续阴线根数：界面/推送里展示这个更直观（真正连着几根阴）
  let yinRun = 0;
  for (let k = k1; k >= 0; k--) {
    if (!(series.c[k] <= series.o[k])) break;
    yinRun++;
    if (yinRun >= 200) break;
  }
  if (yinRun < 3) return null;


  // —— 零轴筛选：看这根阳线当时的 DIF ——
  const wantZero = opt.zeroSide && opt.zeroSide !== 'all' ? opt.zeroSide : null;
  if (wantZero && !ind?.macd?.dif) return null;
  const dif = ind?.macd?.dif ? ind.macd.dif[idx] : NaN;
  const side = Number.isFinite(dif) ? (dif > 0 ? 'above' : 'below') : null;
  if (wantZero && side !== wantZero) return null;

  // 阳线实体相对近 N 根平均实体（仅用于展示强度，不作为门槛）
  const look = Math.max(3, Number(opt.lookback ?? 20));
  const a = Math.max(0, idx - look), b = idx;
  let sumBody = 0;
  for (let k = a; k < b; k++) sumBody += Math.abs(series.c[k] - series.o[k]);
  const avg = b > a ? sumBody / (b - a) : 0;
  const body = c - o;
  const bodyPct = o > 0 ? (body / o) * 100 : 0;
  const piercePct = maxOpen > 0 ? ((c - maxOpen) / maxOpen) * 100 : 0;

  return {
    dir: 'long',
    bigIdx: idx,
    open: o, close: c, low: l, high: h,
    line: maxOpen,                                 // 关键位：三阴里最高的开盘价（图上画横线）
    bodyPct,
    mult: avg > 0 ? body / avg : 0,
    body,
    // 复用旧字段，语义对应到新形态，界面/推送不用大改
    retracePct: piercePct,                         // 穿透幅度（%）
    barsAfter: yinRun,                             // 连续阴线根数（展示用）
    downBars,                                      // 高点到最后一根阴线的距离（参与门槛）
    minClose: Math.min(c1, c2, c3), maxClose: Math.max(c1, c2, c3),
    closeNow: c,
    dif: Number.isFinite(dif) ? dif : null,
    zeroSide: side,
    t: series.t[idx], at: series.t[idx] + series.ms,
  };
}
