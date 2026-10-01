/**
 * 缠论工具：包含处理 → 分型 → 笔 → MACD 面积背驰判定
 *
 * 只用「标准笔」口径：
 *   1. 先做**包含处理**，把相互包含的相邻K线按趋势方向合并
 *   2. 在合并后的K线上找**分型**（顶分型 = 中间那根高点最高；底分型 = 中间那根低点最低）
 *   3. **笔** = 顶分型与底分型交替相连，且两个分型之间至少隔 3 根独立K线（含分型共 5 根）
 *   4. **背驰** = 同向两笔相比，后一笔**价格创新极值但 MACD 红/绿柱面积反而更小**（力度衰减）
 *
 * 关于「将要出现的背驰笔」：
 *   当前这一笔还没走完（正在形成中），但价格已经越过前一同向笔的极值、
 *   而累计 MACD 面积已经小于前一同向笔的总面积 —— 说明上涨/下跌动能衰竭，
 *   这一笔大概率会以背驰收尾。这正是本模块要提前识别并**排除**的形态。
 *
 * 因果性：所有判定只使用截至 idx 的K线。分型在下一根合并K线出现时才算确认，
 * 因此用 confirmIdx（下一根合并K线的起始原始下标）作为「该点已知」的时刻，
 * 回测滑窗时不会偷看未来。
 */
import { buildMACD } from './indicators.js';

/* ---------------- 1. 包含处理 ---------------- */
/**
 * 把相互包含的相邻K线按趋势方向合并。
 * @returns {{h:number[],l:number[],from:number[],to:number[],n:number}}
 *   from/to = 该合并K线覆盖的原始下标区间
 */
export function mergeInclusive(h, l) {
  const H = [], L = [], F = [], T = [];
  for (let i = 0; i < h.length; i++) {
    let ch = h[i], cl = l[i], cf = i, ct = i;
    for (;;) {
      if (!H.length) break;
      const ph = H[H.length - 1], pl = L[L.length - 1];
      const contained = (ch <= ph && cl >= pl) || (ch >= ph && cl <= pl);
      if (!contained) break;
      // 方向由「被包含那根之前」的走势决定：向上取高高，向下取低低
      const up = H.length >= 2 ? H[H.length - 2] < ph : ch > ph;
      ch = up ? Math.max(ch, ph) : Math.min(ch, ph);
      cl = up ? Math.max(cl, pl) : Math.min(cl, pl);
      cf = F[F.length - 1];
      ct = i;
      H.pop(); L.pop(); F.pop(); T.pop();
    }
    H.push(ch); L.push(cl); F.push(cf); T.push(ct);
  }
  return { h: H, l: L, from: F, to: T, n: H.length };
}

/* ---------------- 2. 分型 ---------------- */
/**
 * 在合并后的K线上找分型。
 * 顶分型：中间那根的高点同时高于左右两根
 * 底分型：中间那根的低点同时低于左右两根
 * （做完包含处理后，一根K线不可能同时是顶和底）
 */
export function findFractals(m) {
  const out = [];
  for (let i = 1; i < m.n - 1; i++) {
    const isTop = m.h[i] > m.h[i - 1] && m.h[i] > m.h[i + 1];
    const isBot = m.l[i] < m.l[i - 1] && m.l[i] < m.l[i + 1];
    if (isTop && !isBot) out.push({ mi: i, type: 'top', price: m.h[i] });
    else if (isBot && !isTop) out.push({ mi: i, type: 'bottom', price: m.l[i] });
  }
  return out;
}

/* ---------------- 3. 笔 ---------------- */
/**
 * 把分型连成笔的端点序列（严格交替 + 最小K线数约束）。
 * @param {number} minBars 顶底分型之间至少几根合并K线（标准笔 = 5）
 */
export function buildStrokePoints(fractals, m, h, l, minBars = 5) {
  const pts = [];
  for (const f of fractals) {
    if (!pts.length) { pts.push(f); continue; }
    const last = pts[pts.length - 1];
    if (last.type === f.type) {
      // 同类型：保留更极端的那根
      const better = f.type === 'top' ? f.price > last.price : f.price < last.price;
      if (better) pts[pts.length - 1] = f;
      continue;
    }
    // 异类型：间隔不足则不足以成笔，跳过
    if (f.mi - last.mi >= minBars - 1) pts.push(f);
  }
  // 回填原始下标：顶分型取区间内最高那根，底分型取最低那根
  for (const p of pts) {
    const a = m.from[p.mi], b = m.to[p.mi];
    let idx = a, best = p.type === 'top' ? h[a] : l[a];
    for (let i = a + 1; i <= b; i++) {
      const v = p.type === 'top' ? h[i] : l[i];
      if (p.type === 'top' ? v > best : v < best) { best = v; idx = i; }
    }
    p.origIdx = idx;
    p.price = best;
    // 该分型需要「下一根合并K线」出现才算确认，用下一根的起始原始下标
    p.confirmIdx = p.mi + 1 < m.n ? m.from[p.mi + 1] : Infinity;
  }
  return pts;
}

/* ---------------- 4. 整体分析（与参数无关，可缓存） ---------------- */
export function analyzeChan(series, minBars = 5) {
  const n = series.t.length;
  if (n < 40) return null;
  const h = series.h, l = series.l;
  const macd = buildMACD(series.c);
  const m = mergeInclusive(h, l);
  const fractals = findFractals(m);
  const pts = buildStrokePoints(fractals, m, h, l, minBars);

  // MACD 面积前缀和：面积(a,b) 可 O(1) 求出
  const posSum = new Float64Array(n + 1);
  const negSum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = macd.hist[i];
    posSum[i + 1] = posSum[i] + (Number.isFinite(v) && v > 0 ? v : 0);
    negSum[i + 1] = negSum[i] + (Number.isFinite(v) && v < 0 ? -v : 0);
  }
  // confirmCount[i] = 截至原始下标 i，已确认的分型点数量
  const confirmCount = new Int32Array(n + 1);
  {
    let p = 0;
    for (let i = 0; i < n; i++) {
      while (p < pts.length && pts[p].confirmIdx <= i) p++;
      confirmCount[i] = p;
    }
    confirmCount[n] = pts.length;
  }
  return { n, macd, merged: m, fractals, pts, posSum, negSum, confirmCount, minBars };
}

/** 求 [from, to] 区间内该方向的有效 MACD 面积 */
export function macdArea(chan, from, to, dir) {
  const s = dir === 'up' ? chan.posSum : chan.negSum;
  const a = Math.max(0, Math.min(from, chan.n));
  const b = Math.max(a, Math.min(to + 1, chan.n));
  return s[b] - s[a];
}

/* ---------------- 5. 判定「截至 idx 的笔与背驰状态」 ---------------- */
/**
 * @param {object} chan analyzeChan 的结果
 * @param {object} series K线序列（提供 h/l）
 * @param {number} idx 只看截至这个下标
 * @param {{ratio?:number, minProgress?:number}} opt
 *        ratio       面积衰减阈值（当前面积 < 前一同向笔面积 × ratio 才算衰减），默认 1.0
 *        minProgress 当前笔的涨跌幅至少要走到前一同向笔的多少倍才判定，默认 0.3
 */
export function chanStateAt(chan, series, idx, opt = {}) {
  if (!chan) return null;
  const ratio = opt.ratio ?? 1.0;
  const minProgress = opt.minProgress ?? 0.3;
  const i = Math.max(0, Math.min(idx, chan.n - 1));
  const cnt = chan.confirmCount[i];
  if (cnt < 3) return { ok: false, reason: `已确认笔端点不足（${cnt}）`, strokeCount: Math.max(0, cnt - 1) };

  const last = chan.pts[cnt - 1];
  const dir = last.type === 'bottom' ? 'up' : 'down';

  // 当前正在形成的那一笔：从 last 到 idx 之间的极值
  let exPrice = dir === 'up' ? -Infinity : Infinity;
  let exIdx = last.origIdx;
  for (let k = last.origIdx; k <= i; k++) {
    const v = dir === 'up' ? series.h[k] : series.l[k];
    if (dir === 'up' ? v > exPrice : v < exPrice) { exPrice = v; exIdx = k; }
  }
  const cur = {
    dir, fromIdx: last.origIdx, fromPrice: last.price,
    toIdx: exIdx, toPrice: exPrice,
    advance: Math.abs(exPrice - last.price),
    area: macdArea(chan, last.origIdx, i, dir),
    complete: false,
  };

  // 前一个「同向且已完成」的笔
  let prev = null;
  for (let k = cnt - 1; k >= 1; k--) {
    const a = chan.pts[k - 1], b = chan.pts[k];
    const d = b.type === 'top' ? 'up' : 'down';
    if (d !== dir) continue;
    prev = {
      dir: d, fromIdx: a.origIdx, fromPrice: a.price,
      toIdx: b.origIdx, toPrice: b.price,
      advance: Math.abs(b.price - a.price),
      area: macdArea(chan, a.origIdx, b.origIdx, d),
      complete: true,
    };
    break;
  }

  const out = {
    ok: true, dir, cur, prev,
    strokeCount: cnt - 1,
    newExtreme: false, weaker: false, progressed: true, areaRatio: null, advanceRatio: null,
    divergence: { status: 'none', dir: dir === 'up' ? 'top' : 'bottom' },
  };
  if (!prev) return out;

  out.newExtreme = dir === 'up' ? cur.toPrice > prev.toPrice : cur.toPrice < prev.toPrice;
  out.areaRatio = prev.area > 0 ? cur.area / prev.area : null;
  out.advanceRatio = prev.advance > 0 ? cur.advance / prev.advance : null;
  out.weaker = out.areaRatio != null && out.areaRatio < ratio;
  out.progressed = out.advanceRatio == null || out.advanceRatio >= minProgress;

  if (out.newExtreme && out.weaker && out.progressed) {
    out.divergence = {
      status: 'pending',                       // 「将要出现」——这一笔还没走完
      dir: dir === 'up' ? 'top' : 'bottom',
      reason: `${dir === 'up' ? '顶' : '底'}背驰酝酿中：价格已创${dir === 'up' ? '新' : '新'}${dir === 'up' ? '高' : '低'}，`
        + `但 MACD 柱面积只有前一同向笔的 ${(out.areaRatio * 100).toFixed(0)}%`,
    };
  }
  return out;
}

/**
 * 截至 idx 的「笔」状态——用于判断某个级别的回调**够不够成笔**。
 *
 * 为什么需要：回调的「分量」体现在它能让多少个级别成笔。
 * 只让最小级别成笔的回调是很浅的，撑不起更大级别的延续。
 *
 * @returns {{ok:boolean, points:number, down:object|null, top:object|null}}
 *   down = 最近一个**已完成的向下笔**（顶分型 → 底分型），带两端时间与价格
 *   top  = 最近一个已确认的顶分型（用来确定「回调是从哪里开始的」）
 */
export function strokeInfoAt(chan, series, idx) {
  if (!chan) return null;
  const i = Math.max(0, Math.min(idx, chan.n - 1));
  const cnt = chan.confirmCount[i];
  const out = { ok: cnt >= 2, points: cnt, down: null, top: null };
  if (cnt < 2) return out;

  // 最近一个已确认的顶分型
  for (let k = cnt - 1; k >= 0; k--) {
    const p = chan.pts[k];
    if (p.type === 'top') {
      out.top = { idx: p.origIdx, price: p.price, t: series.t[p.origIdx] };
      break;
    }
  }
  // 最近一个已完成的向下笔（相邻两点为 顶→底）
  for (let k = cnt - 1; k >= 1; k--) {
    const a = chan.pts[k - 1], b = chan.pts[k];
    if (a.type === 'top' && b.type === 'bottom') {
      out.down = {
        topIdx: a.origIdx, topPrice: a.price, topT: series.t[a.origIdx],
        botIdx: b.origIdx, botPrice: b.price, botT: series.t[b.origIdx],
        bars: b.origIdx - a.origIdx,
      };
      break;
    }
  }
  return out;
}

