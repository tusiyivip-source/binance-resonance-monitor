/**
 * 参数网格搜索：检验「多级别共振」这套逻辑的**任何一种参数化**是否存在超额收益。
 *
 *   node tools/sweep.mjs [--symbols=40] [--hours=72] [--grid=main|full] [--top=20]
 *
 * 设计要点：
 *  1. 直接调用 src/signals.js 的真实函数（analyzeLevelAtIndex / findResonance），
 *     不另写一套匹配逻辑，杜绝"扫描规则 ≠ 实盘规则"的漂移；
 *  2. 每个标的只拉一次历史，所有参数组合共用；
 *  3. 同时报告 样本内(前半段) / 样本外(后半段)，以及相对「无脑持有涨幅榜」的超额收益；
 *  4. 明确处理多重比较问题：给出中位数与正值占比，而不是只挑最好看的那组。
 */
import fs from 'node:fs';
import { CandleSeries } from '../src/series.js';
import { analyzeLevelAtIndex, findResonance } from '../src/signals.js';
import { LEVELS, DEFAULT_SIGNAL, APP } from '../src/config.js';
import { TokenBucket, RestClient } from '../src/rest.js';

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const TOPN = Number(argv.symbols || 40);
const HOURS = Number(argv.hours || 72);          // 每个窗口的长度
const WINDOWS = Math.max(1, Number(argv.windows || 1)); // 切成几个连续不重叠的窗口
const GRID = argv.grid === 'full' ? 'full' : 'main';
const TOP = Number(argv.top || 18);
const SPAN = HOURS * WINDOWS;

APP.maxCandlesKept = Math.max(APP.maxCandlesKept, Math.ceil((SPAN * 60) / 3) + 300);

const bucket = new TokenBucket(APP.weightPerMinute, APP.weightBurst);
const rest = new RestClient(bucket);
const weightFor = lim => (lim >= 500 ? 5 : lim >= 100 ? 2 : 1);
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const winR = a => (a.length ? (a.filter(x => x > 0).length / a.length) * 100 : NaN);
const fin = a => a.filter(Number.isFinite);
const f2 = (x, s = '') => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) + s : '—');

/* ---------- 1. 参数网格 ---------- */
function buildGrid() {
  const dims = {
    minBullLevels: [3, 4, 5],
    pullbackLookback: [3, 6, 10],
    triggerLookback: [1, 2, 3],
    adjacentLookback: [2, 4],
    bigMa: ['ema7', 'ma7'],
  };
  if (GRID === 'full') dims.countRule = ['align', 'above'];
  const keys = Object.keys(dims);
  const out = [];
  const rec = (i, cur) => {
    if (i === keys.length) { out.push({ ...cur }); return; }
    for (const v of dims[keys[i]]) rec(i + 1, { ...cur, [keys[i]]: v });
  };
  rec(0, {});
  return out;
}
const grid = buildGrid();

console.log(`\n\u001b[36m▌参数网格搜索\u001b[0m  标的=${TOPN}  每窗 ${HOURS}h × ${WINDOWS} 窗 = ${SPAN}h  组合数=${grid.length}  (grid=${GRID})\n`);

/* ---------- 2. 榜单 ---------- */
const [tickers, info] = await Promise.all([
  rest.get(APP.tickerPath, { weight: APP.profile.tickerWeight }),
  rest.get(APP.exchangeInfoPath, { weight: APP.market === 'futures' ? 1 : 20, timeout: 30_000 }),
]);
const trading = new Set(info.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT').map(s => s.symbol));
const BAD = /(UP|DOWN|BULL|BEAR)USDT$/;
const universe = tickers
  .filter(t => t.symbol.endsWith('USDT') && !BAD.test(t.symbol) && trading.has(t.symbol) && Number(t.count) >= 50)
  .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
  .slice(0, TOPN);
console.log(`榜单 ${universe.length} 个标的，拉取历史…`);

/* ---------- 3. 分页拉取 ---------- */
async function klinesPaged(sym, interval, total) {
  let out = [];
  let endTime;
  let guard = 0;
  while (out.length < total && guard++ < 12) {
    const lim = Math.min(1000, total - out.length);
    const q = `${APP.klinesPath}?symbol=${sym}&interval=${interval}&limit=${lim}` + (endTime ? `&endTime=${endTime}` : '');
    const rows = await rest.get(q, { weight: weightFor(lim), retries: 2 });
    if (!rows.length) break;
    out = rows.concat(out);
    endTime = rows[0][0] - 1;
    if (rows.length < lim) break;
  }
  return out;
}

const data = [];
let fetched = 0, skip = 0;
for (const t of universe) {
  const sym = t.symbol;
  try {
    const series = {};
    await Promise.all(LEVELS.filter(l => l.native).map(async lv => {
      const need = lv.key === '3m' ? Math.ceil((SPAN * 60) / 3) + 160
        : lv.key === '5m' ? Math.ceil((SPAN * 60) / 5) + 160
          : 220;
      const rows = await klinesPaged(sym, lv.key, need);
      const s = new CandleSeries(lv);
      s.bulkLoad(rows.map(k => ({
        t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4],
        v: +k[5], q: +k[7], n: +k[8], done: k[6] < Date.now(),
      })));
      series[lv.key] = s;
    }));
    for (const lv of LEVELS) {
      if (lv.native) continue;
      series[lv.key] = new CandleSeries(lv);
      series[lv.key].rebuildFrom(series[lv.from]);
    }
    const inds = {};
    for (const lv of LEVELS) inds[lv.key] = series[lv.key].ensure();

    const base3m = series['3m'];
    const ms3 = 3 * 60_000;
    const closed3 = base3m.closedCount;
    const hi = closed3 - 1;
    const lo = Math.max(160, closed3 - Math.ceil((SPAN * 60) / 3));
    if (hi - lo < 200 * WINDOWS) { skip++; continue; }

    // 每个级别在窗口内每一时刻"最后一根已收盘"的下标（与参数无关）
    const ptrs = {};
    for (const lv of LEVELS) {
      const s = series[lv.key];
      const arr = new Int32Array(hi - lo + 1);
      let p = 30;
      for (let j = 0, bi = lo; bi <= hi; bi++, j++) {
        const T = base3m.t[bi] + ms3;
        while (p + 1 < s.t.length && s.t[p + 1] + s.ms <= T) p++;
        arr[j] = p;
      }
      ptrs[lv.key] = arr;
    }

    // 前向收益（与参数无关）
    const L = hi - lo + 1;
    const ref = series['30m'];
    const take = h => {
      const arr = new Float64Array(L).fill(NaN);
      for (let j = 0, bi = lo; bi <= hi; bi++, j++) {
        const T = base3m.t[bi] + ms3;
        const want = T + h * 3600_000;
        const p0 = base3m.c[bi];
        let v = null;
        for (let k = bi + Math.round((h * 60) / 3) - 1; k < closed3; k++) {
          if (base3m.t[k] + ms3 >= want) { v = base3m.c[k]; break; }
        }
        if (v == null) {
          for (let k = 0; k < ref.t.length; k++) {
            if (ref.t[k] + ref.ms < want || ref.t[k] < T) continue;
            v = ref.c[k]; break;
          }
        }
        arr[j] = v == null ? NaN : ((v - p0) / p0) * 100;
      }
      return arr;
    };
    const fwd = { r1: take(1), r4: take(4), r8: take(8), r24: take(24) };
    const seg = Math.floor(L / WINDOWS);

    data.push({ sym, series, inds, ptrs, fwd, lo, hi, L, seg });
    fetched++;
    if (fetched % 10 === 0) process.stdout.write(`  已载入 ${fetched}/${universe.length}\r`);
  } catch {
    skip++;
  }
}
console.log(`\n数据就绪：${fetched} 个标的（跳过 ${skip}），${WINDOWS} 个窗口 × ${HOURS}h，遍历 ${grid.length} 组参数…\n`);

/* ---------- 4. 基准：每个窗口各自算「无脑持有涨幅榜」 ---------- */
const BENCH_W = [];
for (let w = 0; w < WINDOWS; w++) {
  const o = {};
  for (const key of ['r1', 'r4', 'r8', 'r24']) {
    const v = [];
    for (const d of data) {
      const a = w * d.seg, b = w === WINDOWS - 1 ? d.L : (w + 1) * d.seg;
      for (let j = a; j < b; j += 5) if (Number.isFinite(d.fwd[key][j])) v.push(d.fwd[key][j]);
    }
    o[key] = { n: v.length, avg: avg(v), win: winR(v) };
  }
  BENCH_W.push(o);
}
const BENCH = {};
for (const key of ['r1', 'r4', 'r8', 'r24']) {
  const all = BENCH_W.map(b => b[key]).filter(b => b.n);
  BENCH[key] = { n: all.reduce((a, b) => a + b.n, 0), avg: all.reduce((a, b) => a + b.avg * b.n, 0) / all.reduce((a, b) => a + b.n, 0) };
}

/* ---------- 5. 逐组回放（调用真实引擎函数） ---------- */
const results = [];
const t0 = Date.now();
for (const g of grid) {
  const cfg = { ...DEFAULT_SIGNAL, ...g, scanMode: 'auto', baseMinIdx: 2, baseMaxIdx: 6 };
  const sums = { r1: [], r4: [], r8: [], r24: [] };
  const wsum = Array.from({ length: WINDOWS }, () => []);

  for (const d of data) {
    const seen = new Set();
    for (let j = 0; j < d.L; j++) {
      const views = { __symbol: d.sym };
      let ok = true;
      for (const lv of LEVELS) {
        const s = d.series[lv.key];
        if (s.t.length < 40) { ok = false; break; }
        views[lv.key] = analyzeLevelAtIndex(s, d.inds[lv.key], d.ptrs[lv.key][j], cfg);
      }
      if (!ok) continue;
      const res = findResonance(views, cfg, 'closed');
      for (const m of res.matches) {
        const k = `${m.base}|${m.candleT}`;
        if (seen.has(k)) continue;
        seen.add(k);
        for (const key of ['r1', 'r4', 'r8', 'r24']) {
          const x = d.fwd[key][j];
          if (Number.isFinite(x)) sums[key].push(x);
        }
        const y = d.fwd.r4[j];
        if (Number.isFinite(y)) wsum[Math.min(WINDOWS - 1, Math.floor(j / d.seg))].push(y);
      }
    }
  }
  results.push({
    g, n: sums.r4.length,
    a1: avg(sums.r1), w1: winR(sums.r1),
    a4: avg(sums.r4), w4: winR(sums.r4),
    a8: avg(sums.r8), w8: winR(sums.r8),
    a24: avg(sums.r24), w24: winR(sums.r24),
    perWindow: wsum.map((v, i) => ({
      n: v.length,
      ex: v.length ? avg(v) - BENCH_W[i].r4.avg : NaN,
    })),
  });
  process.stdout.write(`  已评估 ${results.length}/${grid.length} 组   (${((Date.now() - t0) / 1000).toFixed(0)}s)\r`);
}
console.log(`\n\n`);

/* ---------- 6. 报告 ---------- */
const ex = (x, b) => (Number.isFinite(x) && Number.isFinite(b) ? x - b : NaN);
const sorted = [...results].sort((a, b) => ex(b.a4, BENCH.r4.avg) - ex(a.a4, BENCH.r4.avg));
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : NaN);
const median = arr => pct(arr, 0.5);
const posShare = arr => (arr.length ? (arr.filter(x => x > 0).length / arr.length) * 100 : NaN);
const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);

console.log(`\n\u001b[36m════════════ 基准（每个窗口各自的「无脑持有涨幅榜」）════════════\u001b[0m`);
console.log('  窗口      +4h基准    基准胜率   +8h基准    基准胜率   +24h基准    基准胜率');
for (let w = 0; w < WINDOWS; w++) {
  const b = BENCH_W[w];
  console.log(`  #${String(w + 1).padStart(2)}   ${f2(b.r4.avg, '%').padStart(8)}  ${b.r4.win.toFixed(0).padStart(6)}%   ` +
    `${f2(b.r8.avg, '%').padStart(8)}  ${b.r8.win.toFixed(0).padStart(6)}%   ` +
    `${f2(b.r24.avg, '%').padStart(8)}  ${b.r24.win.toFixed(0).padStart(6)}%`);
}
console.log(`  \u001b[2m各窗口基准差异大 → 市场状态在变，必须逐窗对比，混在一起算平均值会掩盖问题\u001b[0m`);

/* --------- 7. 多窗口一致性：这是判定的核心 ---------- */
console.log(`\n\u001b[36m════════════ 多窗口一致性检验（+4h 超额，全 ${results.length} 组参数）════════════\u001b[0m`);
console.log('  窗口  超额中位数  为正的组数占比   最好      最差');
const winConsistency = [];
for (let w = 0; w < WINDOWS; w++) {
  const arr = results.map(x => x.perWindow[w]?.ex).filter(Number.isFinite).sort((a, b) => a - b);
  const med = median(arr), pos = posShare(arr);
  winConsistency.push({ med, pos });
  console.log(`  #${String(w + 1).padStart(2)}   ${f2(med, '%').padStart(9)}   ${pos.toFixed(0).padStart(10)}%   ` +
    `${f2(arr[arr.length - 1], '%').padStart(8)}  ${f2(arr[0], '%').padStart(8)}`);
}
const allPos = winConsistency.filter(x => x.med > 0).length;

console.log(`\n\u001b[36m════════════ 综合（+1h / +4h / +8h / +24h）════════════\u001b[0m`);
for (const [lbl, key] of [['+1h', 'r1'], ['+4h', 'r4'], ['+8h', 'r8'], ['+24h', 'r24']]) {
  const arr = results.map(x => ex(x['a' + key.slice(1)], BENCH[key].avg)).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`  ${lbl.padEnd(5)} 超额中位数 ${f2(median(arr), '%').padStart(8)}   最好 ${f2(arr[arr.length - 1], '%').padStart(8)}   ` +
    `最差 ${f2(arr[0], '%').padStart(8)}   为正比例 ${posShare(arr).toFixed(0).padStart(3)}%`);
}

console.log(`\n\u001b[36m════════════ 表现最好的 ${Math.min(8, TOP)} 组参数（逐窗 +4h 超额）════════════\u001b[0m`);
console.log('  共振 回踩 上穿 相邻 最大线   信号数   总超额   胜率  ' + Array.from({ length: WINDOWS }, (_, i) => ` 窗口${i + 1}`).join(''));
for (const x of sorted.slice(0, Math.min(8, TOP))) {
  const g = x.g;
  const ws = x.perWindow.map(p => f2(p.ex, '%').padStart(7)).join(' ');
  console.log(
    `  ${String(g.minBullLevels).padStart(3)}  ${String(g.pullbackLookback).padStart(3)}  ` +
    `${String(g.triggerLookback).padStart(3)}  ${String(g.adjacentLookback).padStart(3)}  ${g.bigMa.padEnd(5)} ` +
    `${String(x.n).padStart(7)}  ${f2(ex(x.a4, BENCH.r4.avg), '%').padStart(7)}  ${x.w4.toFixed(0).padStart(4)}%  ${ws}`,
  );
}

/* --------- 8. 判据 --------- */
console.log(`\n\u001b[36m════════════ 结论判据 ════════════\u001b[0m`);
const e4all = results.map(x => ex(x.a4, BENCH.r4.avg)).filter(Number.isFinite).sort((a, b) => a - b);
const med4 = median(e4all);
console.log(`  全期 +4h 超额中位数 ${f2(med4, '%')}，${posShare(e4all).toFixed(0)}% 的参数组合为正`);
console.log(`  ${WINDOWS} 个窗口中，中位数为正的窗口数：${allPos}/${WINDOWS}`);
if (allPos === WINDOWS && med4 > 0.2) {
  console.log('  \u001b[32m每个窗口都为正 → 优势具备跨窗口稳定性，值得进一步研究。\u001b[0m');
} else if (allPos === WINDOWS) {
  console.log('  \u001b[33m每个窗口都为正但幅度很小 → 可能真实存在，但扣掉手续费/滑点后大概率不剩什么。\u001b[0m');
} else {
  console.log(`  \u001b[31m只有 ${allPos}/${WINDOWS} 个窗口为正 → 优势不稳定，随行情状态翻转，不能视为可复现的规律。\u001b[0m`);
}
console.log('  \u001b[2m注：样本来自「涨幅榜前 N」，本身含动量偏差，基准已包含该偏差；比较的是"信号是否额外创造价值"。\u001b[0m');
console.log('  \u001b[2m注：信号在同一标的相近时刻高度重叠，有效独立样本远少于信号条数，超额幅度需按此打折看待。\u001b[0m\n');

fs.writeFileSync('sweep-result.json', JSON.stringify({
  topN: TOPN, hours: HOURS, windows: WINDOWS, grid: GRID, bench: BENCH, benchPerWindow: BENCH_W,
  results: sorted.map(x => ({
    cfg: x.g, n: x.n, a1: x.a1, a4: x.a4, a8: x.a8, a24: x.a24, w4: x.w4,
    ex4: ex(x.a4, BENCH.r4.avg), perWindow: x.perWindow,
  })),
}, null, 1));
console.log('结果已写入 \u001b[2msweep-result.json\u001b[0m\n');
process.exit(0);
