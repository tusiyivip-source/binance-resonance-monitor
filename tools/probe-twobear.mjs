/**
 * 实测「两根阴K不破均线」形态的拦截率与分布。
 *   node tools/probe-twobear.mjs [--symbols=60] [--hours=24] [--bars=2]
 *
 * 对比四种口径（其余过滤全部关闭，只看基准形态本身）：
 *   A touch        现行：最低价触及 MA7 + 上穿 MA7 事件
 *   B twoBearHold  两根阴K，收盘不破 MA7/EMA7，当前收盘同时站上两条均线
 *   C A + 成笔链
 *   D B + 成笔链
 */
import { CandleSeries } from '../src/series.js';
import { analyzeLevelAtIndex, findResonance } from '../src/signals.js';
import { LEVELS, DEFAULT_SIGNAL, APP } from '../src/config.js';
import { TokenBucket, RestClient } from '../src/rest.js';

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const TOPN = Number(argv.symbols || 60);
const HOURS = Number(argv.hours || 24);
const BARS = Number(argv.bars || 2);
const BASE = { ...DEFAULT_SIGNAL, scanMode: 'groups', filterBeichi: false };
APP.maxCandlesKept = Math.ceil((HOURS * 60) / 3) + 400;

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
console.log(`\n取 ${universe.length} 个标的，回放 ${HOURS}h，阴K根数 = ${BARS} …`);

const data = [];
let done = 0;
await rest.mapLimit(universe, async t => {
  const sym = t.symbol;
  const series = {};
  try {
    await Promise.all(LEVELS.filter(l => l.native).map(async lv => {
      const lim = lv.backfill ?? lv.limit ?? 200;
      const rows = await rest.get(`${APP.klinesPath}?symbol=${sym}&interval=${lv.key}&limit=${lim}`,
        { weight: weightFor(lim), retries: 1 });
      const s = new CandleSeries(lv);
      s.mergeLoad(rows.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], n: +k[8], done: k[6] < Date.now() })));
      series[lv.key] = s;
    }));
  } catch { return; }
  for (const lv of LEVELS) { if (lv.native) continue; series[lv.key] = new CandleSeries(lv); series[lv.key].rebuildFrom(series[lv.from]); }
  const inds = {};
  for (const lv of LEVELS) inds[lv.key] = series[lv.key].ensure();
  const base3m = series['3m'];
  const ms3 = 180_000;
  const hi = base3m.closedCount - 1;
  const lo = Math.max(200, base3m.closedCount - Math.ceil((HOURS * 60) / 3));
  if (hi <= lo) return;
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
  data.push({ sym, series, inds, ptrs, L: hi - lo + 1 });
  done++;
  if (done % 15 === 0) process.stdout.write(`  已载入 ${done}/${universe.length}\r`);
});
console.log(`\n数据就绪 ${data.length} 个标的。`);

function replay(cfg) {
  const out = { total: 0, byGroup: {}, baseKeys: new Set(), extraBlocked: { twoBear: 0, chain: 0 } };
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
        out.baseKeys.add(`${d.sym}|${k}`);
      }
    }
  }
  return out;
}

const A = replay({ ...BASE, pullbackPattern: 'touch', pullbackBars: BARS, requireStrokeChain: false });
const B = replay({ ...BASE, pullbackPattern: 'twoBearHold', pullbackBars: BARS, requireStrokeChain: false });
const C = replay({ ...BASE, pullbackPattern: 'touch', pullbackBars: BARS, requireStrokeChain: true });
const D = replay({ ...BASE, pullbackPattern: 'twoBearHold', pullbackBars: BARS, requireStrokeChain: true });

const pct = (a, b) => a ? ((b / a) * 100).toFixed(1) + '%' : '—';
console.log('\n=== 信号数对比 ===');
console.log(`  A 触及MA7 + 上穿（旧）      ：${String(A.total).padStart(4)} 条`);
console.log(`  B 两根阴K不破均线（新）     ：${String(B.total).padStart(4)} 条   （相对 A 保留 ${pct(A.total, B.total)}）`);
console.log(`  C 旧  + 成笔链              ：${String(C.total).padStart(4)} 条   （相对 A 保留 ${pct(A.total, C.total)}）`);
console.log(`  D 新  + 成笔链              ：${String(D.total).padStart(4)} 条   （相对 B 保留 ${pct(B.total, D.total)}）`);

console.log('\n=== 各组合 ===');
for (const g of Object.keys(A.byGroup)) {
  console.log(`  ${g.padEnd(14)} 旧 ${String(A.byGroup[g]).padStart(3)}  →  新 ${String(B.byGroup[g] ?? 0).padStart(3)}`
    + `   |  旧+链 ${String(C.byGroup[g] ?? 0).padStart(3)}  →  新+链 ${String(D.byGroup[g] ?? 0).padStart(3)}`);
}

// 两种形态是否互相覆盖
let both = 0, onlyA = 0, onlyB = 0;
for (const k of A.baseKeys) { if (B.baseKeys.has(k)) both++; else onlyA++; }
for (const k of B.baseKeys) if (!A.baseKeys.has(k)) onlyB++;
console.log('\n=== 形态重叠度（按 币种|基准级别|K线时间 去重）===');
console.log(`  两者都命中 ${both}   仅旧命中 ${onlyA}   仅新命中 ${onlyB}`);
