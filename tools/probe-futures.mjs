/**
 * 合约（U 本位永续）能力探测：与现货的差异点
 *   node tools/probe-futures.mjs
 */
const F = 'https://fapi.binance.com';
const t0 = Date.now();

/* ---------- 1. 连通性与限频 ---------- */
const ping = await fetch(F + '/fapi/v1/ping');
console.log(`1) ping: ${ping.status}  ${Date.now() - t0}ms`);

const ei = await fetch(F + '/fapi/v1/exchangeInfo');
const info = await ei.json();
console.log(`2) 限频规则: ${JSON.stringify(info.rateLimits)}`);
console.log(`   exchangeInfo 权重消耗: ${ei.headers.get('x-mbx-used-weight-1m')} / 6000(现货口径)`);
console.log(`   futures 响应头: x-mbx-used-weight-1m=${ei.headers.get('x-mbx-used-weight-1m')}`);

/* ---------- 2. 合约标的 ---------- */
const perp = info.symbols.filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT');
console.log(`3) USDT 永续合约: ${perp.length} 个（全部合约 ${info.symbols.length} 个）`);
console.log(`   样例: ${perp.slice(0, 6).map(s => s.symbol).join(', ')}`);
const types = {};
for (const s of info.symbols) types[s.contractType] = (types[s.contractType] || 0) + 1;
console.log(`   合约类型分布: ${JSON.stringify(types)}`);
console.log(`   交割合约样例: ${info.symbols.filter(s => s.contractType === 'CURRENT_QUARTER').slice(0, 3).map(s => s.symbol).join(', ') || '无'}`);

/* ---------- 3. 24h 行情 ---------- */
const before = Number(ei.headers.get('x-mbx-used-weight-1m') || 0);
const tk = await fetch(F + '/fapi/v1/ticker/24hr');
const tickers = await tk.json();
const after = Number(tk.headers.get('x-mbx-used-weight-1m') || 0);
console.log(`4) /fapi/v1/ticker/24hr(全量): ${tickers.length} 条，权重增量≈${after - before}`);
console.log(`   字段: ${Object.keys(tickers[0]).join(',')}`);

/* ---------- 4. K线周期支持 ---------- */
console.log('5) 合约原生K线周期:');
const ivs = ['1s', '1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '1w'];
const support = {};
for (const iv of ivs) {
  const r = await fetch(`${F}/fapi/v1/klines?symbol=BTCUSDT&interval=${iv}&limit=2`);
  support[iv] = r.status;
  process.stdout.write(`   ${iv}:${r.status}${r.status !== 200 ? ' ' : ''}`);
}
console.log('\n   不支持的周期: ' + ivs.filter(i => support[i] !== 200).join(', ') || '无');

/* ---------- 5. klines 权重 ---------- */
const w = async (lim) => {
  const b = Number((await fetch(F + '/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=2')).headers.get('x-mbx-used-weight-1m'));
  const r = await fetch(`${F}/fapi/v1/klines?symbol=BTCUSDT&interval=3m&limit=${lim}`);
  await r.json();
  const a = Number(r.headers.get('x-mbx-used-weight-1m'));
  return { lim, delta: a - b, used: a };
};
console.log('6) /fapi/v1/klines 权重:');
for (const lim of [99, 100, 200, 500, 1000]) {
  const r = await w(lim);
  console.log(`   limit=${String(lim).padStart(4)} → 权重增量 ${r.delta}  (used=${r.used})`);
}

/* ---------- 6. WebSocket ---------- */
console.log('7) 合约 WebSocket 探测 (wss://fstream.binance.com/ws):');
await new Promise(resolve => {
  const ws = new WebSocket('wss://fstream.binance.com/ws');
  let n = 0, first = 0, closed = 0, streams = new Set(), err = '';
  const names = [];
  const syms = perp.slice(0, 200).map(s => s.symbol.toLowerCase());
  for (const s of syms) for (const l of ['kline_1m', 'kline_3m', 'kline_5m', 'kline_15m']) names.push(`${s}@${l}`);
  ws.addEventListener('open', () => {
    console.log(`   连接已建立，准备订阅 ${names.length} 条流…`);
    let i = 0;
    const t = setInterval(() => {
      const chunk = names.slice(i, i + 200);
      if (!chunk.length) { clearInterval(t); console.log('   订阅发送完毕'); return; }
      ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: chunk, id: ++i }));
      i += chunk.length;
    }, 350);
  });
  ws.addEventListener('message', ev => {
    const s = ev.data;
    if (typeof s !== 'string') return;
    let m; try { m = JSON.parse(s); } catch { return; }
    if (m.error) { err = JSON.stringify(m.error); console.log('   ❌ 错误回执: ' + err); return; }
    if (m.e === 'kline') { n++; if (!first) first = Date.now(); streams.add(m.s + '@' + m.k.i); if (m.k.x) closed++; }
  });
  ws.addEventListener('close', e => console.log(`   WS 关闭 code=${e.code} reason=${e.reason}`));
  ws.addEventListener('error', () => console.log('   WS error 事件'));
  setTimeout(() => {
    console.log(`   15s 内: 收到 ${n} 条kline, 覆盖 ${streams.size}/${names.length} 条流, 收盘事件 ${closed}, 首条延迟 ${first ? first - t0 : '—'}ms`);
    console.log(`   平均速率 ${(n / 15).toFixed(0)} 条/秒`);
    if (err) console.log('   订阅错误: ' + err);
    ws.close(); resolve();
  }, 15000);
});

/* ---------- 7. 资金费率等合约特有字段 ---------- */
const prem = await fetch(F + '/fapi/v1/premiumIndex?symbol=BTCUSDT').then(r => r.json());
console.log(`8) 合约特有: fundingRate=${prem.fundingRate}  nextFundingTime=${new Date(prem.nextFundingTime).toISOString()}  markPrice=${prem.markPrice}`);
const oi = await fetch(F + '/fapi/v1/openInterest?symbol=BTCUSDT').then(r => r.json());
console.log(`   持仓量 openInterest=${oi.openInterest}`);
