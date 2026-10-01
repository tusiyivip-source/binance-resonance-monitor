/**
 * 实测：背驰过滤在真实数据上到底能拦下多少信号。
 *   node tools/probe-beichi-live.mjs [--symbols=60] [--hours=24]
 */
import { CandleSeries } from '../src/series.js';
import { analyzeLevelAtIndex, findResonance, evaluateSymbol } from '../src/signals.js';
import { LEVELS, DEFAULT_SIGNAL, APP } from '../src/config.js';
import { TokenBucket, RestClient } from '../src/rest.js';

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const TOPN = Number(argv.symbols || 60);
const HOURS = Number(argv.hours || 24);
const BASE = { ...DEFAULT_SIGNAL, scanMode: 'groups', beichiMinProgress: Number(argv.minProgress ?? 0.3) };
APP.maxCandlesKept = Math.ceil((HOURS * 60) / 3) + 300;

const rest = new RestClient(new TokenBucket(APP.weightPerMinute, APP.weightBurst));
const weightFor = lim => (lim >= 500 ? 5 : lim >= 100 ? 2 : 1);

const [tickers, info] = await Promise.all([
  rest.get(APP.tickerPath, { weight: APP.profile.tickerWeight }),
  rest.get(APP.exchangeInfoPath, { weight: 1, timeout: 30_000 }),
]);
const trading = new Set(info.symbols.filter(APP.profile.universeFilter).map(s => s.symbol));
const universe = tickers
  .filter(t => trading.has(t.symbol) && Number(t.count) >= 50)
  .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
  .slice(0, TOPN);
console.log(`\n取 ${universe.length} 个标的，回放 ${HOURS}h …`);

const data = [];
let done = 0;
await rest.mapLimit(universe, async t => {
  const sym = t.symbol;
  const series = {};
  try {
    await Promise.all(LEVELS.filter(l => l.native).map(async lv => {
      const lim = lv.key === '3m' ? Math.min(1000, Math.ceil((HOURS * 60) / 3) + 120) : (lv.limit ?? 200);
      const rows = await rest.get(`${APP.klinesPath}?symbol=${sym}&interval=${lv.key}&limit=${lim}`,
        { weight: weightFor(lim), retries: 1 });
      const s = new CandleSeries(lv);
      s.bulkLoad(rows.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], n: +k[8], done: k[6] < Date.now() })));
      series[lv.key] = s;
    }));
  } catch { return; }
  for (const lv of LEVELS) {
    if (lv.native) continue;
    series[lv.key] = new CandleSeries(lv);
    series[lv.key].rebuildFrom(series[lv.from]);
  }
  const inds = {};
  for (const lv of LEVELS) inds[lv.key] = series[lv.key].ensure();
  const base3m = series['3m'];
  const ms3 = 180_000;
  const hi = base3m.closedCount - 1;
  const lo = Math.max(160, base3m.closedCount - Math.ceil((HOURS * 60) / 3));
  const ptrs = {};
  for (const lv of LEVELS) {
    const s = series[lv.key], arr = new Int32Array(hi - lo + 1);
    let p = 30;
    for (let j = 0, bi = lo; bi <= hi; bi++, j++) {
      const T = base3m.t[bi] + ms3;
      while (p + 1 < s.t.length && s.t[p + 1] + s.ms <= T) p++;
      arr[j] = p;
    }
    ptrs[lv.key] = arr;
  }
  data.push({ sym, series, inds, ptrs, lo, hi, L: hi - lo + 1 });
  done++;
  if (done % 15 === 0) process.stdout.write(`  已载入 ${done}/${universe.length}\r`);
});
console.log(`\n数据就绪 ${data.length} 个标的。`);

function replay(filterBeichi) {
  const cfg = { ...BASE, filterBeichi };
  const out = { total: 0, byGroup: {}, blockedByMid: 0, midHadState: 0, midTotal: 0, midPending: 0 };
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
        out.total++;
        out.byGroup[m.group] = (out.byGroup[m.group] || 0) + 1;
      }
    }
  }
  return out;
}

/* 关闭过滤：基线 */
const off = replay(false);
/* 打开过滤 */
const on = replay(true);

console.log('\n=== 结果 ===');
console.log(`  关闭背驰过滤：${off.total} 条信号`);
console.log(`  开启背驰过滤：${on.total} 条信号`);
console.log(`  被拦下：${off.total - on.total} 条（${off.total ? (((off.total - on.total) / off.total) * 100).toFixed(1) : 0}%）`);

/* 统计：确认级别当下处于「将背驰」的比例（不看是否有信号） */
console.log('\n=== 确认级别（15分）在各时刻的背驰状态分布 ===');
const cfg = { ...BASE, filterBeichi: true };
let tot = 0, pending = 0, noState = 0, upStroke = 0, newHigh = 0, weaker = 0;
for (const d of data.slice(0, 20)) {
  for (let j = 0; j < d.L; j += 3) {
    const s = d.series['15m'];
    const v = analyzeLevelAtIndex(s, d.inds['15m'], d.ptrs['15m'][j], cfg);
    if (!v) continue;
    tot++;
    const st = v.chanState;
    if (!st || !st.ok) { noState++; continue; }
    if (st.dir === 'up') upStroke++;
    if (st.newExtreme) newHigh++;
    if (st.weaker) weaker++;
    if (st.divergence.status === 'pending') pending++;
  }
}
console.log(`  样本 ${tot}  笔状态可用 ${tot - noState}  当前笔向上 ${upStroke}  创新高 ${newHigh}  力度衰减 ${weaker}`);
console.log(`  其中判定为「将背驰」：${pending}  (${tot ? (pending / tot * 100).toFixed(2) : 0}%)`);
console.log(`  背驰过滤开启后被拦下的信号：${off.total - on.total} 条\n`);
