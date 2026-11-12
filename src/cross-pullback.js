/**
 * 「金叉回踩 / 死叉反弹」策略。
 *
 * 监控级别：15分 / 30分 / 1小时 / 2小时 / 3小时 / 6小时 / 12小时（多级别，各自独立）
 *
 * 做多（金叉）：
 *   ① 最近一次 MACD **金叉**（DIF 上穿 DEA）之后
 *   ② 走出过阳线（上涨段）
 *   ③ 随后开始回踩，当前是**第 N 根阴线**（N = 1 或 2，由筛选栏决定）
 *   → 提醒
 *
 * 做空（死叉）：镜像 ——
 *   ① 最近一次死叉之后
 *   ② 走出过阴线（下跌段）
 *   ③ 随后反弹，当前是**第 N 根阳线**
 *   → 提醒
 *
 * 零轴筛选（axis）：
 *   above = 只留「零轴上」的金叉/死叉（DIF、DEA 都在零轴上方）
 *   below = 只留「零轴下」的
 *   all   = 不限
 */

export const CROSS_PB_LEVELS = ['15m', '30m', '1h', '2h', '3h', '6h', '12h'];

/**
 * 金叉之后、回踩之前，必须出现过一根「放量拉升」的阳线：
 *   ① 阳线（收 > 开）
 *   ② 涨幅 **大于前三根K线各自的涨幅**（也就是最近 4 根里最猛的那一根）
 *   ③ 量能放大：成交量 ≥ 近 5 根均量 × volMult（默认 1.5 倍）
 *
 * 这道条件是「有人真金白银拉起来」的证据 —— 没有放量拉升的金叉，
 * 回踩之后大多直接走弱，不值得进场。
 *
 * @returns {{idx:number, gainPct:number, volRatio:number}|null}
 */
function hasSurge(series, from, to, opt) {
  const v = series.v;
  if (!v) return null;
  const bars = Math.max(1, Math.min(6, Number(opt.surgeCompareBars ?? 3)));
  const mult = Math.max(1, Number(opt.volMult ?? 1.5));
  for (let i = Math.max(1, from); i <= to; i++) {
    const o = series.o[i], c = series.c[i];
    if (!Number.isFinite(o) || !Number.isFinite(c) || !(c > o)) continue;
    const g = (c - o) / o;
    // ② 比前三根都猛
    let biggest = true;
    for (let k = 1; k <= bars; k++) {
      const j = i - k;
      if (j < 0) { biggest = false; break; }
      const po = series.o[j], pc = series.c[j];
      if (!Number.isFinite(po) || !Number.isFinite(pc) || !(po > 0)) { biggest = false; break; }
      if (!(g > (pc - po) / po)) { biggest = false; break; }
    }
    if (!biggest) continue;
    // ③ 放量
    let sum = 0, cnt = 0;
    for (let k = 1; k <= 5; k++) {
      const j = i - k;
      if (j >= 0 && Number.isFinite(v[j])) { sum += v[j]; cnt++; }
    }
    const avg = cnt ? sum / cnt : 0;
    if (!(avg > 0) || !(v[i] >= avg * mult)) continue;
    return { idx: i, gainPct: Math.round(g * 10000) / 100, volRatio: Math.round((v[i] / avg) * 100) / 100 };
  }
  return null;
}

/**
 * 找**最近一次**交叉（不分方向）。
 *
 * ⚠ 必须只看最近这一次：如果最新是死叉、更早才是金叉，
 *   那当前的形态是「死叉之后」，不能拿旧金叉来判做多。
 *
 * @returns {{idx:number, dir:number}} dir=1 金叉，dir=-1 死叉；找不到返回 null
 */
function lastCrossAny(dif, dea, idx) {
  const from = Math.max(1, idx - 240);
  for (let i = idx; i >= from; i--) {
    const d0 = dif[i - 1], e0 = dea[i - 1], d1 = dif[i], e1 = dea[i];
    if (![d0, e0, d1, e1].every(Number.isFinite)) continue;
    if (d0 <= e0 && d1 > e1) return { idx: i, dir: 1 };    // 金叉
    if (d0 >= e0 && d1 < e1) return { idx: i, dir: -1 };   // 死叉
  }
  return null;
}

/**
 * @param {object} series 该级别K线（需要 o/c）
 * @param {object} ind series.ensure() 的结果（需要 macd.dif / macd.dea）
 * @param {number} idx 最后一根已收盘K线的下标
 * @param {object} opt { depth: 1|2, axis: 'all'|'above'|'below' }
 */
export function crossPullbackAt(series, ind, idx, opt = {}) {
  if (!series || !Number.isFinite(idx) || idx < 20) return null;
  const m = ind?.macd;
  if (!m || !m.dif || !m.dea) return null;

  const depth = Math.max(1, Math.min(2, Number(opt.depth) || 1));
  const axis = opt.axis === 'above' || opt.axis === 'below' ? opt.axis : 'all';
  const dif = m.dif, dea = m.dea;

  // idx-depth 那根必须是「反向K」：说明回踩是从它之后开始的
  const pivot = idx - depth;
  if (pivot < 1) return null;

  // 只看最近一次交叉，方向由它决定
  const cross = lastCrossAny(dif, dea, idx);
  if (!cross) return null;
  {
    const dir = cross.dir;
    const long = dir > 0;
    const crossIdx = cross.idx;
    // 回踩必须发生在交叉之后
    if (!(pivot > crossIdx)) return null;

    // 零轴位置：按**快线 DIF**（交叉那一刻）判，这是盘面上看的那条线。
    // ⚠ 不能要求 DIF 和 DEA 同时在零轴同侧：它们经常跨在零轴两边
    //   （比如 DIF 刚下穿零轴、DEA 还在上面），那样会被打成 mixed，
    //   两个筛选栏都匹配不到，信号就凭空消失了。
    const cd = dif[crossIdx], ce = dea[crossIdx];
    const side = cd > 0 ? 'above' : 'below';
    if (axis !== 'all' && side !== axis) return null;

    // 回踩段：idx-depth+1 .. idx 全是回踩方向的K线
    let ok = true;
    for (let i = idx - depth + 1; i <= idx; i++) {
      const c = series.c[i], o = series.o[i];
      if (!Number.isFinite(c) || !Number.isFinite(o)) { ok = false; break; }
      if (long ? !(c < o) : !(c > o)) { ok = false; break; }   // 做多要阴线，做空要阳线
    }
    if (!ok) return null;

    // ②b 金叉之后、回踩之前，必须出现过「放量拉升」的阳线
    const surge = hasSurge(series, crossIdx + 1, pivot, opt);
    if (opt.requireSurge !== false && !surge) return null;

    // pivot 那根是反向K（做多=阳线，做空=阴线），保证是「先涨后回踩」
    const pO = series.o[pivot], pC = series.c[pivot];
    if (!Number.isFinite(pO) || !Number.isFinite(pC)) return null;
    if (long ? !(pC > pO) : !(pC < pO)) return null;

    const firstPull = series.c[idx - depth + 1];
    return {
      dir: long ? 'long' : 'short',
      crossIdx,
      crossT: series.t[crossIdx] + series.ms,
      crossDif: Math.round(cd * 1e8) / 1e8,
      crossDea: Math.round(ce * 1e8) / 1e8,
      axisSide: side,
      depth,
      barsSinceCross: idx - crossIdx,
      pivot: { o: pO, c: pC, t: series.t[pivot] + series.ms },
      pullFirst: Math.round(firstPull * 1e8) / 1e8,
      surge,
      open: series.o[idx], close: series.c[idx],
      ma5: null,
      at: series.t[idx] + series.ms,
      variant: long ? 'long' : 'short',
      variantLabel: long
        ? `金叉后回踩 ${depth} 根`
        : `死叉后反弹 ${depth} 根`,
    };
  }
  return null;
}

/** 参数归一化 */
export function crossPbOptions(input = {}, cfg = {}) {
  const num = (v, d, min, max) => (v == null || v === '' || !Number.isFinite(Number(v))
    ? d : Math.max(min, Math.min(max, Number(v))));
  const depth = num(input.depth ?? cfg.crossPbDepth, 1, 1, 2);
  const lv = String(input.level ?? 'all');
  return {
    depth: Math.round(depth),
    axis: input.axis === 'above' || input.axis === 'below' ? input.axis : 'all',
    // 放量拉升确认（默认开）；volMult 是「相对近 5 根均量」的倍数门槛
    requireSurge: input.surge !== '0' && input.surge !== 'off',
    volMult: num(input.vol, cfg.crossPbVolMult ?? 1.5, 1, 10),
    surgeCompareBars: 3,
    // 级别筛选：'all' 或具体级别 key（15m/30m/1h/2h/3h/6h/12h）
    level: CROSS_PB_LEVELS.includes(lv) ? lv : 'all',
    topN: Math.round(num(input.topN, cfg.crossPbTopN ?? 500, 1, 800)),
  };
}

/** 排序：先出现的在前（旧 → 新） */
export function compareCrossPb(x, y) {
  // 「刚开始金叉/死叉」的放最前面：交叉距今的根数越少越靠前。
  const bx = Number.isFinite(x.barsSinceCross) ? x.barsSinceCross : 1e9;
  const by = Number.isFinite(y.barsSinceCross) ? y.barsSinceCross : 1e9;
  if (bx !== by) return bx - by;
  // 同一时刻交叉的：触发更晚（更新的收盘K）在前
  const a = Number.isFinite(y.at) ? y.at : 0;
  const b = Number.isFinite(x.at) ? x.at : 0;
  return a - b;
}
