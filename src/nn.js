/**
 * 「牛牛盯盘」视图的判定逻辑（从参考页移植，跑在我们自己的数据上）。
 *
 * 每个 (币种 × 当前周期) 算三个标记：
 *   _dbl  双阴不破（多） / 双阳不破（空）—— 大K启动后连收两根反向K，收盘没跌破/涨破均线
 *   _mz   MACD 快慢线是否都在零轴上方(1) / 都下方(-1) / 其他(0)
 *   _pb   顺势回调结构：零上(+1)回调 / 零下(-1)反弹，其余 0
 */

/** 可切换的周期（顺序与参考页一致，去掉我们没有的 3d） */
export const NN_INTERVALS = [
  ['3m', '3分钟'], ['5m', '5分钟'], ['15m', '15分钟'], ['30m', '30分钟'],
  ['1h', '1小时'], ['2h', '2小时'], ['3h', '3小时'], ['4h', '4小时'],
  ['6h', '6小时'], ['12h', '12小时'], ['1d', '日线'],
];

export const NN_MODES = [['gain', '涨幅'], ['loss', '跌幅'], ['vol', '成交额']];
export const NN_PB = [['all', '全部'], ['top', '↘零上回调'], ['bottom', '↗零下反弹']];

/* ---------------- 基础指标（客户端也复用同一份） ---------------- */

/** 简单均线；不足周期返回 NaN */
export function smaArr(vals, n) {
  const out = new Array(vals.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 指数均线；首值用前 n 个的均值起算 */
export function emaArr(vals, n) {
  const out = new Array(vals.length).fill(NaN);
  const k = 2 / (n + 1);
  let e = null, cnt = 0, sum = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!Number.isFinite(v)) continue;
    if (e === null) {
      sum += v; cnt++;
      if (cnt >= n) e = sum / cnt;
      out[i] = e;
      continue;
    }
    e = v * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** MACD(12,26,9)，柱按中文惯例 ×2 */
export function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  const ef = emaArr(closes, fast), es = emaArr(closes, slow);
  const dif = closes.map((_, i) => (Number.isFinite(ef[i]) && Number.isFinite(es[i]) ? ef[i] - es[i] : NaN));
  const dea = emaArr(dif, signal);
  const hist = dif.map((d, i) => (Number.isFinite(d) && Number.isFinite(dea[i]) ? (d - dea[i]) * 2 : NaN));
  return { dif, dea, hist };
}

/** 缓存在 series 上，避免每次重算 */
export function nnLines(series) {
  if (series._nnLines) return series._nnLines;
  const closes = Array.from(series.c);
  series._nnLines = [
    { name: 'EMA5', arr: emaArr(closes, 5) },
    { name: 'EMA7', arr: emaArr(closes, 7) },
    { name: 'MA5', arr: smaArr(closes, 5) },
    { name: 'MA7', arr: smaArr(closes, 7) },
  ];
  series._nnMacd = computeMACD(closes);
  return series._nnLines;
}
export function nnMacd(series) { nnLines(series); return series._nnMacd; }

/** 最后一根已收盘K线的下标；没有就返回长度-1 */
export function lastClosedIdx(series, now = Date.now()) {
  let ci = Number.isFinite(series.lastClosedIndex) ? series.lastClosedIndex : series.t.length - 1;
  ci = Math.min(ci, series.t.length - 1);
  while (ci >= 0 && series.t[ci] + series.ms > now) ci--;
  return ci;
}

/* ---------------- 大K线 ---------------- */

export const DBL_BIG_LOOKBACK = 10;   // 在两根回踩K线之前多少根内找大K
const bigBody = (s, i) => Math.abs(s.c[i] - s.o[i]);
const avgBody = (s, from, to) => {
  let sum = 0, n = 0;
  for (let i = Math.max(0, from); i < to; i++) { sum += bigBody(s, i); n++; }
  return n ? sum / n : 0;
};
function isBig(s, i, dir, avg) {
  const o = s.o[i], c = s.c[i], h = s.h[i], l = s.l[i];
  const body = Math.abs(c - o), rng = h - l;
  const ratio = rng > 0 ? body / rng : 0;
  const pct = o > 0 ? (body / o) * 100 : 0;
  return (c - o) * dir > 0 && ((ratio >= 0.6 && avg > 0 && body >= 3 * avg) || pct >= 3);
}

/** 回踩前最近 DBL_BIG_LOOKBACK 根内有没有同向大K */
export function hasBigCandle(s, ci, dir) {
  const avg = avgBody(s, Math.max(1, ci - 22), Math.max(1, ci - 2));
  for (let i = Math.max(1, ci - 1 - DBL_BIG_LOOKBACK); i <= ci - 2; i++) {
    if (i < 0 || i >= s.c.length) continue;
    if (isBig(s, i, dir, avg)) return true;
  }
  return false;
}

/* ---------------- 三个标记 ---------------- */

/** 双阴不破（多）/ 双阳不破（空）；都不成立返回 null */
export function checkDoubleMA(s, now = Date.now()) {
  const ci = lastClosedIdx(s, now);
  if (ci < DBL_BIG_LOOKBACK + 12) return null;
  const lines = nnLines(s);
  const vals = i => {
    const v = lines.map(l => l.arr[i]).filter(Number.isFinite);
    return v.length === 4 ? v : null;
  };
  const v2 = vals(ci), v1 = vals(ci - 1), v0 = vals(ci - 2);
  if (!v2 || !v1 || !v0) return null;
  const last = s.c[ci], prev = s.c[ci - 1], pre2 = s.c[ci - 2];
  const oLast = s.o[ci], oPrev = s.o[ci - 1];
  // 双阴不破(多)：大阳启动 → 之前收盘在全部均线上方 → 连收两阴 → 收盘仍在最低均线上方
  if (last < oLast && prev < oPrev
    && pre2 > Math.max(...v0)
    && prev > Math.min(...v1) && last > Math.min(...v2)
    && hasBigCandle(s, ci, 1)) {
    return { dir: 'long', type: '大阳后双阴不破' };
  }
  // 双阳不破(空)：大阴启动 → 之前收盘在全部均线下方 → 连收两阳 → 收盘仍在最高均线下方
  if (last > oLast && prev > oPrev
    && pre2 < Math.min(...v0)
    && prev < Math.max(...v1) && last < Math.max(...v2)
    && hasBigCandle(s, ci, -1)) {
    return { dir: 'short', type: '大阴后双阳不破' };
  }
  return null;
}

/** MACD 快慢线位置：1=都在零轴上，-1=都在零轴下，0=其他 */
export function macZero(s, now = Date.now()) {
  const ci = lastClosedIdx(s, now);
  if (ci < 35) return 0;
  const m = nnMacd(s);
  const d = m.dif[ci], e = m.dea[ci];
  if (!Number.isFinite(d) || !Number.isFinite(e)) return 0;
  if (d > 0 && e > 0) return 1;
  if (d < 0 && e < 0) return -1;
  return 0;
}

export const PB_RECENT = 3;
export const PB_RUN = 2;

/** 顺势回调结构：dir=1 找做多回调，dir=-1 找做空反弹 */
export function pullbackStruct(s, dir, now = Date.now()) {
  const ci = lastClosedIdx(s, now);
  if (ci < 25) return false;
  const avg = avgBody(s, ci - 22, ci - 2);
  for (let i = ci; i > ci - PB_RECENT; i--) {
    if (i >= 0 && isBig(s, i, dir, avg)) return true;
  }
  // 连续 ≥2 根同向K后再跟一根反向K
  const last = s.c[ci] - s.o[ci];
  if (last * dir >= 0) return false;
  let run = 0;
  for (let i = ci - 1; i > ci - 1 - 10; i--) {
    if (i < 0) break;
    if ((s.c[i] - s.o[i]) * dir > 0) run++; else break;
  }
  return run >= PB_RUN;
}

/* ---------------- 分层排序 ---------------- */

/**
 * 0=零上回调最前 / 2=零轴上 / 3=双阴双阳 / 4=其他 / 7=零下反弹垫底
 * （参考页还有「告警」两档，我们这版没有告警框架，略过）
 */
export function nnTier({ pb, mz, dbl }) {
  if (pb === 1) return 0;
  if (pb === -1) return 7;
  if (mz === 1) return 2;
  if (dbl) return 3;
  return 4;
}

/** 一次性算完某根 series 的三个标记 */
export function nnState(s, now = Date.now()) {
  const dbl = checkDoubleMA(s, now);
  const mz = macZero(s, now);
  const pb = mz === 1 && pullbackStruct(s, 1, now) ? 1
    : mz === -1 && pullbackStruct(s, -1, now) ? -1 : 0;
  return { dbl, dblDir: dbl?.dir ?? null, dblType: dbl?.type ?? null, mz, pb, tier: nnTier({ pb, mz, dbl }) };
}
