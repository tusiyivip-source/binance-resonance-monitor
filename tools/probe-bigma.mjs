/** 定点排查：bigMa 参数是否真的影响结果 */
import { CandleSeries } from '../src/series.js';
import { analyzeLevelAtIndex, findResonance } from '../src/signals.js';
import { LEVELS, DEFAULT_SIGNAL, APP } from '../src/config.js';

APP.maxCandlesKept = 2000;
const HOURS = 24;
const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XVSUSDT', 'MOVRUSDT', 'QNTUSDT', 'WIFUSDT', 'SANDUSDT'];

const data = [];
for (const sym of syms) {
  const series = {};
  for (const lv of LEVELS.filter(l => l.native)) {
    const need = lv.key === '3m' ? HOURS * 20 + 160 : lv.key === '5m' ? HOURS * 12 + 160 : 220;
    const rows = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${lv.key}&limit=${Math.min(1000, need)}`).then(r => r.json());
    const s = new CandleSeries(lv);
    s.bulkLoad(rows.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], n: +k[8], done: k[6] < Date.now() })));
    series[lv.key] = s;
  }
  for (const lv of LEVELS.filter(l => !l.native)) {
    series[lv.key] = new CandleSeries(lv);
    series[lv.key].rebuildFrom(series[lv.from]);
  }
  const inds = {};
  for (const lv of LEVELS) inds[lv.key] = series[lv.key].ensure();
  const base3m = series['3m'], ms3 = 180000;
  const closed3 = base3m.closedCount;
  const hi = closed3 - 1, lo = Math.max(120, closed3 - HOURS * 20);
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
}

const base = { ...DEFAULT_SIGNAL, scanMode: 'auto', baseMinIdx: 2, baseMaxIdx: 6 };

function run(extra) {
  const cfg = { ...base, ...extra };
  const keys = new Set();
  const bigSeen = new Map();
  let count = 0;
  for (const d of data) {
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
        if (keys.has(k)) continue;
        keys.add(k);
        count++;
        // 记录"最大级别与两条均线的关系"，用于判断参数是否真的参与判定
        const big = views[m.big];
        const rel = big.close >= big.ema7 && big.close < big.ma7 ? 'ema7<=c<ma7'
          : big.close >= big.ma7 && big.ema7 > big.close ? 'ma7<=c<ema7'
            : big.close >= big.ma7 ? 'c>=both' : 'c<both';
        bigSeen.set(rel, (bigSeen.get(rel) || 0) + 1);
      }
    }
  }
  return { count, bigSeen };
}

const rE = run({ bigMa: 'ema7' });
const rM = run({ bigMa: 'ma7' });
console.log('\n单组参数下，bigMa 两种取值的差异：');
console.log(`  bigMa=ema7  信号数 ${rE.count}   最大级别与均线关系: ${JSON.stringify(Object.fromEntries(rE.bigSeen))}`);
console.log(`  bigMa=ma7   信号数 ${rM.count}   最大级别与均线关系: ${JSON.stringify(Object.fromEntries(rM.bigSeen))}`);
console.log(`  → 差异 ${rM.count - rE.count} 条`);

// 直接检查各"最大级别"上 ema7 与 ma7 的相对大小分布
console.log('\n各级别上 (EMA7 − MA7)/MA7 的分布（正=EMA7更高，条件更严）：');
for (const lv of LEVELS) {
  const vals = [];
  for (const d of data) {
    const s = d.series[lv.key], ind = d.inds[lv.key];
    for (let j = 0; j < d.L; j += 20) {
      const i = d.ptrs[lv.key][j];
      if (i < 30) continue;
      const m = ind.ma7[i], e = ind.ema7[i];
      if (Number.isFinite(m) && Number.isFinite(e) && m > 0) vals.push(((e - m) / m) * 100);
    }
  }
  if (!vals.length) { console.log(`  ${lv.key.padEnd(4)} 无样本`); continue; }
  vals.sort((a, b) => a - b);
  const q = p => vals[Math.floor(vals.length * p)].toFixed(3);
  console.log(`  ${lv.key.padEnd(4)} n=${String(vals.length).padStart(4)}  中位 ${q(0.5)}%   5%分位 ${q(0.05)}%   95%分位 ${q(0.95)}%   EMA7>MA7 占比 ${(vals.filter(v => v > 0).length / vals.length * 100).toFixed(0)}%`);
}
