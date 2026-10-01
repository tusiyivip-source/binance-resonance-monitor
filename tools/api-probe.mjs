// 细节核验：klines 权重、官方 rateLimits、WS 收盘事件(x:true)
const base = 'https://api.binance.com';

const ei = await fetch(base + '/api/v3/exchangeInfo?symbols=%5B%22BTCUSDT%22%5D');
const info = await ei.json();
console.log('rateLimits:', JSON.stringify(info.rateLimits));
console.log('exchangeInfo used-weight:', ei.headers.get('x-mbx-used-weight-1m'));

async function weightOf(path, label) {
  const before = Number((await fetch(base + '/api/v3/time')).headers.get('x-mbx-used-weight-1m'));
  const r = await fetch(base + path);
  await r.json();
  const after = Number(r.headers.get('x-mbx-used-weight-1m'));
  console.log(`${label.padEnd(34)} used-weight: ${before} -> ${after}  (delta≈${after - before})`);
}
await weightOf('/api/v3/klines?symbol=BTCUSDT&interval=3m&limit=60', 'klines limit=60');
await weightOf('/api/v3/klines?symbol=BTCUSDT&interval=3m&limit=100', 'klines limit=100');
await weightOf('/api/v3/klines?symbol=BTCUSDT&interval=3m&limit=200', 'klines limit=200');
await weightOf('/api/v3/klines?symbol=BTCUSDT&interval=1w&limit=100', 'klines 1w limit=100');

// WS 收盘事件验证：用 1s 周期在 6 秒内必然收盘
await new Promise(resolve => {
  const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@kline_1s');
  let n = 0, closed = 0;
  ws.addEventListener('open', () => console.log('\nWS 1s stream open'));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    n++;
    if (m.k?.x) { closed++; console.log('  收盘K线 x:true ->', m.k.s, m.k.i, 'close=', m.k.c, 't=', m.k.t); }
  });
  setTimeout(() => { console.log(`WS 1s: 收到 ${n} 条, 其中收盘事件 ${closed} 条`); ws.close(); resolve(); }, 6000);
});

// 原生周期支持列表
const ivs = ['1s','1m','3m','5m','15m','30m','1h','2h','3h','4h','6h','12h','1d','1w'];
for (const iv of ivs) {
  const r = await fetch(`${base}/api/v3/klines?symbol=BTCUSDT&interval=${iv}&limit=1`);
  console.log(`interval ${iv.padEnd(4)} -> ${r.status}`);
}
