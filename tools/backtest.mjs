/**
 * 历史回测：把信号引擎在真实历史K线上滑窗重放。
 *   node tools/backtest.mjs [--symbols=100] [--hours=24] [--all-bases]
 *
 * 用途：证明「多级别共振」逻辑在真实市场中确实会触发，
 *      并统计触发后的 1h / 4h / 24h 前向收益与胜率。
 */
import { CandleSeries } from '../src/series.js';
import { analyzeLevelAtIndex, findResonance } from '../src/signals.js';
import { LEVELS, DEFAULT_SIGNAL } from '../src/config.js';import { TokenBucket, RestClient } from '../src/rest.js';
import { APP } from '../src/config.js';

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const TOPN = Number(argv.symbols || 100);
const HOURS = Number(argv.hours || 24);
// 默认回测"实盘正在用的那套配置"（固定级别组合）；
// --auto 则改用穷举模式（基准 + 下一档 + 任意更大级别）
const cfg = argv.auto
  ? { ...DEFAULT_SIGNAL, scanMode: 'auto', baseMinIdx: 2, baseMaxIdx: 6 }
  : { ...DEFAULT_SIGNAL };

// 回测需要比实盘更长的历史：放宽序列保留上限，否则 3m 序列会被裁到 400 根（≈20h），
// 令 --hours 形同虚设、远期收益全部无样本。
APP.maxCandlesKept = Math.max(APP.maxCandlesKept, Math.ceil((HOURS * 60) / 3) + 300);

const bucket = new TokenBucket(APP.weightPerMinute, APP.weightBurst);
const rest = new RestClient(bucket);

/** 各周期需要拉取的K线数（3m/5m 覆盖回测窗口，其余保证 MA99 足够） */
function limitFor(lv) {
  if (lv.key === '3m' || lv.key === '5m') return Math.min(1000, Math.ceil((HOURS * 60) / lv.minutes) + 120);
  return 200;
}
const weightFor = lim => (lim >= 500 ? 5 : lim >= 100 ? 2 : 1);

const modeDesc = cfg.scanMode === 'auto'
  ? `穷举模式（基准 ${LEVELS[cfg.baseMinIdx].key}–${LEVELS[cfg.baseMaxIdx].key}）`
  : `固定组合 ${(cfg.groups ?? []).filter(g => g.enabled !== false).map(g => `${g.base}→${g.mid}→${g.big}`).join(' , ')}`;
console.log(`\n\u001b[36m▌历史回测\u001b[0m  标的=${TOPN}  窗口=${HOURS}h\n  ${modeDesc}  共振≥${cfg.minBullLevels}级\n`);

/* ---------- 1. 取涨幅榜 ---------- */
const [tickers, info] = await Promise.all([
  rest.get(APP.tickerPath, { weight: APP.profile.tickerWeight }),
  rest.get(APP.exchangeInfoPath, { weight: APP.market === 'futures' ? 1 : 20, timeout: 30_000 }),
]);
const trading = new Set(info.symbols.filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT').map(s => s.symbol));
const BAD = /(UP|DOWN|BULL|BEAR)USDT$/;
const universe = tickers
  .filter(t => t.symbol.endsWith('USDT') && !BAD.test(t.symbol)
    && trading.has(t.symbol)            // 与实盘一致的交易状态过滤
    && Number(t.count) >= 50            // 与实盘一致的死盘保险丝
    && Number(t.quoteVolume) > 0)
  .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
  .slice(0, TOPN);
console.log(`取涨幅榜前 ${universe.length} 个标的，开始拉取历史K线（约需 1 分钟，受权重预算约束）…\n`);

/* ---------- 2. 拉历史并滑窗重放 ---------- */
const signals = [];
const bench = [];
let done = 0, skipped = 0;

await rest.mapLimit(universe, async t => {
  const sym = t.symbol;
  const series = {};
  try {
    await Promise.all(LEVELS.filter(l => l.native).map(async lv => {
      const lim = limitFor(lv);
      const rows = await rest.get(
        `${APP.klinesPath}?symbol=${sym}&interval=${lv.key}&limit=${lim}`,
        { weight: weightFor(lim), retries: 2 },
      );
      const s = new CandleSeries(lv);
      s.bulkLoad(rows.map(k => ({
        t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4],
        v: +k[5], q: +k[7], n: +k[8], done: k[6] < Date.now(),
      })));
      series[lv.key] = s;
    }));
  } catch (e) {
    skipped++;
    return;
  }
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
  if (closed3 < 60) { skipped++; return; }

  // 回测起点：窗口开始处的 3m 索引
  const startIdx = Math.max(120, closed3 - Math.ceil((HOURS * 60) / 3));
  const ptr = {};                                  // 每个级别当前已收盘到的索引
  for (const lv of LEVELS) ptr[lv.key] = 30;

  const localSeen = new Set();
  for (let bi = startIdx; bi < closed3; bi++) {
    const T = base3m.t[bi] + ms3;                  // 该根 3m 的收盘时刻
    for (const lv of LEVELS) {
      const s = series[lv.key], ms = s.ms;
      let p = ptr[lv.key];
      while (p + 1 < s.t.length && s.t[p + 1] + ms <= T) p++;
      ptr[lv.key] = p;
    }
    const views = { __symbol: sym };
    let usable = true;
    for (const lv of LEVELS) {
      const s = series[lv.key];
      if (s.t.length < 40) { usable = false; break; }
      views[lv.key] = analyzeLevelAtIndex(s, inds[lv.key], ptr[lv.key], cfg);
    }
    if (!usable) continue;

    const res = findResonance(views, cfg, 'closed');

    // 前向收益取价：以 3m 收盘价为基准；超出 3m 数据范围时回退到 30m 序列
    const ref = series['30m'], refMs = ref.ms;
    const p0 = base3m.c[bi];
    const fwd = h => {
      const want = T + h * 3600_000;
      const j = bi + Math.round((h * 60) / 3) - 1;
      for (let k = j; k < closed3; k++) {
        if (base3m.t[k] + ms3 >= want) return base3m.c[k];
      }
      for (let k = 0; k < ref.t.length; k++) {
        if (ref.t[k] + refMs < want || ref.t[k] < T) continue;
        return ref.c[k];
      }
      return null;
    };
    const pct = x => (x == null ? null : ((x - p0) / p0) * 100);

    // 基准：同期"无脑持有该标的"的收益（每隔 5 根 3m 采样一次，降低自相关）
    if (bi % 5 === 0) {
      bench.push({ r1: pct(fwd(1)), r4: pct(fwd(4)), r8: pct(fwd(8)), r24: pct(fwd(24)) });
    }

    const best = {};
    for (const m of res.matches) {
      const key = `${m.base}|${m.candleT}`;
      if (localSeen.has(key)) continue;
      localSeen.add(key);
      if (!best[m.base] || m.score > best[m.base].score) best[m.base] = m;
    }
    for (const m of Object.values(best)) {
      signals.push({
        sym, base: m.base, mid: m.mid, big: m.big, score: m.score,
        bullCount: m.bullCount, ts: m.candleT, price: p0,
        r1: pct(fwd(1)), r4: pct(fwd(4)), r8: pct(fwd(8)), r24: pct(fwd(24)),
      });
    }
  }
  done++;
  if (done % 20 === 0) process.stdout.write(`  已回放 ${done}/${universe.length}\r`);
});

/* ---------- 3. 统计 ---------- */
const stat = arr => {
  const v = arr.filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    avg: sum / v.length,
    med: v[(v.length - 1) >> 1],
    win: (v.filter(x => x > 0).length / v.length) * 100,
    best: v[v.length - 1],
    worst: v[0],
  };
};
const fmt = s => s.n ? `${s.avg >= 0 ? '+' : ''}${s.avg.toFixed(2)}% 中位 ${s.med >= 0 ? '+' : ''}${s.med.toFixed(2)}% 胜率 ${s.win.toFixed(0)}% (${s.n})` : '—';

console.log(`\n\n\u001b[36m════════════ 回测结果 ════════════\u001b[0m`);
console.log(`回放标的 ${done} 个（跳过 ${skipped} 个数据不足）`);
console.log(`触发信号 \u001b[33m${signals.length}\u001b[0m 条，涉及 \u001b[33m${new Set(signals.map(s => s.sym)).size}\u001b[0m 个币种\n`);

if (signals.length) {
  console.log(`\u001b[36m▌前向收益（自信号K线收盘价起算）\u001b[0m`);
  const rows = [
    ['+1h', 'r1'], ['+4h', 'r4'], ['+8h', 'r8'], ['+24h', 'r24'],
  ];
  console.log('   周期    信号收益'.padEnd(52) + '同期基准（无脑持有该榜）'.padEnd(40) + '超额');
  for (const [label, k] of rows) {
    const s = stat(signals.map(x => x[k]));
    const b = stat(bench.map(x => x[k]));
    const edge = (s.n && b.n) ? s.avg - b.avg : null;
    console.log(`   ${label.padEnd(6)} ${fmt(s).padEnd(46)} ${fmt(b).padEnd(36)} `
      + `${edge == null ? '—' : (edge >= 0 ? '+' : '') + edge.toFixed(2) + '%'}`);
  }
  console.log(`   \u001b[2m基准样本数：${bench.length}（每 5 根 3m 采样一次）\u001b[0m`);

  const byScore = [['≥80分', s => s.score >= 80], ['60–79分', s => s.score >= 60 && s.score < 80], ['<60分', s => s.score < 60]];
  console.log(`\n\u001b[36m▌按评分分组（+4h）\u001b[0m`);
  for (const [name, f] of byScore) console.log(`  ${name.padEnd(8)}${fmt(stat(signals.filter(f).map(s => s.r4)))}`);

  const cnt = (arr, key) => arr.reduce((m, s) => (m[s[key]] = (m[s[key]] || 0) + 1, m), {});
  const top = (obj, n = 8) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k}:${v}`).join('  ');
  console.log(`\n\u001b[36m▌基准级别分布\u001b[0m  ${top(cnt(signals, 'base'))}`);
  console.log(`\u001b[36m▌最大级别分布\u001b[0m  ${top(cnt(signals, 'big'))}`);
  console.log(`\u001b[36m▌评分分布\u001b[0m     均分 ${(signals.reduce((a, s) => a + s.score, 0) / signals.length).toFixed(1)}，最高 ${Math.max(...signals.map(s => s.score))}`);

  console.log(`\n\u001b[36m▌信号最多的币种\u001b[0m  ${top(cnt(signals, 'sym'), 10)}`);
  console.log(`\n\u001b[36m▌最近 10 条信号\u001b[0m`);
  for (const s of signals.slice(-10)) {
    const d = new Date(s.ts);
    const p = n => String(n).padStart(2, '0');
    console.log(`  ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}  ${s.sym.padEnd(12)} ${s.base}→${s.mid}→${s.big}`.padEnd(62)
      + ` ${String(s.score).padStart(3)}分  +4h ${s.r4 == null ? '—' : (s.r4 >= 0 ? '+' : '') + s.r4.toFixed(2) + '%'}`);
  }
}

const fs = await import('node:fs');
fs.writeFileSync('backtest-result.json', JSON.stringify({ cfg, topN: TOPN, hours: HOURS, count: signals.length, signals }, null, 1));
console.log(`\n结果已写入 \u001b[2mbacktest-result.json\u001b[0m\n`);
process.exit(0);
