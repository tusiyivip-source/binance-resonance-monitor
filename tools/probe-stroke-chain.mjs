/**
 * 实测「回踩成笔链」条件的拦截率。
 *   node tools/probe-stroke-chain.mjs [--symbols=60] [--hours=24]
 *
 * 同时对比三种口径：
 *   A 关闭           —— 只看现有逻辑
 *   B 只要求成笔     —— requireStrokeChain
 *   C 成笔 + 站上均线 —— 再加 chainRequireAboveMa（「5m 带动 15m 也站上均线」）
 */
import { CandleSeries } from '../src/series.js';
import { analyzeLevelAtIndex, findResonance, checkStrokeChain } from '../src/signals.js';
import { LEVELS, DEFAULT_SIGNAL, APP } from '../src/config.js';
import { TokenBucket, RestClient } from '../src/rest.js';

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const TOPN = Number(argv.symbols || 60);
const HOURS = Number(argv.hours || 24);
const BASE = { ...DEFAULT_SIGNAL, scanMode: 'groups', filterBeichi: true };
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
console.log(`\n取 ${universe.length} 个标的，回放 ${HOURS}h …`);

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

function replay(cfg, cfgViews) {
  const cv = cfgViews ?? cfg;
  const out = { total: 0, byGroup: {}, each: [] };
  for (const d of data) {
    const seen = new Set();
    for (let j = 0; j < d.L; j++) {
      const views = { __symbol: d.sym };
      let ok = true;
      for (const lv of LEVELS) {
        const s = d.series[lv.key];
        if (s.t.length < 40) { ok = false; break; }
        views[lv.key] = analyzeLevelAtIndex(s, d.inds[lv.key], d.ptrs[lv.key][j], cv);
      }
      if (!ok) continue;
      const res = findResonance(views, cfg, 'closed');
      for (const m of res.matches) {
        const k = `${m.base}|${m.candleT}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.total++;
        out.byGroup[m.group] = (out.byGroup[m.group] || 0) + 1;
        // 无论过滤是否开启，都把成笔链情况算出来（用于诊断）
        const chain = checkStrokeChain(views, m.baseIdx, m.midIdx, cv);
        out.each.push({
          sym: d.sym, group: m.group, need: chain.need, got: chain.got,
          missing: chain.missing, level: chain.level, topT: chain.topT,
          baseStroke: views[m.base]?.stroke ?? null,
          downs: chain.need.map(key => {
            const st = views[key]?.stroke;
            return { key, botT: st?.down?.botT ?? null, bars: st?.down?.bars ?? null, pts: st?.points ?? 0 };
          }),
        });
      }
    }
  }
  return out;
}

const A = replay({ ...BASE, requireStrokeChain: false }, { ...BASE, requireStrokeChain: true });
const B = replay({ ...BASE, requireStrokeChain: true, chainRequireAboveMa: false });
const C = replay({ ...BASE, requireStrokeChain: true, chainRequireAboveMa: true });

const pct = (a, b) => a ? ((b / a) * 100).toFixed(1) + '%' : '—';
console.log('\n=== 拦截效果 ===');
console.log(`  A 关闭成笔链        ：${A.total} 条`);
console.log(`  B 要求全部成笔      ：${B.total} 条  （保留 ${pct(A.total, B.total)}，拦掉 ${A.total - B.total} 条）`);
console.log(`  C 成笔 + 都站上均线 ：${C.total} 条  （保留 ${pct(A.total, C.total)}，拦掉 ${A.total - C.total} 条）`);

console.log('\n=== 各组合的保留情况（B 口径）===');
for (const g of Object.keys(A.byGroup)) {
  console.log(`  ${g.padEnd(14)} 关闭 ${String(A.byGroup[g]).padStart(4)} → 成笔 ${String(B.byGroup[g] ?? 0).padStart(4)} → +均线 ${String(C.byGroup[g] ?? 0).padStart(4)}`);
}

console.log('\n=== 被拦下的原因分布（A 口径里有多少条缺笔）===');
const missCount = {};
for (const e of A.each) {
  const key = e.missing.length ? e.missing.join('+') : '（成笔链完整）';
  missCount[key] = (missCount[key] || 0) + 1;
}
for (const [k, v] of Object.entries(missCount).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  缺少 ${k.padEnd(22)} ${String(v).padStart(4)} 条`);
}

console.log('\n=== 逐组统计：回踩低点到「基准见顶」的间隔 ===');
const byGroup = {};
for (const e of A.each) {
  (byGroup[e.group] ??= []).push(e);
}
for (const [g, list] of Object.entries(byGroup)) {
  const okN = list.filter(e => !e.missing.length).length;
  const gaps = [];
  for (const e of list) {
    if (!e.topT) continue;
    for (const dn of e.downs) {
      if (dn.botT == null) continue;
      gaps.push({ key: dn.key, min: Math.round((dn.botT - e.topT) / 60000) });
    }
  }
  const missKeys = {};
  for (const e of list) for (const k of e.missing) missKeys[k] = (missKeys[k] || 0) + 1;
  console.log(`  ${g.padEnd(13)} 共 ${String(list.length).padStart(3)} 条，成笔链完整 ${String(okN).padStart(3)} 条（${(okN / list.length * 100).toFixed(0)}%）`);
  console.log(`      各级别「底 − 基准顶」间隔(分钟)中位数: ` + Object.entries(gaps.reduce((a, x) => {
    (a[x.key] ??= []).push(x.min); return a;
  }, {})).map(([k, arr]) => {
    arr.sort((x, y) => x - y);
    return `${k}=${arr[Math.floor(arr.length / 2)]}`;
  }).join('  '));
  console.log(`      缺失计数: ` + (Object.entries(missKeys).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ') || '无'));
}

console.log('\n=== 样例（A 口径前 10 条）===');
for (const e of A.each.slice(0, 10)) {
  const d = e.downs.map(x => `${x.key}:${x.botT ?? 'NA'}`).join(' ');
  console.log(`  ${e.sym.padEnd(11)} ${e.group.padEnd(12)} 需要[${e.need.join(',')}] 缺[${e.missing.join(',') || '无'}] 延至 ${e.level ?? '—'}`);
  console.log(`      基准顶 ${e.topT ? new Date(e.topT).toISOString().slice(5, 16) : 'NA'}   各级别笔底 ${d}`);
}
