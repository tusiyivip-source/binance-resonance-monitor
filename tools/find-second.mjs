/**
 * 二买 / 二卖 结构检测 v3
 *
 * 主级别 30m，次级别 15m：
 *   ① 主级别笔：A → B 一笔（≥5根），且 B 突破/跌破 MA7
 *   ② 主级别笔：B → C 反弹/回调一笔（≥5根）
 *   ③ 不破左侧极值：二卖 C<A（不破左侧高点） / 二买 C>A（不破左侧低点）
 *   ④ 次级别「再次」跌破/站上 MA7：C 之后 15m 先反向穿过 MA7，再穿回来
 *   ⑤ 时效：C 之后主级别不超过 maxAfterBars 根（否则是历史形态，不是当下的信号）
 */
const FAPI = 'https://fapi.binance.com/fapi/v1/klines';
const sma = (arr, p) => arr.map((_, i) => i < p - 1 ? NaN : arr.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p);

async function klines(sym, interval, limit = 300) {
  const r = await fetch(`${FAPI}?symbol=${sym}&interval=${interval}&limit=${limit}`);
  if (!r.ok) return null;
  // idx 保留原始下标，done 标记已收盘
  return (await r.json()).map((k, i) => ({ idx: i, t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], done: +k[6] < Date.now() }));
}

function buildStrokes(cs, minBars = 5) {
  const merged = [];
  for (let i = 0; i < cs.length; i++) {
    const k = { h: cs[i].h, l: cs[i].l, from: i, to: i };
    if (merged.length) {
      const last = merged[merged.length - 1];
      const inside = (k.h <= last.h && k.l >= last.l) || (k.h >= last.h && k.l <= last.l);
      if (inside) {
        const up = merged.length < 2 ? true : last.h > merged[merged.length - 2].h;
        last.h = up ? Math.max(last.h, k.h) : Math.min(last.h, k.h);
        last.l = up ? Math.max(last.l, k.l) : Math.min(last.l, k.l);
        last.to = i; continue;
      }
    }
    merged.push(k);
  }
  const fr = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const a = merged[i - 1], b = merged[i], c = merged[i + 1];
    if (b.h > a.h && b.h > c.h) fr.push({ type: 'top', mi: i, price: b.h });
    else if (b.l < a.l && b.l < c.l) fr.push({ type: 'bottom', mi: i, price: b.l });
  }
  const pts = [];
  for (const f of fr) {
    if (!pts.length) { pts.push(f); continue; }
    const last = pts[pts.length - 1];
    if (last.type === f.type) { if (f.type === 'top' ? f.price > last.price : f.price < last.price) pts[pts.length - 1] = f; continue; }
    if (f.mi - last.mi >= minBars - 1) pts.push(f);
  }
  for (const p of pts) {
    const a = merged[p.mi].from, b = merged[p.mi].to;
    let idx = a, best = p.type === 'top' ? cs[a].h : cs[a].l;
    for (let i = a + 1; i <= b; i++) { const v = p.type === 'top' ? cs[i].h : cs[i].l; if (p.type === 'top' ? v > best : v < best) { best = v; idx = i; } }
    p.idx = idx; p.price = best;
  }
  return pts;
}

const MIN = 5;                 // 够笔最少根数
const MAX_AFTER = 16;          // C 之后主级别最多多少根（30m×16 = 8小时）
const snap = await (await fetch('http://127.0.0.1:8848/api/snapshot')).json();
const syms = (snap.symbols || []).slice(0, 100);

const st = { total: syms.length, noData: 0, noSkel: 0, skel: 0, again: 0, fresh: 0 };
const hits = [];

for (const sym of syms) {
  const [r30, r15] = await Promise.all([klines(sym, '30m'), klines(sym, '15m')]);
  if (!r30 || !r15 || r30.length < 80 || r15.length < 80) { st.noData++; continue; }
  const csM = r30.filter(k => k.done), csS = r15.filter(k => k.done);
  const ma7M = sma(csM.map(k => k.c), 7), ma7S = sma(csS.map(k => k.c), 7);
  const pts = buildStrokes(csM, MIN);
  if (pts.length < 3) { st.noSkel++; continue; }

  // 取最后一段满足 ①②③ 的骨架
  let sk = null;
  for (let k = pts.length - 1; k >= 2; k--) {
    const C = pts[k], B = pts[k - 1], A = pts[k - 2];
    if (A.type === B.type || B.type === C.type) continue;
    const b1 = B.idx - A.idx, b2 = C.idx - B.idx;
    if (b1 < MIN || b2 < MIN) continue;
    const maB = ma7M[B.idx];
    if (!Number.isFinite(maB)) continue;
    if (A.type === 'top') {
      if (!(B.price < maB)) continue;
      if (!(C.price < A.price)) continue;
      sk = { dir: 'short', A, B, C, b1, b2, maB };
    } else {
      if (!(B.price > maB)) continue;
      if (!(C.price > A.price)) continue;
      sk = { dir: 'long', A, B, C, b1, b2, maB };
    }
    break;
  }
  if (!sk) { st.noSkel++; continue; }
  st.skel++;

  const after = csM.length - 1 - sk.C.idx;
  if (after > MAX_AFTER) continue;              // ⑤ 时效

  // ④ 次级别「再次」：C 之后 15m 先到过另一侧，再回到就绪侧
  //    二卖的就绪侧 = 收盘 < MA7（跌破了）；二买 = 收盘 > MA7（站上了）
  const cT = csM[sk.C.idx].t;
  const seg = csS.map((k, i) => ({ k, ma: ma7S[i] })).filter(x => Number.isFinite(x.ma) && x.k.t > cT);
  if (seg.length < 2) continue;
  const ready = x => sk.dir === 'short' ? x.k.c < x.ma : x.k.c > x.ma;
  const lastReady = ready(seg[seg.length - 1]);
  const hadOther = seg.some(x => !ready(x));      // 期间到过反侧 → 「再次」成立
  const againOk = lastReady && hadOther;
  if (againOk) st.again++;
  const fresh = after <= MAX_AFTER;
  if (fresh && againOk) st.fresh++;

  hits.push({
    sym, dir: sk.dir, b1: sk.b1, b2: sk.b2,
    aP: sk.A.price, bP: sk.B.price, cP: sk.C.price, maB: sk.maB,
    aIdx: sk.A.idx, bIdx: sk.B.idx, cIdx: sk.C.idx,
    cT, after, againOk,
    seg15: seg.length,
    sLast: seg[seg.length - 1].k.c, sMa: seg[seg.length - 1].ma,
  });
}

console.log('=== 阶段计数 ===');
console.log('  标的                ', st.total);
console.log('  数据不足            ', st.noData);
console.log('  有骨架(①②③)        ', st.skel);
console.log('  + 次级别「再次」翻转 ', st.again);
console.log('  + 时效(≤' + MAX_AFTER + '根) 且 再次翻转', st.fresh);
console.log('');

const good = hits.filter(h => h.againOk).sort((a, b) => a.after - b.after || a.b2 - b.b2);
console.log(`=== 完整命中：${good.length} 个（已按新鲜度排序）===`);
for (const h of good) {
  const kind = h.dir === 'short' ? '二卖🟢' : '二买🔴';
  console.log(`  ${kind} ${h.sym.padEnd(13)} ①${String(h.b1).padStart(2)}根 ②${String(h.b2).padStart(2)}根`
    + `  A=${String(h.aP).padEnd(10)} B=${String(h.bP).padEnd(10)} C=${String(h.cP).padEnd(10)}`
    + `  C后${String(h.after).padStart(2)}根(30m)  15m段${h.seg15}根  收${h.sLast} MA7=${h.sMa.toPrecision(6)}`);
}
