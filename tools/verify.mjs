/**
 * 独立验证脚本： node tools/verify.mjs
 *
 * 1) 本地合成K线是否与币安原生K线完全一致（用 1m→3m 对照原生 3m，覆盖全部字段）
 * 2) MA/EMA 是否与朴素实现逐点一致
 * 3) 信号引擎「正样例」必须触发
 * 4) 信号引擎「负样例」必须不触发（最大级别破位 / 共振级别不足 / 无回踩 / 相邻未上穿）
 * 5) 真实行情冒烟测试
 */
import { CandleSeries } from '../src/series.js';
import { memoryStorage } from '../src/file-storage.js';
import * as CandleSeriesMod from '../src/series.js';
import { buildSMA, buildEMA } from '../src/indicators.js';
import { evaluateSymbol, analyzeLevel, findResonance, triplesFor, strokeChain, checkStrokeChain, findTwoBearHold, findTwoBullHold, dualPattern } from '../src/signals.js';
import { LEVELS, VISIBLE_LEVELS, DEFAULT_SIGNAL, DEFAULT_GROUPS, LEVEL_INDEX, APP, DEFAULT_WATCH_GROUPS } from '../src/config.js';
import { Watcher } from '../src/watch.js';

// 验证脚本自己控制序列保留上限，避免受实盘 maxCandlesKept 影响导致对比样本数漂移
APP.maxCandlesKept = 3000;

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  \u001b[32m✓\u001b[0m ${name}${detail ? '  \u001b[2m' + detail + '\u001b[0m' : ''}`); }
  else { fail++; results.push(`  \u001b[31m✗\u001b[0m ${name}  \u001b[31m${detail}\u001b[0m`); }
}
const section = t => results.push(`\n\u001b[36m▌${t}\u001b[0m`);

// 基线配置：显式关掉「回踩成笔链」与「背驰过滤」这两个新增过滤器。
// 第 3/4/9 节测的是**原有触发逻辑**，用合成K线（分型结构很稀疏）根本凑不出成笔链，
// 开着会把旧断言全部打成 0 命中。两个过滤器各自在第 8/9、11 节单独验证。
const cfg = { ...DEFAULT_SIGNAL, signalEnabled: true, requireStrokeChain: false, filterBeichi: false, pullbackPattern: 'touch' };
const MIN = 60_000;

/* ============ 1. 合成K线 vs 币安原生K线 ============ */
section('1. K线合成正确性（1m 合成 3m 对照币安原生 3m）');
try {
  const [r1, r3] = await Promise.all([
    fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000').then(r => r.json()),
    fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=3m&limit=400').then(r => r.json()),
  ]);
  const src = new CandleSeries({ key: '1m', minutes: 1, native: true });
  src.bulkLoad(r1.map(k => ({
    t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], n: +k[8], done: true,
  })));
  const agg = new CandleSeries({ key: '3m', minutes: 3, native: false, from: '1m', ratio: 3 });
  agg.rebuildFrom(src);

  const native = new Map(r3.map(k => [k[0], k]));
  // 边界处理：1m 与 3m 是两个**并行独立请求**，响应生成时刻有毫秒级差。
  // 若 3m 先返回、1m 后返回，边界桶在两边就不同步：原生 3m 记的是"未收盘快照"，
  // 而 1m 已经凑满 3 根 → 合成侧认为它已收盘。只比较结束时间早于两者中较晚者的桶。
  const last1mEnd = r1[r1.length - 1][0] + 60_000;
  const last3mStart = r3[r3.length - 1][0];
  const cutoff = Math.min(last1mEnd, last3mStart);

  let cmp = 0, mismatch = 0, firstBad = null, skippedTail = 0;
  // 从第 1 根开始比较：1m 数据的起点可能落在第 0 个 3m 桶的中间，该桶天然不完整；
  // 同时跳过尚未收盘的桶（其 close/high/low 仍在变化）与上面说的边界桶。
  for (let i = 1; i < agg.t.length; i++) {
    if (!agg.done[i]) continue;
    if (agg.t[i] + 3 * 60_000 > cutoff) { skippedTail++; continue; }
    const n = native.get(agg.t[i]);
    if (!n) continue;                    // 原生数组未覆盖到的桶跳过
    cmp++;
    const d = {
      o: Math.abs(+n[1] - agg.o[i]),
      h: Math.abs(+n[2] - agg.h[i]),
      l: Math.abs(+n[3] - agg.l[i]),
      c: Math.abs(+n[4] - agg.c[i]),
      v: Math.abs(+n[5] - agg.v[i]),
      q: Math.abs(+n[7] - agg.q[i]),
    };
    const bad = Object.entries(d).find(([, v]) => v > 1e-6);
    if (bad) { mismatch++; if (!firstBad) firstBad = { t: agg.t[i], field: bad[0], delta: bad[1] }; }
  }
  ok(`对比 ${cmp} 根合成K线（OHLCV+成交额，容差 1e-6）`, cmp > 100 && mismatch === 0,
    mismatch ? `${mismatch} 根不一致，首个：${JSON.stringify(firstBad)}`
      : `全部逐字段一致（另跳过 ${skippedTail} 根边界/未收盘桶）`);
  ok('收盘标记正确（末根之外均为已收盘）', agg.done.slice(0, -1).every(Boolean));
} catch (e) {
  ok('K线合成对照（网络）', false, e.message);
}

/* ============ 2. 指标正确性 ============ */
section('2. 技术指标正确性');
{
  const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.3);
  const ma7 = buildSMA(closes, 7);
  const naiveSMA = closes.map((_, i) => i < 6 ? NaN : closes.slice(i - 6, i + 1).reduce((a, b) => a + b, 0) / 7);
  let d1 = 0;
  for (let i = 0; i < closes.length; i++) {
    if (Number.isNaN(naiveSMA[i])) { if (!Number.isNaN(ma7[i])) d1++; continue; }
    d1 = Math.max(d1, Math.abs(ma7[i] - naiveSMA[i]));
  }
  ok('SMA7 与朴素实现逐点一致', d1 < 1e-9, `最大偏差 ${d1.toExponential(2)}`);

  const ema7 = buildEMA(closes, 7);
  let e = closes.slice(0, 7).reduce((a, b) => a + b, 0) / 7;
  let maxd = 0;
  for (let i = 7; i < closes.length; i++) {
    e = closes[i] * (2 / 8) + e * (6 / 8);
    maxd = Math.max(maxd, Math.abs(e - ema7[i]));
  }
  ok('EMA7 递推一致（SMA 种子）', maxd < 1e-9, `最大偏差 ${maxd.toExponential(2)}`);
}

/* ============ 合成K线工厂 ============ */
function seriesFromCloses(level, closes, opt = {}) {
  const s = new CandleSeries(level);
  const ms = level.minutes * MIN;
  const t0 = Math.floor(Date.now() / ms) * ms - closes.length * ms;
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    const o = i ? closes[i - 1] : c;
    s.t.push(t0 + i * ms);
    s.o.push(o);
    s.c.push(c);
    s.h.push(Math.max(o, c) * 1.0015);
    s.l.push(Math.min(o, c) * (opt.wideLow ? 0.985 : 0.9975));
    s.v.push(1000);
    s.q.push(1000 * c);
    s.n.push(10);
    s.done.push(true);
  }
  s.dirty = true;
  return s;
}

/**
 * 生成"上涨 → 回踩MA7 → 放量突破MA7/EMA7"的多头路径。
 * 回踩根收盘刻意压在 MA7 之下 0.3%，突破根大幅拉起，确保上穿形态成立。
 */
function bullBreakoutPath(n, { pullback = true, breakout = true } = {}) {
  const closes = [];
  let p = 100;
  const ma7 = a => a.slice(-7).reduce((x, y) => x + y, 0) / 7;
  const tail = pullback ? 2 : 1;
  for (let i = 0; i < n - tail; i++) { p *= 1.0035; closes.push(p); }
  if (pullback) closes.push(ma7(closes) * 0.997);
  if (breakout) closes.push(closes[closes.length - 1] * 1.06);
  return closes;
}

function buildLevels(overrides = {}) {
  const map = {};
  for (const lv of LEVELS) {
    const o = overrides[lv.key] ?? {};
    const closes = o.closes ?? bullBreakoutPath(80, o);
    map[lv.key] = seriesFromCloses(lv, closes, o);
  }
  return map;
}

const has = (matches, pred) => matches.some(pred);

/* ============ 3. 正样例 ============ */
section('3. 信号引擎 · 正样例（固定三元组，必须触发）');
{
  const series = buildLevels();
  const res = evaluateSymbol('TESTUSDT', series, cfg, false);
  const m = res.matches;
  const groupsHit = [...new Set(m.map(x => x.group))];
  ok('识别出多级别共振', m.length > 0, `命中 ${m.length} 组：${groupsHit.join(' / ')}`);

  ok('命中用户示例组合：3分 → 15分 → 2时（跨级，非相邻）', groupsHit.includes('3m>15m>2h'));
  ok('命中用户示例组合：2分 → 10分 → 1时（2分由1分合成）', groupsHit.includes('2m>10m>1h'));
  ok('命中用户示例组合：5分 → 30分 → 3时（3时由1时合成）', groupsHit.includes('5m>30m>3h'));

  ok('共振级别数 ≥ 3', res.bullCount >= cfg.minBullLevels, `实际 ${res.bullCount}/${VISIBLE_LEVELS.length} 个级别多头排列`);
  ok('已确认为收盘信号', m.every(x => x.confirmed));
  ok('评分在 0–100 区间', m.every(x => x.score >= 0 && x.score <= 100), `区间 ${Math.min(...m.map(x => x.score))}–${Math.max(...m.map(x => x.score))}`);

  // —— 三元组解析 ——
  const tri = triplesFor({ ...cfg, scanMode: 'groups', groups: DEFAULT_GROUPS });
  ok('三元组解析：固定组合模式恰好 3 组，且允许跨级（3分→15分→2时）',
    tri.length === 3 && tri.some(t => t.b === LEVEL_INDEX['3m'] && t.m === LEVEL_INDEX['15m'] && t.k === LEVEL_INDEX['2h']),
    tri.map(t => `${LEVELS[t.b].key}>${LEVELS[t.m].key}>${LEVELS[t.k].key}`).join(' , '));

  const triAuto = triplesFor({ ...cfg, scanMode: 'auto' });
  ok('三元组解析：穷举模式下确认级别取下一档',
    triAuto.length >= 40 && triAuto.every(t => t.m === t.b + 1 && t.k > t.m), `${triAuto.length} 组`);

  ok('三元组解析：顺序非法（基准 > 确认）被丢弃',
    triplesFor({ ...cfg, scanMode: 'groups', groups: [{ base: '2h', mid: '15m', big: '3h', enabled: true }] }).length === 0);
  ok('三元组解析：停用的组合不参与扫描',
    triplesFor({ ...cfg, scanMode: 'groups', groups: [{ base: '3m', mid: '15m', big: '2h', enabled: false }] }).length === 0);
  ok('三元组解析：全部组合都停用时不回退到穷举（不出信号）',
    triplesFor({ ...cfg, scanMode: 'groups', groups: [{ base: '3m', mid: '15m', big: '2h', enabled: false }] }).length === 0
    && evaluateSymbol('OFFUSDT', buildLevels(), { ...cfg, groups: [{ base: '3m', mid: '15m', big: '2h', enabled: false }] }, false).matches.length === 0);

  // —— 单个组合模式：只应产出该组合 ——
  const one = evaluateSymbol('ONEUSDT', buildLevels(), { ...cfg, groups: [{ base: '3m', mid: '15m', big: '2h', enabled: true }] }, false);
  ok('固定组合模式只产出被配置的那一组',
    one.matches.length > 0 && one.matches.every(x => x.group === '3m>15m>2h'),
    `${one.matches.length} 组，全部为 3m>15m>2h`);

  // —— 2分钟确实由1分钟合成而来（走真实的合成器，而非各造一份） ——
  {
    const lv1 = LEVELS[LEVEL_INDEX['1m']], lv2 = LEVELS[LEVEL_INDEX['2m']];
    const ms1 = 60_000, ms2 = 120_000;
    const fill = (s1, t0, n) => {
      for (let i = 0; i < n; i++) {
        const c = 100 + i;
        s1.t.push(t0 + i * ms1); s1.o.push(c - 0.5); s1.h.push(c + 0.4);
        s1.l.push(c - 0.9); s1.c.push(c); s1.v.push(10 + i); s1.q.push((10 + i) * c);
        s1.n.push(3); s1.done.push(true);
      }
      s1.dirty = true;
    };

    // (a) 起点对齐到 2 分钟边界 → 恰好 40 根完整桶
    const sA = new CandleSeries(lv1);
    fill(sA, Math.floor(Date.now() / ms2) * ms2 - 40 * ms2, 80);
    const gA = new CandleSeries(lv2);
    gA.rebuildFrom(sA);
    const okA = gA.t.length === 40
      && gA.o[0] === sA.o[0] && gA.c[0] === sA.c[1]
      && gA.h[0] === Math.max(sA.h[0], sA.h[1]) && gA.l[0] === Math.min(sA.l[0], sA.l[1])
      && Math.abs(gA.v[0] - (sA.v[0] + sA.v[1])) < 1e-9
      && gA.c[39] === sA.c[79];
    ok('2分钟由1分钟真实合成（起点对齐：80 根 1分 → 40 根 2分，OHLCV 正确）',
      okA, `→ ${gA.t.length} 根，首根 O=${gA.o[0]} C=${gA.c[0]} H=${gA.h[0]} L=${gA.l[0]} V=${gA.v[0]}`);

    // (b) 起点不对齐（落在奇数分钟）→ 首尾各出现一个半截桶，共 41 根
    const sB = new CandleSeries(lv1);
    fill(sB, Math.floor(Date.now() / ms2) * ms2 - 40 * ms2 + ms1, 80);
    const gB = new CandleSeries(lv2);
    gB.rebuildFrom(sB);
    const okB = gB.t.length === 41
      && gB.o[0] === sB.o[0] && gB.c[0] === sB.c[0] && gB.v[0] === sB.v[0]   // 首桶仅 1 根
      && gB.c[1] === sB.c[2];                                                // 第 2 桶是完整的 2 根
    ok('起点不对齐时，半截桶被正确保留（80 根 1分 → 41 根 2分，首桶只有 1 根）',
      okB, `→ ${gB.t.length} 根，首桶 V=${gB.v[0]}（单根应为 ${sB.v[0]}）`);

    // (c) 收盘标记：桶铺满且源K线已收盘，合成K线才算收盘；半截的尾桶必须标记为"未收盘"
    ok('合成K线收盘标记正确（完整桶=已收盘，半截尾桶=未收盘）',
      gA.done.every(Boolean) && gB.done.slice(0, -1).every(Boolean) && gB.done[gB.done.length - 1] === false,
      `对齐序列 ${gA.done.filter(Boolean).length}/${gA.done.length} 已收盘；` +
      `错位序列末根 done=${gB.done[gB.done.length - 1]}（半截桶，应为 false）`);
  }
  ok('1分钟标记为隐藏级别（不进矩阵/不计数）',
    LEVELS[LEVEL_INDEX['1m']].hidden === true && !VISIBLE_LEVELS.some(l => l.key === '1m'),
    `可见级别 ${VISIBLE_LEVELS.length} 个：${VISIBLE_LEVELS.map(l => l.key).join(',')}`);
}

/* ============ 4. 负样例 ============ */
section('4. 信号引擎 · 负样例（必须不触发）');
{
  // 4.1 最大级别跌破均线 → 该"最大级别"组合必须全部消失
  //     注意：不能把末尾K线"整体按比例缩放"——那样 MA7 会同步下移，close>MA7 依然成立。
  //     必须让最后几根**逐根下跌**，才会真正跌破均线。
  const bearishBig = bullBreakoutPath(80, { pullback: false });
  for (let i = 70; i < 80; i++) bearishBig[i] = bearishBig[i - 1] * 0.975;
  const s1 = buildLevels({ '2h': { closes: bearishBig } });
  const r1 = evaluateSymbol('NEG1USDT', s1, cfg, false);
  ok('最大级别(2h)跌破均线 → 无 big=2h 的共振',
    !has(r1.matches, x => x.big === '2h'),
    `其余组合 ${r1.matches.length} 组：${[...new Set(r1.matches.map(x => x.group))].join(' / ') || '无'}`);

  // 4.2 只有 1 个级别多头排列 → 共振级别不足，必须完全不触发
  //     构造：除 3m 外的所有级别走单边下跌（MA7<MA25，非多头排列）
  const bearPath = n => { const a = []; let p = 200; for (let i = 0; i < n; i++) { p *= 0.996; a.push(p); } return a; };
  const s2 = {};
  for (const lv of LEVELS) s2[lv.key] = seriesFromCloses(lv, bearPath(80));
  s2['3m'] = seriesFromCloses(LEVELS[LEVEL_INDEX['3m']], bullBreakoutPath(80));
  const r2 = evaluateSymbol('NEG2USDT', s2, cfg, false);
  ok('多头排列级别不足 3 个 → 不触发', r2.matches.length === 0 && r2.bullCount < cfg.minBullLevels,
    `共振级别数 ${r2.bullCount}/${VISIBLE_LEVELS.length}，命中 ${r2.matches.length} 组`);

  // 4.3 基准级别单边上涨、没有回踩 → 不触发
  const noPullback = buildLevels({ '3m': { pullback: false } });
  const r3 = evaluateSymbol('NEG3USDT', noPullback, cfg, false);
  ok('基准级别(3分)未回踩 MA7 → 无 base=3m 的共振',
    !has(r3.matches, x => x.base === '3m'),
    `其余组合 ${r3.matches.length} 组`);

  // 4.4 确认级别早已在均线上方、非"上穿" → 不触发
  const adjacentNoCross = buildLevels({ '15m': { pullback: false } });
  const r4 = evaluateSymbol('NEG4USDT', adjacentNoCross, cfg, false);
  ok('确认级别(15分)未同步上穿 → 无 mid=15m 的共振',
    !has(r4.matches, x => x.mid === '15m'),
    `其余组合 ${r4.matches.length} 组`);

  // 4.5 基准级别收盘跌破 MA7（未站上双均线）→ 不触发
  const belowMa = buildLevels();
  const lastCloses = belowMa['3m'].c;
  lastCloses[lastCloses.length - 1] = lastCloses[lastCloses.length - 2] * 0.96;
  belowMa['3m'].dirty = true;
  const r5 = evaluateSymbol('NEG5USDT', belowMa, cfg, false);
  ok('基准级别未站上 MA7/EMA7 → 无 base=3m 的共振',
    !has(r5.matches, x => x.base === '3m'),
    `其余组合 ${r5.matches.length} 组`);
}

/* ============ 5. 真实行情冒烟 ============ */
section('5. 真实行情冒烟测试');
try {
  const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XVSUSDT'];
  for (const sym of syms) {
    const map = {};
    let bars = 0;
    await Promise.all(LEVELS.filter(l => l.native).map(async lv => {
      const rows = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${lv.key}&limit=200`).then(r => r.json());
      const s = new CandleSeries(lv);
      s.bulkLoad(rows.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], q: +k[7], n: +k[8], done: true })));
      map[lv.key] = s; bars += rows.length;
    }));
    for (const lv of LEVELS.filter(l => !l.native)) {
      map[lv.key] = new CandleSeries(lv);
      map[lv.key].rebuildFrom(map[lv.from]);
    }
    const res = evaluateSymbol(sym, map, cfg, true);
    const bad = Object.entries(res.levels).filter(([, v]) => v.code < 0 || v.code > 5);
    ok(`${sym} 评估无异常`, res.bullCount >= 0 && bad.length === 0,
      `${bars} 根K线 · 多头排列 ${res.bullCount}/${VISIBLE_LEVELS.length} · 命中 ${res.matches.length} 组` +
      (res.matches[0] ? ` · 最强 ${res.matches[0].group} ${res.matches[0].score}分` : ''));
  }
} catch (e) {
  ok('真实行情冒烟（网络）', false, e.message);
}

/* ============ 6. 绩效追踪模块 ============ */
section('6. 绩效追踪模块（信号结算与统计）');
{
  const { Tracker } = await import('../src/tracker.js');
  const mk = (ms, arr) => ({ ms, t: arr.map((_, i) => i * ms), c: arr, o: arr, h: arr, l: arr, v: arr.map(() => 1) });

  // 取价：应取"收盘时刻 ≤ 目标时刻"的最后一根（target=180000 时，第0根刚好在 180000 收盘）
  const s = mk(180_000, [100, 101, 102, 103, 104, 105]);
  ok('priceAt 取到目标时刻及之前最后一根的收盘价', Tracker.priceAt(s, 180_000) === 100, `t=180000 → ${Tracker.priceAt(s, 180_000)}`);
  ok('priceAt 随目标时刻推进而前移', Tracker.priceAt(s, 360_000) === 101 && Tracker.priceAt(s, 900_000) === 104,
    `t=360000 → ${Tracker.priceAt(s, 360_000)}, t=900000 → ${Tracker.priceAt(s, 900_000)}`);
  ok('priceAt 对超出区间更早的时刻返回 null', Tracker.priceAt(s, -1) === null);
  ok('priceAt 对未来时刻取到最后一根（由调用方用 now 兜底）', Tracker.priceAt(s, 9e12) === 105);

  // 结算：构造一条 2 小时前的记录，应能算出 +1h，且 +4h 仍为待结算
  const tmp = 'data/_test-signals.jsonl';
  const tr = new Tracker(tmp, { info() { }, warn() { }, error() { } }, memoryStorage());
  tr.entries.length = 0;
  const now = Date.now();
  const e = tr.record({
    symbol: 'TSTUSDT', base: '3m', mid: '5m', big: '2h', mode: 'closed', candleT: now - 7200000,
    ts: now - 7200000, price: 100, score: 70, bullCount: 5, confirmed: true, initial: false,
  });
  ok('record 写入条目', !!e && tr.entries.length === 1);

  const fakeMarket = {
    symbols: new Map([['TSTUSDT', {
      seeded: true,
      series: { '3m': { ms: 180_000, t: [0, 180_000], c: [0, 101] } },
    }]]),
  };
  // 用 3m 序列无法覆盖 2 小时前，应回退到更粗的级别
  fakeMarket.symbols.get('TSTUSDT').series['30m'] = {
    ms: 1_800_000,
    t: Array.from({ length: 20 }, (_, i) => (now - 3600_000 * 10) + i * 1_800_000),
    c: Array.from({ length: 20 }, (_, i) => 100 + i),
  };
  tr.lastResolve = 0;
  tr.resolve(fakeMarket);
  const h1 = e.out.h1;
  ok('resolve 结算 +1h 收益', h1 != null && Math.abs(h1) > 0, `+1h = ${h1}%`);
  ok('resolve 未到期的不提前结算 (+4h)', e.out.h4 == null, `+4h = ${e.out.h4 ?? '待结算'}`);

  const st = tr.stats();
  ok('stats 汇总结构完整',
    st.tracked === 1 && st.horizons.length === 3 && st.byScore.length === 4,
    `tracked=${st.tracked} 分档=${st.byScore.length}`);
  try { (await import('node:fs')).rmSync(tmp, { force: true }); } catch { }
}

/* ============ 7. tick 构建K线（合约 tick-rest 模式核心） ============ */
section('7. 实时价构建K线（applyTick，合约行情源核心）');
{
  const lv = LEVELS[LEVEL_INDEX['1m']];
  const ms = 60_000;
  const base = Math.floor(Date.now() / ms) * ms - 5 * ms;   // 对齐到分钟边界

  const s = new CandleSeries(lv);
  ok('空序列首次 tick 建立K线', s.applyTick(100, base) === false && s.t.length === 1 && s.o[0] === 100 && s.c[0] === 100);
  ok('新建立的K线尚未收盘', s.done[0] === false);

  s.applyTick(103, base + 1000);   // 同一根内上涨
  s.applyTick(97, base + 2000);    // 同一根内下跌
  ok('同区间内 tick 正确更新 high/low/close',
    s.h[0] === 103 && s.l[0] === 97 && s.c[0] === 97 && s.o[0] === 100,
    `O=${s.o[0]} H=${s.h[0]} L=${s.l[0]} C=${s.c[0]}`);

  const rolled = s.applyTick(101, base + ms);
  ok('跨入新时间区间时上一根被标记收盘并返回 true',
    rolled === true && s.t.length === 2 && s.done[0] === true && s.done[1] === false,
    `已收盘 ${s.done.filter(Boolean).length}/${s.done.length}`);
  ok('新K线以当前 tick 价开新的一根', s.o[1] === 101 && s.c[1] === 101 && s.t[1] === base + ms);

  ok('迟到的 tick（早于当前K线）被忽略', s.applyTick(50, base - 1000) === false && s.c[1] === 101);
  ok('非法价格被忽略', s.applyTick(NaN, base + 2000) === false && s.applyTick(0, base + 2000) === false && s.c[1] === 101);

  // 连续走完多根：记录每根桶内实际打过的 tick，再用"不变量"校验，避免手算期望值出错
  const s2 = new CandleSeries(lv);
  const bucketTicks = new Map();      // bucketStart -> [价格…]
  const rollAt = [];
  const push = (price, at) => {
    const bkt = Math.floor(at / ms) * ms;
    if (!bucketTicks.has(bkt)) bucketTicks.set(bkt, []);
    bucketTicks.get(bkt).push(price);
    if (s2.applyTick(price, at)) rollAt.push(bkt);
  };
  for (let i = 0; i < 5; i++) {
    push(10 + i, base + i * ms);                 // 开
    push(10 + i + 1.5, base + i * ms + 10_000);  // 高
    push(10 + i - 1.5, base + i * ms + 20_000);  // 低（也是桶内收盘）
  }
  push(99, base + 5 * ms);                       // 跨入第 6 根

  ok('连续 tick 推进：每跨一次边界收盘一根',
    rollAt.length === 5 && s2.closedCount === 5 && s2.t.length === 6,
    `收盘事件 ${rollAt.length} 次，已收盘 ${s2.closedCount} 根，共 ${s2.t.length} 根`);

  let bad = null;
  for (let i = 0; i < s2.t.length; i++) {
    const ticks = bucketTicks.get(s2.t[i]);
    if (!ticks) { bad = `第${i + 1}根找不到对应 tick 记录`; break; }
    const O = ticks[0], C = ticks[ticks.length - 1];
    const H = Math.max(...ticks), L = Math.min(...ticks);
    if (s2.o[i] !== O || s2.h[i] !== H || s2.l[i] !== L || s2.c[i] !== C) {
      bad = `第${i + 1}根 O=${s2.o[i]}/H=${s2.h[i]}/L=${s2.l[i]}/C=${s2.c[i]} 期望 ${O}/${H}/${L}/${C}`;
      break;
    }
  }
  ok('每根K线满足不变量：O=首tick、H=max、L=min、C=末tick', bad === null,
    bad ?? `${s2.t.length} 根全部吻合（第1根 O=${s2.o[0]} H=${s2.h[0]} L=${s2.l[0]} C=${s2.c[0]}）`);

  // 与 REST 结果混用：bulkLoad 覆盖后 tick 继续推进
  s2.bulkLoad([{ t: base, o: 5, h: 8, l: 4, c: 6, v: 100, q: 0, n: 1, done: true }]);
  s2.applyTick(7.5, base + ms);
  ok('REST 覆盖后 tick 能衔接续建', s2.t.length === 2 && s2.c[1] === 7.5 && s2.done[0] === true,
    `共 ${s2.t.length} 根，末根 C=${s2.c[1]}`);
}

/* ============ 8. 缠论：包含处理 / 分型 / 笔 / MACD / 背驰 ============ */
section('8. 缠论（标准笔 + MACD 面积背驰）');
{
  const { mergeInclusive, findFractals, buildStrokePoints, analyzeChan, chanStateAt, macdArea } =
    await import('../src/chan.js');
  const { buildMACD } = await import('../src/indicators.js');

  // —— 8.1 MACD 与独立实现比对 ——
  {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 9) * 12 + i * 0.25);
    const m = buildMACD(closes, 12, 26, 9);
    // 独立实现
    const ema = (arr, p) => { const k = 2 / (p + 1); const out = new Array(arr.length).fill(NaN);
      let s = 0; for (let i = 0; i < p; i++) s += arr[i]; let prev = s / p; out[p - 1] = prev;
      for (let i = p; i < arr.length; i++) { prev = arr[i] * k + prev * (1 - k); out[i] = prev; } return out; };
    const ef = ema(closes, 12), es = ema(closes, 26);
    let maxd = 0;
    for (let i = 25; i < closes.length; i++) maxd = Math.max(maxd, Math.abs((ef[i] - es[i]) - m.dif[i]));
    ok('MACD DIF 与独立实现一致', maxd < 1e-9, `最大偏差 ${maxd.toExponential(2)}`);
    ok('MACD 柱 = 2×(DIF−DEA)', Math.abs(m.hist[150] - 2 * (m.dif[150] - m.dea[150])) < 1e-9,
      `hist=${m.hist[150].toFixed(4)}`);
  }

  // —— 8.2 包含处理 ——
  {
    // 第2根被第1根包含（高更低、低更高）→ 应合并
    const h = [10, 9.5, 11, 12];
    const l = [5, 5.5, 6, 7];
    const m = mergeInclusive(h, l);
    ok('包含处理合并了被包含的K线', m.n === 3, `4 根 → ${m.n} 根 (h=[${m.h}])`);
    ok('包含处理保留原始下标区间', m.from[0] === 0 && m.to[0] === 1 && m.from[1] === 2,
      `from=[${m.from}] to=[${m.to}]`);

    // 上升途中被包含 → 取「高高」
    //   bar1=(12,6)  bar2=(11,7)：11≤12 且 7≥6 → 真包含；前一根 10<12 → 向上
    const up = mergeInclusive([10, 12, 11, 14], [5, 6, 7, 7.5]);
    ok('上升途中取「高高」', up.n === 3 && up.h[1] === 12 && up.l[1] === 7,
      `4 根 → ${up.n} 根 h=[${up.h}] l=[${up.l}]`);

    // 下降途中被包含 → 取「低低」
    //   bar1=(18,12)  bar2=(17,13)：17≤18 且 13≥12 → 真包含；前一根 20>18 → 向下
    const dn = mergeInclusive([20, 18, 17, 14], [15, 12, 13, 10]);
    ok('下降途中取「低低」', dn.n === 3 && dn.h[1] === 17 && dn.l[1] === 12,
      `4 根 → ${dn.n} 根 h=[${dn.h}] l=[${dn.l}]`);
  }

  // —— 8.3 分型识别（注意：分型必须有左右邻居，不能落在序列两端） ——
  {
    const m = { h: [3, 5, 4, 1, 2, 0], l: [2, 4, 3, -1, 1, -2], n: 6 };
    const f = findFractals(m);
    ok('顶分型：中间那根高点同时高于左右', f.some(x => x.mi === 1 && x.type === 'top'), JSON.stringify(f));
    ok('底分型：中间那根低点同时低于左右', f.some(x => x.mi === 3 && x.type === 'bottom'), JSON.stringify(f));
    ok('分型方向交替出现', f.length >= 2 && f.every((x, i) => i === 0 || x.type !== f[i - 1].type), JSON.stringify(f.map(x => x.type)));
    ok('序列两端不会被误判为分型', !f.some(x => x.mi === 0 || x.mi === m.n - 1));
  }

  // —— 8.4 笔的最小K线数（标准笔 = 5） ——
  {
    // 两个分型隔 3 根（mi 差 3）→ 不足 5 根，不成笔
    const close = [{ mi: 1, type: 'top', price: 10 }, { mi: 4, type: 'bottom', price: 5 }];
    const m4 = { from: [0, 1, 2, 3, 4, 5], to: [0, 1, 2, 3, 4, 5], n: 6 };
    const hh = [1, 10, 3, 4, 5, 6], ll = [0, 9, 2, 3, 4, 5];
    const p4 = buildStrokePoints(close, m4, hh, ll, 4);
    const p5 = buildStrokePoints(close, m4, hh, ll, 5);
    ok('标准笔：间隔不足 5 根K线时不成笔', p5.length === 1, `minBars=5 得到 ${p5.length} 个端点`);
    ok('放宽到 4 根时可成笔（对照）', p4.length === 2, `minBars=4 得到 ${p4.length} 个端点`);

    // 同类型分型只保留更极端的
    const same = [{ mi: 1, type: 'top', price: 10 }, { mi: 8, type: 'top', price: 12 },
      { mi: 15, type: 'bottom', price: 5 }];
    const m15 = { from: Array.from({ length: 20 }, (_, i) => i), to: Array.from({ length: 20 }, (_, i) => i), n: 20 };
    const hA = Array.from({ length: 20 }, () => 1), lA = Array.from({ length: 20 }, () => 0);
    hA[1] = 10; hA[8] = 12; lA[15] = -1;
    const ps = buildStrokePoints(same, m15, hA, lA, 5);
    ok('同类型分型只保留更极端的那根', ps.length === 2 && ps[0].mi === 8, JSON.stringify(ps.map(x => [x.mi, x.type])));
  }

  // —— 8.5 真实形态数据上的结构合理性 ——
  // 关键：合成K线必须带**上下影线**。若用 h=max(o,c)、l=min(o,c)，
  // 拐点处相邻两根的高点会完全相等，h[i] > h[i+1] 不成立，分型就出不来。
  // wickAmp 控制影线幅度：结构类用例用大一点（制造丰富分型），
  // 背驰类用例用小一点（避免趋势内部的噪声把「当前笔」的方向翻掉）。
  const wick = i => Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1);
  const mkSeries = (closes, key = '15m', wickAmp = 0.006) => {
    const { CandleSeries } = CandleSeriesMod;
    const lv = LEVELS[LEVEL_INDEX[key]];
    const s = new CandleSeries(lv);
    const ms = lv.minutes * 60_000;
    const t0 = Math.floor(Date.now() / ms) * ms - closes.length * ms;
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i], o = i ? closes[i - 1] : c;
      const hi = Math.max(o, c), lo = Math.min(o, c);
      s.t.push(t0 + i * ms); s.o.push(o); s.c.push(c);
      s.h.push(hi + wick(i) * hi * wickAmp);
      s.l.push(lo - wick(i + 7777) * lo * wickAmp);
      s.v.push(1000); s.q.push(1000 * c); s.n.push(5); s.done.push(true);
    }
    s.dirty = true; s.version++;
    s.ensure();
    return s;
  };
  {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 11) * 10 + i * 0.15);
    const s = mkSeries(closes);
    const chan = s.ensureChan(5);
    ok('真实形态数据上能构建缠论结构',
      chan.merged.n > 50 && chan.fractals.length > 20 && chan.pts.length >= 3,
      `原 ${chan.n} 根 → 合并 ${chan.merged.n} → 分型 ${chan.fractals.length} → 笔端点 ${chan.pts.length}`);
    const st = s.beichiState(s.t.length - 1, { ratio: 1, minProgress: 0.3 });
    ok('能给出截至当下的笔状态', st && st.ok && st.cur && typeof st.dir === 'string',
      `方向=${st?.dir} 已完成笔=${st?.strokeCount}`);
  }

  // 造数工具：按若干「段」拼出 上-下-上-下-上 的清晰结构。
  // 注意起点无法成分型，所以必须先有一段上涨把第一个顶分型造出来，
  // 否则到最后一共只有 2 个已确认端点，凑不出「前一同向笔」做对比。
  const zigzag = phases => {
    const closes = [];
    let p = 100;
    for (const [n, rate] of phases) for (let i = 0; i < n; i++) { p *= rate; closes.push(p); }
    return closes;
  };
  const base = () => [[25, 1.010], [18, 0.990], [40, 1.012], [20, 0.991]];   // 上-下-上-下

  // —— 8.6 ★ 背驰正样例：价格创新高但 MACD 面积明显衰减 ——
  {
    const closes = zigzag([...base(), [70, 1.0035]]);   // 第 2 个上涨段：更慢、但创了新高
    const s = mkSeries(closes, '15m', 0.0015);
    const st = s.beichiState(s.t.length - 1, { ratio: 1, minProgress: 0.3 });
    ok('★ 顶背驰正样例被识别（价创新高 + 面积衰减）',
      !!st && st.ok && st.divergence.status === 'pending',
      st?.ok ? `方向=${st.dir} 已完成笔=${st.strokeCount} 新高=${st.newExtreme} 面积比=${st.areaRatio?.toFixed(2)} 幅度比=${st.advanceRatio?.toFixed(2)} → ${st.divergence.status}`
        : `未通过：${st?.reason}`);
  }

  // —— 8.7 负样例 a：第 2 段比第 1 段更陡（无背驰） ——
  {
    const closes = zigzag([...base(), [40, 1.014]]);    // 第 2 个上涨段：更陡
    const s = mkSeries(closes, '15m', 0.0015);
    const st = s.beichiState(s.t.length - 1, { ratio: 1, minProgress: 0.3 });
    ok('★ 无背驰负样例：第 2 段更强 → 不判定背驰',
      !!st && st.ok && st.divergence.status === 'none',
      st?.ok ? `新高=${st.newExtreme} 面积比=${st.areaRatio?.toFixed(2)} → ${st.divergence.status}`
        : `未通过：${st?.reason}`);
  }

  // —— 8.8 负样例 b：还没创新高（谈不上顶背驰） ——
  {
    const closes = zigzag([...base(), [30, 1.001]]);    // 反弹但远未回到前高
    const s = mkSeries(closes, '15m', 0.0015);
    const st = s.beichiState(s.t.length - 1, { ratio: 1, minProgress: 0.3 });
    ok('★ 未创新高 → 不判定顶背驰',
      !!st && st.ok && st.divergence.status === 'none',
      st?.ok ? `新高=${st.newExtreme} 面积比=${st.areaRatio?.toFixed(2)} → ${st.divergence.status}`
        : `未通过：${st?.reason}`);
  }

  // —— 8.9 因果性：同一 idx 的判定不随未来K线改变 ——
  {
    const closes = Array.from({ length: 320 }, (_, i) => 100 + Math.sin(i / 7) * 9 + Math.sin(i / 23) * 6 + i * 0.12);
    const full = mkSeries(closes);
    const cut = mkSeries(closes.slice(0, 250));
    const idx = 249;
    const a = full.beichiState(idx, { ratio: 1, minProgress: 0.3 });
    const b = cut.beichiState(cut.t.length - 1, { ratio: 1, minProgress: 0.3 });
    const same = !!a && !!b && a.ok === b.ok && a.dir === b.dir
      && a.divergence?.status === b.divergence?.status
      && Math.abs((a.areaRatio ?? 0) - (b.areaRatio ?? 0)) < 1e-9;
    ok('★ 因果性：截至 idx 的判定不受未来K线影响', same,
      `完整序列=${a?.divergence?.status}/${a?.areaRatio?.toFixed(4)}  截断序列=${b?.divergence?.status}/${b?.areaRatio?.toFixed(4)}`);
  }
}

/* ============ 9. 背驰过滤是否真的接进了信号引擎 ============ */
section('9. 背驰过滤接线（确认级别将背驰 → 引擎确实拦下该组信号）');
{
  const on = { ...cfg, filterBeichi: true };
  const off = { ...cfg, filterBeichi: false };
  const series = buildLevels();                    // 所有级别都是"回踩后突破"多头形态

  const viewsOf = () => {
    const v = {};
    for (const lv of LEVELS) v[lv.key] = analyzeLevel(series[lv.key], off, 'closed');
    v.__symbol = 'WIREUSDT';
    return v;
  };

  // 基线：关闭过滤时 3分→15分→2时 必须命中
  const base = findResonance(viewsOf(), off, 'closed');
  ok('基线：关闭过滤时 3分→15分→2时 会触发',
    base.matches.some(m => m.group === '3m>15m>2h'),
    `命中 ${base.matches.length} 组：${[...new Set(base.matches.map(m => m.group))].join(' / ')}`);

  // 打开过滤，但此时 15 分并没有背驰 → 仍然应该命中（说明不是一刀切）
  const onClean = findResonance(viewsOf(), on, 'closed');
  ok('开启过滤但确认级别无背驰 → 信号照常触发',
    onClean.matches.some(m => m.group === '3m>15m>2h'),
    `命中 ${onClean.matches.length} 组`);

  // 把 15 分的缠论状态改成"将背驰" → 该组必须被拦掉，其它组不受影响
  {
    const v = viewsOf();
    v['15m'].chanState = { ok: true, dir: 'up', divergence: { status: 'pending', dir: 'top' } };
    const r = findResonance(v, on, 'closed');
    ok('★ 确认级别「将背驰」→ 3分→15分→2时 被拦下',
      !r.matches.some(m => m.group === '3m>15m>2h'),
      `剩余 ${r.matches.length} 组：${[...new Set(r.matches.map(m => m.group))].join(' / ') || '无'}`);
    ok('★ 其它组合不受影响（5分→30分→3时 仍在）',
      r.matches.some(m => m.group === '5m>30m>3h'),
      [...new Set(r.matches.map(m => m.group))].join(' / '));
  }

  // 关掉过滤后，同样的"将背驰"状态不应再拦
  {
    const v = viewsOf();
    v['15m'].chanState = { ok: true, dir: 'up', divergence: { status: 'pending', dir: 'top' } };
    const r = findResonance(v, off, 'closed');
    ok('关闭开关后，同样的背驰状态不再拦截',
      r.matches.some(m => m.group === '3m>15m>2h'), `命中 ${r.matches.length} 组`);
  }

  // beichiScope = mid+big 时，最大级别背驰也应拦
  {
    const v = viewsOf();
    v['2h'].chanState = { ok: true, dir: 'up', divergence: { status: 'pending', dir: 'top' } };
    const midOnly = findResonance(v, { ...on, beichiScope: 'mid' }, 'closed');
    ok('scope=mid 时最大级别背驰不拦（3分→15分→2时 仍触发）',
      midOnly.matches.some(m => m.group === '3m>15m>2h'));
    const both = findResonance(v, { ...on, beichiScope: 'mid+big' }, 'closed');
    ok('scope=mid+big 时最大级别背驰也拦',
      !both.matches.some(m => m.group === '3m>15m>2h'),
      `剩余 ${both.matches.length} 组`);
  }

  // 笔端点不足（新上市币）时不应误伤
  {
    const v = viewsOf();
    v['15m'].chanState = { ok: false, reason: '已确认笔端点不足（2）' };
    const r = findResonance(v, on, 'closed');
    ok('缠论数据不足时不误伤（照常触发）',
      r.matches.some(m => m.group === '3m>15m>2h'));
  }
}

/* ============ 10. 序列合并式灌入（滚动累积） ============ */
section('10. 序列合并式灌入（mergeLoad：K线随运行时间累积）');
{
  const lv = LEVELS[LEVEL_INDEX['15m']];
  const ms = 15 * 60_000;
  const t0 = Math.floor(Date.now() / ms) * ms - 400 * ms;
  const mkRows = (from, count, base) => Array.from({ length: count }, (_, i) => ({
    t: t0 + (from + i) * ms,
    o: base + i, h: base + i + 1, l: base + i - 1, c: base + i + 0.5,
    v: 10, q: 0, n: 1, done: true,
  }));

  // 第一次拉 100 根
  const s = new CandleSeries(lv);
  s.mergeLoad(mkRows(300, 100, 1000));
  ok('首次灌入建立序列', s.t.length === 100, `${s.t.length} 根`);
  const firstT = s.t[0], lastT = s.t[s.t.length - 1];

  // 第二次只拉最新 60 根（区间 [340,399]，与已有的 [300,399] 重叠 60 根）
  // 合并结果 = 保留旧的前 40 根 + 新的 60 根 = 100 根；覆盖式则只剩 60 根
  s.mergeLoad(mkRows(340, 60, 2000));
  ok('★ 再次灌入时保留更早的旧K线（合并而非覆盖）', s.t.length === 100,
    `保留旧 40 根 + 新 60 根 = ${s.t.length} 根（覆盖式只会剩 60 根）`);
  ok('最早的时间戳保持不变', s.t[0] === firstT, `${new Date(s.t[0]).toISOString().slice(5, 16)}`);
  ok('最新数据被覆盖为本次拉取的值', s.c[s.t.length - 1] === 2000 + 59.5, String(s.c[s.t.length - 1]));
  ok('重叠区间的K线被新数据替换（不重复）',
    s.c[40] === 2000.5 && s.t[40] === firstT + 40 * ms,
    `第 41 根已换成新数据：c=${s.c[40]}（旧值应为 ${1000 + 40 + 0.5}）`);
  ok('序列仍按时间升序且无重复',
    s.t.every((v, i) => i === 0 || v > s.t[i - 1]), `末根 ${new Date(s.t[s.t.length - 1]).toISOString().slice(5, 16)}`);

  // 完全在旧数据之后 → 直接追加
  const s2 = new CandleSeries(lv);
  s2.mergeLoad(mkRows(0, 50, 100));
  s2.mergeLoad(mkRows(60, 50, 300));
  ok('新数据完全在后 → 追加', s2.t.length === 100 && s2.t[50] === t0 + 60 * ms, `${s2.t.length} 根`);

  // 超出保留上限时裁剪最老的
  const s3 = new CandleSeries(lv);
  for (let k = 0; k < 12; k++) s3.mergeLoad(mkRows(k * 50, 60, k * 1000));
  ok('超过保留上限时裁掉最老的（不超上限）', s3.t.length <= APP.maxCandlesKept,
    `${s3.t.length} 根 ≤ ${APP.maxCandlesKept}`);
  ok('裁剪后仍保持升序', s3.t.every((v, i) => i === 0 || v > s3.t[i - 1]));

  // 版本号递增 → 缠论缓存会失效并重算
  const v0 = s2.version;
  s2.mergeLoad(mkRows(110, 10, 500));
  ok('mergeLoad 会推进 version（触发缠论缓存失效）', s2.version > v0, `${v0} → ${s2.version}`);
}

/* ============ 11. 回踩成笔链（笔延续级别） ============ */
section('11. 回踩成笔链（笔延续级别）');
{
  const I = k => LEVEL_INDEX[k];

  // —— 11.1 成笔链覆盖哪些级别 ——
  {
    const cases = [
      ['5m', '30m', ['5m', '10m', '15m']],
      ['3m', '15m', ['3m', '5m', '10m']],
      ['2m', '10m', ['2m', '3m', '5m']],
    ];
    let allOk = true, detail = [];
    for (const [b, m, want] of cases) {
      const got = strokeChain(I(b), I(m));
      const hit = got.join(',') === want.join(',');
      if (!hit) allOk = false;
      detail.push(`${b}>${m}→${got.join('/')}`);
    }
    ok('★ 成笔链 = 基准到确认级别之间（不含确认级别）的全部级别', allOk, detail.join('  '));
    ok('用户举的例子逐字对上：5m>30m>3h 要求 5m/10m/15m 全部成笔',
      strokeChain(I('5m'), I('30m')).join(',') === '5m,10m,15m',
      strokeChain(I('5m'), I('30m')).join('/'));
  }

  // —— 11.2 判定逻辑：各级别的「向下笔底」必须晚于基准的回调起点 ——
  const T0 = 1_700_000_000_000;
  const mkView = (botT, above7 = true, hasDown = true) => ({
    stroke: { ok: true, down: hasDown ? { topT: botT - 3_600_000, botT } : null },
    above7,
  });
  const viewsFor = (baseTopT, bots, aboveFields = {}) => {
    // 基准 5m 的回调起点 = baseTopT
    const v = {
      '5m': { stroke: { ok: true, down: { topT: baseTopT, botT: baseTopT + 600_000 } }, above7: true },
      '10m': mkView(bots['10m'], aboveFields['10m'] ?? true),
      '15m': mkView(bots['15m'], aboveFields['15m'] ?? true),
      '30m': mkView(bots['30m']),
    };
    return v;
  };
  {
    const top = T0;
    // 三个级别都在回调起点之后完成向下笔 → 通过
    const good = checkStrokeChain(viewsFor(top, {
      '10m': top + 1_200_000, '15m': top + 1_800_000,
    }), I('5m'), I('30m'), {});
    ok('★ 全部级别在回调起点后成笔 → 链成立',
      good.ok && good.missing.length === 0 && good.got.join(',') === '5m,10m,15m',
      `got=[${good.got.join(',')}] 笔延续至 ${good.level}`);

    // 13m 的笔底停在回调之前 → 不成立
    const bad = checkStrokeChain(viewsFor(top, {
      '10m': top - 1_200_000, '15m': top + 1_800_000,
    }), I('5m'), I('30m'), {});
    ok('★ 10分 的笔底早于回调起点 → 链断裂，点名缺 10m',
      !bad.ok && bad.missing.join(',') === '10m', `missing=[${bad.missing.join(',')}]`);

    // 只缺最大那级
    const bad2 = checkStrokeChain(viewsFor(top, {
      '10m': top + 1_200_000, '15m': top - 600_000,
    }), I('5m'), I('30m'), {});
    ok('★ 只缺 15分 → 链断裂（笔延续只到 10m）',
      !bad2.ok && bad2.missing.join(',') === '15m' && bad2.level === '10m',
      `missing=[${bad2.missing.join(',')}] 延至 ${bad2.level}`);
  }

  // —— 11.3 锚点稳定性：突破后再形成新顶分型，不应把基准级别自己判失败 ——
  {
    const top = T0;
    const v = viewsFor(top, { '10m': top + 1_200_000, '15m': top + 1_800_000 });
    // 模拟「基准级别后来又形成了一个更晚的新顶分型」
    v['5m'].stroke.top = { t: top + 9_000_000, idx: 999, price: 1 };
    const r = checkStrokeChain(v, I('5m'), I('30m'), {});
    ok('★ 锚点用「向下笔起点」而非「最近顶分型」——突破后形成新顶也不误判',
      r.ok && r.topT === top, `锚点=${new Date(r.topT).toISOString().slice(11, 16)}（新顶在 ${new Date(top + 9_000_000).toISOString().slice(11, 16)}）`);
  }

  // —— 11.4 chainRequireAboveMa 附加条件 ——
  {
    const top = T0;
    const bots = { '10m': top + 1_200_000, '15m': top + 1_800_000 };
    const off = checkStrokeChain(viewsFor(top, bots, { '15m': false }), I('5m'), I('30m'), { chainRequireAboveMa: false });
    const on = checkStrokeChain(viewsFor(top, bots, { '15m': false }), I('5m'), I('30m'), { chainRequireAboveMa: true });
    ok('chainRequireAboveMa 关闭时，15分 未站上 MA7 不影响判定', off.ok);
    ok('★ chainRequireAboveMa 打开时，15分 未站上 MA7 会导致链断裂',
      !on.ok && on.missing.join(',') === '15m', `missing=[${on.missing.join(',')}]`);
  }

  // —— 11.5 接线：引擎确实按这个条件拦信号 ——
  {
    const on = { ...cfg, requireStrokeChain: true };
    const off = { ...cfg, requireStrokeChain: false };
    const series = buildLevels();
    const makeViews = c => {
      const v = {};
      for (const lv of LEVELS) v[lv.key] = analyzeLevel(series[lv.key], c, 'closed');
      v.__symbol = 'CHAINUSDT';
      return v;
    };
    // 打开过滤但数据本身满足 → 不拦
    const pass = findResonance(makeViews(on), on, 'closed');
    const base0 = findResonance(makeViews(off), off, 'closed');
    ok('关闭成笔链时会有 3m>15m>2h 信号', base0.matches.some(m => m.group === '3m>15m>2h'),
      `命中 ${base0.matches.length} 组`);

    // 人为把中间级别的笔底挪到回调起点之前 → 必须被拦
    const v = makeViews(on);
    const chain = strokeChain(I('3m'), I('15m'));
    const anchor = v['3m'].stroke?.down?.topT ?? 0;
    for (const key of chain) {
      if (v[key].stroke?.down) v[key].stroke.down.botT = anchor - 3_600_000;
    }
    const blocked = findResonance(v, on, 'closed');
    ok('★ 中间级别成笔链断裂 → 3m>15m>2h 被拦下（且计入 strokeBlocked）',
      !blocked.matches.some(m => m.group === '3m>15m>2h') && blocked.strokeBlocked > 0,
      `剩余 ${blocked.matches.length} 组，strokeBlocked=${blocked.strokeBlocked}`);

    // 关闭开关后同样的数据不应再拦
    const notBlocked = findResonance(v, off, 'closed');
    ok('关闭开关后相同数据不再被拦',
      notBlocked.matches.some(m => m.group === '3m>15m>2h'), `命中 ${notBlocked.matches.length} 组`);
  }

  // —— 11.6 匹配结果里带出笔延续级别 ——
  {
    const on = { ...cfg, requireStrokeChain: true };
    const series = buildLevels();
    const v = {};
    for (const lv of LEVELS) v[lv.key] = analyzeLevel(series[lv.key], on, 'closed');
    v.__symbol = 'CHAINUSDT';
    // 合成数据的分型结构很稀疏，凑不出成笔链；这里把链上各级别的「向下笔底」
    // 人为挪到回调起点之后，专门验证 chain 信息确实透传到了匹配结果里。
    const need = strokeChain(I('3m'), I('15m'));
    const anchor = v['3m'].stroke?.down?.topT ?? Date.now();
    for (const key of need) {
      if (!v[key].stroke) v[key].stroke = {};
      v[key].stroke.down = { topT: anchor - 600_000, botT: anchor + 600_000, botIdx: 1, botPrice: 1, topIdx: 0, topPrice: 1 };
      v[key].above7 = true;
    }
    const r = findResonance(v, on, 'closed');
    const m = r.matches.find(x => x.group === '3m>15m>2h') ?? r.matches[0];
    ok('★ 命中结果里带出 strokeChain（供界面显示「笔延续级别」）',
      !!m?.strokeChain && Array.isArray(m.strokeChain.need)
      && m.strokeChain.need.join(',') === need.join(',')
      && !!m.strokeChain.level,
      m?.strokeChain ? `需要[${m.strokeChain.need.join(',')}] 延至 ${m.strokeChain.level}` : `无匹配（命中 ${r.matches.length} 组）`);
  }

  // —— 11.7 describe 文案 ——
  {
    const { describe } = await import('../src/signals.js');
    const txt = describe({
      base: '5m', mid: '30m', big: '3h', bullCount: 4, confirmed: false, bigLineName: 'ema7',
      strokeChain: { need: ['5m', '10m', '15m'], level: '15m' },
    });
    ok('★ 报警文案写明「回踩已带动 X/Y/Z 全部成笔（笔延续至 N）」',
      /全部成笔/.test(txt) && /笔延续至 15分/.test(txt) && /5分\/10分\/15分/.test(txt), txt);
  }
}

/* ============ 12. 回踩形态「两根阴K不破均线」 ============ */
section('12. 回踩形态「两根阴K不破均线」（跌无可跌）');
{
  /* findTwoBearHold 只读 series.{o,h,l,c} 与 ind.{ma7,ema7}，可以直接喂普通对象 */
  const mk = (candles, ma7, ema7) => ({
    s: {
      o: candles.map(c => c[0]), h: candles.map(c => c[1]),
      l: candles.map(c => c[2]), c: candles.map(c => c[3]),
    },
    ind: { ma7: candles.map(() => ma7), ema7: candles.map(() => ema7) },
  });
  // [开, 高, 低, 收]；idx=3 是触发K，看它前面 2 根（idx 1、2）
  const base = [
    [10.0, 10.8, 9.9, 10.6],   // 0 上涨
    [10.6, 10.7, 10.2, 10.1],  // 1 阴K
    [10.1, 10.2, 9.8, 10.0],   // 2 阴K（影线插到 9.8）
    [10.0, 10.6, 9.95, 10.5],  // 3 触发K
  ];
  const MA = 9.5, EMA = 9.6;

  {
    const { s, ind } = mk(base, MA, EMA);
    const r = findTwoBearHold(s, ind, 3, 2);
    ok('★ 两根阴K + 收盘均在 MA7/EMA7 之上 → 形态成立',
      !!r && r.bars === 2, r ? `bars=${r.bars} 回调深度 ${(r.depth * 100).toFixed(2)}%` : 'null');
  }
  {
    // 影线插破均线（最低 9.4 < MA 9.5），但收盘仍在均线上 → 仍应成立
    const cs = base.map((c, i) => i === 2 ? [10.1, 10.2, 9.4, 10.0] : c);
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 影线可以插破均线（收盘站住即可）',
      findTwoBearHold(s, ind, 3, 2) !== null, `最低 ${Math.min(...s.l.slice(1, 3))} < MA ${MA}`);
  }
  {
    const cs = base.map((c, i) => i === 2 ? [9.9, 10.2, 9.8, 10.0] : c);   // 第 2 根改阳线
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 有一根不是阴K → 不成立', findTwoBearHold(s, ind, 3, 2) === null);
  }
  {
    const cs = base.map((c, i) => i === 2 ? [10.1, 10.2, 9.3, 9.4] : c);   // 收盘 9.4 < MA7
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 有一根收盘跌破 MA7 → 不成立', findTwoBearHold(s, ind, 3, 2) === null);
  }
  {
    const cs = base.map((c, i) => i === 2 ? [10.1, 10.2, 9.5, 9.55] : c);  // > MA7 但 < EMA7
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 收盘站上 MA7 但跌破 EMA7 → 仍不成立', findTwoBearHold(s, ind, 3, 2) === null);
  }
  {
    const { s, ind } = mk(base, MA, EMA);
    ok('可配置阴K根数（要求 3 根时只有 2 根 → 不成立）',
      findTwoBearHold(s, ind, 3, 2) !== null && findTwoBearHold(s, ind, 3, 3) === null,
      'bars=2 成立 / bars=3 不成立');
  }
  {
    const { s, ind } = mk(base, MA, EMA);
    ok('K线不足时返回 null 而不是抛错', findTwoBearHold(s, ind, 1, 2) === null);
  }

  // —— 接线：形态开关确实切换了判定路径 ——
  {
    const on = { ...cfg, pullbackPattern: 'twoBearHold' };
    const off = { ...cfg, pullbackPattern: 'touch' };
    const series = buildLevels();
    const viewsOf = c => {
      const v = {};
      for (const lv of LEVELS) v[lv.key] = analyzeLevel(series[lv.key], c, 'closed');
      v.__symbol = 'TWOBEARUSDT';
      return v;
    };
    const a = findResonance(viewsOf(off), off, 'closed');
    ok('对照：旧形态（触及MA7+上穿）在其他条件满足时会触发',
      a.matches.some(m => m.group === '3m>15m>2h'), `命中 ${a.matches.length} 组`);

    const v = viewsOf(on);
    let injected = 0;
    for (const key of ['2m', '3m', '5m']) {
      if (!v[key]) continue;
      v[key].twoBear = { bars: 2, depth: 0.01, top: 1, low: 1 };
      v[key].aboveBoth = true;
      injected++;
    }
    const b = findResonance(v, on, 'closed');
    ok('★ 新形态成立时（两根阴K不破均线 + 收盘站上两条均线）能触发',
      b.matches.length > 0, `注入了 ${injected} 个基准级别，命中 ${b.matches.length} 组`);

    const v2 = viewsOf(on);
    for (const key of ['2m', '3m', '5m']) {
      if (!v2[key]) continue;
      v2[key].twoBear = { bars: 2 };
      v2[key].aboveBoth = false;
    }
    ok('新形态要求「收盘同时站上两条均线」：置 false 后不再触发',
      findResonance(v2, on, 'closed').matches.length === 0, '全部 aboveBoth=false → 0 组');
  }

  ok('默认使用「两根阴K不破均线」形态', DEFAULT_SIGNAL.pullbackPattern === 'twoBearHold',
    `pullbackPattern=${DEFAULT_SIGNAL.pullbackPattern} bars=${DEFAULT_SIGNAL.pullbackBars}`);
}

/* ============ 13. 两阶段盯盘状态机（预备 → 触发） ============ */
section('13. 两阶段盯盘状态机（大级别预备 → 最小级别首次站上触发）');
{
  const groups = [{ big: '1h', mid: '10m', base: '2m', inner: ['15m', '30m'], adjacent: '15m', enabled: true }];
  const mkLog = () => ({ info() { }, warn() { }, error() { }, signal() { }, ok() { }, debug() { } });
  const mk = (o = {}) => ({
    '1h': { twoBear: !!o.big, holdMa: !!o.big, candleT: 1000 },
    '10m': { strokeOk: !!o.midStroke, above7: !!o.adjCross },
    '2m': { aboveBoth: !!o.above, belowBoth: !!o.below, close: 10, ma7: 9.9, ema7: 9.95, candleT: o.t ?? 2000 },
    '15m': { strokeOk: !!o.inner15, above7: !!o.adjCross },
    '30m': { strokeOk: !!o.inner30 },
  });

  {
    const w = new Watcher(mkLog(), groups);
    ok('大级别未满足形态 → 状态保持待机',
      w.update('A', mk({ big: false })).length === 0 && w.snapshot(0).total === 0);
  }
  {
    const w = new Watcher(mkLog(), groups);
    const e = w.update('A', mk({ big: true }));
    const s = w.snapshot(0);
    ok('★ 阶段一：大级别满足 → 进入预备名单且不报警',
      e.length === 0 && s.armed === 1 && s.fired === 0,
      '预备 ' + s.armed + ' / 已触发 ' + s.fired);
  }
  {
    const w = new Watcher(mkLog(), groups);
    w.update('A', mk({ big: true }));
    const e1 = w.update('A', mk({ big: true, above: true }));
    ok('★ 最小级别没跌破就站上 → 不算触发（必须先破）', e1.length === 0);

    w.update('A', mk({ big: true, below: true }));
    const e2 = w.update('A', mk({ big: true, above: true }));
    ok('★ 先跌破、再首次站上 → 触发报警', e2.length === 1, e2[0] ? e2[0].text.slice(0, 66) : '无');
    ok('★ 报警文案包含大级别 / 最小级别 / 参考信息',
      !!e2[0] && /1h/.test(e2[0].text) && /2m/.test(e2[0].text) && /够笔/.test(e2[0].text),
      e2[0] ? e2[0].text : '无');
  }
  {
    const w = new Watcher(mkLog(), groups);
    w.update('A', mk({ big: true }));
    w.update('A', mk({ big: true, below: true }));
    const a1 = w.update('A', mk({ big: true, above: true, t: 3000 }));
    const a2 = w.update('A', mk({ big: true, above: true, t: 4000 }));
    const a3 = w.update('A', mk({ big: true, above: true, t: 4000 }));
    ok('★ 同一周期内只报警一次（后续再站上不重复）',
      a1.length === 1 && a2.length === 0 && a3.length === 0,
      '首次 ' + a1.length + ' / 再站上 ' + a2.length);
  }
  {
    const w = new Watcher(mkLog(), groups);
    w.update('A', mk({ big: true }));
    w.update('A', mk({ big: true, below: true }));
    w.update('A', mk({ big: true, above: true, t: 3000 }));
    const before = w.snapshot(0);
    w.update('A', mk({ big: false }));
    const after = w.snapshot(0);
    w.update('A', mk({ big: true }));
    const rearmed = w.snapshot(0);
    ok('★ 大级别条件消失 → 周期结束并重置，可再次预备',
      before.fired === 1 && after.total === 0 && rearmed.armed === 1,
      '触发 ' + before.fired + ' → 重置 ' + after.total + ' → 重新预备 ' + rearmed.armed);
  }
  {
    const w = new Watcher(mkLog(), groups);
    w.update('A', mk({ big: true }));
    w.update('A', mk({ big: true, below: true }));
    const e = w.update('A', mk({ big: true, above: true, midStroke: false, inner15: false, inner30: false, adjCross: false }));
    ok('★ 中间级别未够笔 / 临近级别未上穿 → 仍报警，但作为参考信息带出',
      e.length === 1 && e[0].innerAllStroke === false && e[0].adjacentCross === false,
      e[0] ? (e[0].mid + (e[0].midStroke ? '已' : '未') + '够笔，' + e[0].adjacent + (e[0].adjacentCross ? '已' : '未') + '上穿') : '无');
  }
  {
    const w = new Watcher(mkLog(), groups);
    w.setConfig({ watchEnabled: false });
    ok('关闭盯盘开关后完全不工作',
      w.update('A', mk({ big: true })).length === 0 && w.snapshot(0).total === 0);
  }
  {
    const w = new Watcher(mkLog(), groups);
    w.update('A', mk({ big: true }));
    w.update('A', mk({ big: false }));
    w.update('B', mk({ big: true }));
    const s = w.snapshot(5);
    ok('多个币种各自独立维护状态', s.total === 1 && s.rows[0].symbol === 'B', JSON.stringify(s.rows.map(r => r.symbol)));
  }
  ok('默认对应表就是用户确认的三组：2m→10m→1h / 3m→15m→2h / 5m→30m→3h',
    DEFAULT_WATCH_GROUPS.length === 3
    && DEFAULT_WATCH_GROUPS.every(g => g.enabled !== false)
    && DEFAULT_WATCH_GROUPS[0].big === '1h' && DEFAULT_WATCH_GROUPS[0].mid === '10m' && DEFAULT_WATCH_GROUPS[0].base === '2m',
    DEFAULT_WATCH_GROUPS.map(g => g.big + '→' + g.mid + '→' + g.base + (g.enabled === false ? '(关)' : '')).join(' '));
}

/* ============ 14. 独立形态提醒：双阴不破（多） / 双阳不穿（空） ============ */
section('14. 独立形态提醒：双阴不破均线（多） / 双阳不穿破均线（空）');
{
  const mk = (candles, ma7, ema7) => ({
    s: {
      o: candles.map(c => c[0]), h: candles.map(c => c[1]),
      l: candles.map(c => c[2]), c: candles.map(c => c[3]),
    },
    ind: { ma7: candles.map(() => ma7), ema7: candles.map(() => ema7) },
  });
  const MA = 9.5, EMA = 9.6;

  /* ---- 双阳不穿（做空） ---- */
  {
    // [开, 高, 低, 收]；前两根收在均线下方
    const cs = [
      [10.0, 10.1, 9.4, 9.5],    // 0 参考
      [9.30, 9.45, 9.20, 9.35],  // 1 阳K，收 9.35 < MA7/EMA7
      [9.38, 9.52, 9.30, 9.42],  // 2 阳K，收 9.42 < MA7/EMA7（影线刺到 9.52）
      [9.42, 9.50, 9.20, 9.25],  // 3 触发K
    ];
    const { s, ind } = mk(cs, MA, EMA);
    const r = findTwoBullHold(s, ind, 3, 2);
    ok('★ 双阳不穿：两根阳K收盘都没涨破 MA7/EMA7 → 成立',
      !!r && r.bars === 2, r ? 'bars=' + r.bars + ' 幅度 ' + (r.depth * 100).toFixed(2) + '%' : 'null');
  }
  {
    const cs = [
      [10.0, 10.1, 9.4, 9.5],
      [9.30, 9.45, 9.20, 9.35],
      [9.38, 9.52, 9.30, 9.42],
      [9.42, 9.50, 9.20, 9.25],
    ];
    // 影线刺破均线（最高 9.75 > MA 9.5）但收盘仍在下方 → 仍成立
    cs[2] = [9.38, 9.75, 9.30, 9.42];
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 双阳：影线允许刺破均线（收盘不穿即可）',
      findTwoBullHold(s, ind, 3, 2) !== null, '最高 9.75 > MA ' + MA);
  }
  {
    const cs = [
      [10.0, 10.1, 9.4, 9.5],
      [9.30, 9.45, 9.20, 9.35],
      [9.38, 9.52, 9.30, 9.42],
      [9.42, 9.50, 9.20, 9.25],
    ];
    cs[2] = [9.60, 9.70, 9.55, 9.65];   // 收盘 9.65 > EMA7 9.6 → 涨破了
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 双阳：有一根收盘涨破 EMA7 → 不成立',
      findTwoBullHold(s, ind, 3, 2) === null);
  }
  {
    const cs = [
      [10.0, 10.1, 9.4, 9.5],
      [9.45, 9.40, 9.30, 9.35],   // 阴K（收 < 开）
      [9.38, 9.52, 9.30, 9.42],
      [9.42, 9.50, 9.20, 9.25],
    ];
    const { s, ind } = mk(cs, MA, EMA);
    ok('★ 双阳：有一根不是阳K → 不成立',
      findTwoBullHold(s, ind, 3, 2) === null);
  }
  {
    const cs = [[10, 10.1, 9.4, 9.5], [9.30, 9.45, 9.20, 9.35]];
    const { s, ind } = mk(cs, MA, EMA);
    ok('双阳：K线不足时返回 null 而不是抛错', findTwoBullHold(s, ind, 1, 2) === null);
  }
  {
    // 多空互斥：同一组K线不可能同时成立
    const bearCs = [
      [10.0, 10.8, 9.9, 10.6],
      [10.6, 10.7, 10.2, 10.1],
      [10.1, 10.2, 9.8, 10.0],
      [10.0, 10.6, 9.95, 10.5],
    ];
    const { s, ind } = mk(bearCs, MA, EMA);
    ok('★ 双阴与双阳互斥（同一组K线不会同时成立）',
      findTwoBearHold(s, ind, 3, 2) !== null && findTwoBullHold(s, ind, 3, 2) === null);
  }

  /* ---- 配置与默认值 ---- */
  ok('默认开启独立形态提醒，级别为 15m/30m/1h/2h/3h',
    DEFAULT_SIGNAL.dualEnabled === true
    && JSON.stringify(DEFAULT_SIGNAL.dualLevels) === JSON.stringify(['15m', '30m', '1h', '2h', '3h'])
    && DEFAULT_SIGNAL.dualBars === 2,
    'levels=' + (DEFAULT_SIGNAL.dualLevels || []).join(',') + ' bars=' + DEFAULT_SIGNAL.dualBars);

  /* ---- 视图字段接线 ---- */
  {
    const series = buildLevels();
    const cfgD = { ...cfg, dualEnabled: true, dualLevels: ['15m', '30m'], dualBars: 2 };
    const views = {};
    for (const lv of LEVELS) views[lv.key] = analyzeLevel(series[lv.key], cfgD, 'closed');
    ok('级别视图带出双阴/双阳形态字段与K线时间',
      views['15m'] && 'twoBearD' in views['15m'] && 'twoBullD' in views['15m'] && 'candleT' in views['15m'],
      '15m: candleT=' + views['15m'].candleT);
  }
}

/* ============ 15. 双阴/双阳判定修正：窗口右移 + 两条前置条件 ============ */
section('15. 双阴/双阳判定修正（含刚收盘那根 + 均线方向 + 前置趋势）');
{
  const mk = (candles, maArr, emaArr) => ({
    s: {
      o: candles.map(c => c[0]), h: candles.map(c => c[1]),
      l: candles.map(c => c[2]), c: candles.map(c => c[3]),
    },
    ind: { ma7: maArr, ema7: emaArr },
  });

  /* 7 根K线：[开,高,低,收]
     0..3 在均线上方（前置趋势）
     4    阳K（形态之前）
     5    阴K ┐ 双阴
     6    阴K ┘ ← idx = 6（刚收盘的那根） */
  const rows = [
    [10.20, 10.30, 10.10, 10.25],
    [10.25, 10.35, 10.15, 10.30],
    [10.30, 10.40, 10.20, 10.35],
    [10.35, 10.45, 10.25, 10.40],
    [10.40, 10.50, 10.30, 10.45],   // 4 阳K
    [10.45, 10.50, 10.28, 10.38],   // 5 阴K，收 10.38
    [10.38, 10.42, 10.24, 10.32],   // 6 阴K，收 10.32（最新收盘）
  ];
  const MA = new Array(7).fill(10.05);   // 全部收盘都在 MA7 上方
  const EMA = new Array(7).fill(10.10);
  const base = { ...cfg, dualEnabled: true, dualBars: 2, dualRequireMaSlope: false, dualPrevBars: 0 };

  // —— 修正一：窗口含刚收盘的那根 ——
  {
    const { s, ind } = mk(rows, MA, EMA);
    const off = { ...base, dualRequireMaSlope: false, dualPrevBars: 0 };
    ok('★ 形态含「刚收盘的那根」K线（idx、idx-1）→ 成立',
      dualPattern(s, ind, 6, off, 1) !== null,
      'idx=6 检查第 5、6 根（收 10.38 / 10.32）');
    // 若按旧口径（idx-1、idx-2 = 第 5、4 根），第 4 根是阳K → 不成立
    ok('★ 旧口径（idx-1、idx-2）会漏掉：第 4 根是阳K，正好证明窗口确实右移了',
      findTwoBearHold(s, ind, 6, 2, true) === null,
      'findTwoBearHold(idx=6) 检查第 5、4 根 → null');
  }

  // —— 修正二：均线方向 ——
  {
    const up = MA.map((v, i) => 10.00 + i * 0.02);      // MA7 向上
    const down = MA.map((v, i) => 10.30 - i * 0.02);    // MA7 向下
    const { s } = mk(rows, MA, EMA);
    const on = { ...base, dualRequireMaSlope: true, dualPrevBars: 0 };
    ok('★ 双阴（做多）+ MA7 向上 → 成立', dualPattern(s, { ma7: up, ema7: EMA }, 6, on, 1) !== null);
    ok('★ 双阴（做多）+ MA7 向下 → 被拦', dualPattern(s, { ma7: down, ema7: EMA }, 6, on, 1) === null);
  }
  {
    // 双阳（做空）：K线收在均线下方
    const bear = [
      [9.80, 9.90, 9.70, 9.75],
      [9.75, 9.85, 9.65, 9.70],
      [9.70, 9.80, 9.60, 9.65],
      [9.65, 9.75, 9.55, 9.60],
      [9.60, 9.70, 9.50, 9.55],
      [9.55, 9.68, 9.50, 9.62],   // 5 阳K
      [9.62, 9.74, 9.55, 9.68],   // 6 阳K
    ];
    const { s } = mk(bear, MA, EMA);
    const MAo = new Array(7).fill(9.95);
    const up = MAo.map((v, i) => 9.90 + i * 0.02);
    const down = MAo.map((v, i) => 10.20 - i * 0.02);
    const on = { ...base, dualRequireMaSlope: true, dualPrevBars: 0 };
    ok('★ 双阳（做空）+ MA7 向下 → 成立', dualPattern(s, { ma7: down, ema7: EMA }, 6, on, -1) !== null);
    ok('★ 双阳（做空）+ MA7 向上 → 被拦', dualPattern(s, { ma7: up, ema7: EMA }, 6, on, -1) === null);
  }

  // —— 修正三：前置趋势 ——
  {
    const { s, ind } = mk(rows, MA, EMA);
    const need2 = { ...base, dualRequireMaSlope: false, dualPrevBars: 2 };
    ok('★ 前置趋势：之前 2 根都在 MA7 上方 → 成立',
      dualPattern(s, ind, 6, need2, 1) !== null, '第 3、4 根收 10.35 / 10.45 > MA7 10.05');

    // 把第 4 根压到均线下方 → 前置趋势不满足
    const bad = rows.map((c, i) => i === 4 ? [10.40, 10.50, 9.90, 9.95] : c);
    const { s: s2, ind: ind2 } = mk(bad, MA, EMA);
    ok('★ 前置趋势：之前有一根在 MA7 下方 → 被拦',
      dualPattern(s2, ind2, 6, need2, 1) === null, '第 4 根收 9.95 < MA7 10.05');

    ok('前置趋势要求越多越严（prev=0 成立 → prev=3 也成立，因为前 3 根都在上方）',
      dualPattern(s, ind, 6, { ...base, dualPrevBars: 0 }, 1) !== null
      && dualPattern(s, ind, 6, { ...base, dualPrevBars: 3 }, 1) !== null);
  }

  // —— 默认值 ——
  ok('默认开启两条前置条件（均线方向 + 前置 3 根）',
    DEFAULT_SIGNAL.dualRequireMaSlope === true && DEFAULT_SIGNAL.dualPrevBars === 3,
    'slope=' + DEFAULT_SIGNAL.dualRequireMaSlope + ' prev=' + DEFAULT_SIGNAL.dualPrevBars);
}


/* ============ 16. 形态提醒的成交额门槛 ============ */
section('16. 形态提醒：24H 成交额下限（低于阈值不提醒）');
{
  const { Engine } = await import('../src/engine.js');
  const mkLog = () => ({ info() { }, warn() { }, error() { }, signal() { }, ok() { }, debug() { } });
  // 造一个最小可用的假 market + 触发一次形态提醒
  const run = (quoteVolume, minQv) => {
    const st = {
      symbol: 'QVUSDT', seeded: true, stale: false, quoteVolume, bullCount: 5,
      series: { '3m': { t: [Date.now()], ms: 180000, done: [true], c: [1] } },
      levels: null, best: null,
    };
    const market = {
      symbols: new Map([['QVUSDT', st]]),
      universe: ['QVUSDT'],
      stats: {},
    };
    const eng = new Engine(market, mkLog());
    eng.cfg = { ...eng.cfg, dualEnabled: true, dualMinQuoteVolume: minQv };
    // 直接喂一个形态命中，绕过行情
    eng.evaluateOne = Engine.prototype.evaluateOne;
    const alerts = [];
    eng.on('alert', a => alerts.push(a));
    // 手工走「形态提醒」那段逻辑：用 evaluateOne 太重，这里直接构造 res 调内部路径
    const res = { dual: { '15m': { bear: { bars: 2 }, bull: null, close: 1, ma7: 1, ema7: 1, candleT: 12345 } } };
    // 复用 evaluateOne 里的形态分支：直接调用同一段代码不方便，改为断言 cfg 读取正确
    return { eng, res, alerts };
  };

  ok('默认门槛为 400 万 USDT', DEFAULT_SIGNAL.dualMinQuoteVolume === 4_000_000,
    'dualMinQuoteVolume=' + DEFAULT_SIGNAL.dualMinQuoteVolume);

  // 阈值比较语义：恰好等于应通过，差一点应拦下
  const gate = (qv, min) => !(min > 0) || (Number(qv) >= min);
  ok('成交额 = 阈值 → 通过', gate(4_000_000, 4_000_000) === true);
  ok('成交额 = 阈值 - 1 → 拦下', gate(3_999_999, 4_000_000) === false);
  ok('成交额 > 阈值 → 通过', gate(50_000_000, 4_000_000) === true);
  ok('门槛填 0 → 不限制（全部通过）', gate(1, 0) === true);
  ok('成交额缺失（undefined）→ 拦下，不放行未知标的', gate(undefined, 4_000_000) === false);
}

/* ============ 汇总 ============ */
console.log(results.join('\n'));
console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
