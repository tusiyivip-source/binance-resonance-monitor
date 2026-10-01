/** 合约版本运行状态 + 延迟实测 */
const B = 'http://127.0.0.1:8848';
const j = async p => (await fetch(B + p)).json();

const s = await j('/api/stats');
const m = s.market;
console.log('=== 运行状态 ===');
console.log(`  市场      : ${m.marketName}  (${m.market})`);
console.log(`  行情源    : ${m.feedMode}`);
console.log(`  标的      : ${m.symbols}  播种 ${m.seeding.done}/${m.seeding.total}`);
console.log(`  权重      : ${m.rest.lastUsedWeight}/${m.weightCap}   往返 ${m.rest.avgLatency}ms`);
if (m.tick) {
  console.log(`  bookTicker: ${m.tick.state}  消息 ${m.tick.bookMsgs}  价格tick ${m.tick.priceTicks}  重连 ${m.tick.reconnects}`);
  console.log(`  滚动补K线 : 累计 ${m.tick.rollingTicks} 次`);
  for (const [k, v] of Object.entries(m.tick.refresh)) console.log(`     ${k.padEnd(18)} ${v.done}/${v.total}`);
} else {
  console.log(`  WS 分片   : ${m.shards.map(x => `${x.name}=${x.state}/${x.streams}流`).join(' | ')}`);
}
console.log(`  引擎      : 评估 ${s.engine.evaluations}  信号 ${s.engine.signalCount}  当前共振 ${s.engine.activeSignals}  单轮 ${s.engine.lastSweepMs}ms`);

/* ---------- 延迟实测：K线新鲜度 ---------- */
const snap = await j('/api/snapshot');
const SYM = snap.symbols[0];
const d = await j('/api/detail?symbol=' + SYM);
const now = Date.now();
console.log(`\n=== 延迟实测（${SYM} 各周期最新K线，榜单第 1 名）===`);
console.log('  级别   最近K线开盘时间      距今      价格           MA7');
for (const [k, v] of Object.entries(d.levels)) {
  if (!v.lastCandleAt) continue;
  const age = ((now - v.lastCandleAt) / 1000).toFixed(0);
  console.log(`  ${k.padEnd(5)} ${new Date(v.lastCandleAt).toISOString().slice(11, 19)}  ${String(age).padStart(6)}s   ${String(v.price).padEnd(14)} ${v.ma7}`);
}

/* ---------- 关键：K线是否随实时价变动 ---------- */
const a = await j('/api/detail?symbol=' + SYM);
await new Promise(r => setTimeout(r, 5000));
const b = await j('/api/detail?symbol=' + SYM);
console.log(`\n=== 实时性：5 秒内 ${SYM} 当前K线是否变动 ===`);
for (const k of ['1m', '2m', '3m', '5m', '15m']) {
  const x = a.levels[k], y = b.levels[k];
  const chg = x?.price !== y?.price;
  console.log(`  ${k.padEnd(4)} ${x?.price} → ${y?.price}   ${chg ? '\u001b[32m已变动\u001b[0m' : '未变动'}`);
}

/* ---------- 实时信号推送 ---------- */
console.log('\n=== 报警面板 ===');
const p = await j('/api/performance');
console.log(`  绩效库 ${p.total} 条（已确认 ${p.confirmed} / 预警 ${p.preview}）`);
const al = await j('/api/alerts');
for (const x of al.slice(0, 5)) {
  console.log(`  ${new Date(x.ts).toISOString().slice(11, 19)}  ${x.symbol.padEnd(14)} ${x.group.padEnd(16)} ${String(x.score).padStart(3)}分  ${x.confirmed ? '已确认' : '预警'}`);
}
