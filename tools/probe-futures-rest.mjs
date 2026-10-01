/** 合约降级方案可行性：备选域名 + REST 实时价格通道的权重成本 */
const F = 'https://fapi.binance.com';
const w = async (path, label) => {
  const b = Number((await fetch(F + '/fapi/v1/time')).headers.get('x-mbx-used-weight-1m'));
  const t0 = Date.now();
  const r = await fetch(F + path);
  const j = await r.json();
  const a = Number(r.headers.get('x-mbx-used-weight-1m'));
  const n = Array.isArray(j) ? j.length : 1;
  console.log(`  ${label.padEnd(34)} 权重≈${String(a - b).padStart(3)}  返回 ${String(n).padStart(5)} 条  ${Date.now() - t0}ms`);
  return { j, delta: a - b };
};

console.log('=== REST 通道权重成本（合约）===');
const price = await w('/fapi/v1/ticker/price', 'GET /ticker/price (全量)');
const mk = await w('/fapi/v1/premiumIndex', 'GET /premiumIndex (全量)');
await w('/fapi/v1/ticker/24hr?symbol=BTCUSDT', 'GET /ticker/24hr (单币)');
await w('/fapi/v1/ticker/24hr', 'GET /ticker/24hr (全量)');
await w('/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=99', 'GET /klines limit=99');
await w('/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=150', 'GET /klines limit=150');
await w('/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=200', 'GET /klines limit=200');

console.log(`\n  /ticker/price 样例: ${JSON.stringify(price.j.slice(0, 3))}`);
console.log(`  /premiumIndex 样例: ${JSON.stringify(mk.j.slice(0, 2))}`);

/* 降级方案权重预算测算 */
const BUDGET = 2400;
const plan = [
  ['价格流 /ticker/price 每 2s', 30 * (price.delta || 2)],
  ['涨幅榜 /ticker/24hr 每 60s', 40],
  ['1m klines 每 60s (200币)', 200 * 1],
  ['3m klines 每 60s (200币)', 200 * 1],
  ['5m klines 每 60s (200币)', 200 * 1],
  ['15m klines 每 120s (200币)', 100 * 1],
  ['30m klines 每 180s (200币)', 67 * 1],
  ['1h klines 每 180s (200币)', 67 * 1],
  ['2h/4h klines 每 300s (400次)', Math.round(400 / 5)],
  ['6h/12h/1d/1w 每 600s (800次)', Math.round(800 / 10)],
];
let total = 0;
console.log('\n=== 降级方案（REST 轮询 + 价格流）权重预算 ===');
for (const [k, v] of plan) { total += v; console.log(`  ${k.padEnd(34)} ${String(v).padStart(5)} 权重/分钟`); }
console.log(`  ${'合计'.padEnd(34)} ${String(total).padStart(5)} / ${BUDGET}  余量 ${(((BUDGET - total) / BUDGET) * 100).toFixed(0)}%`);

/* 备选 WS 域名 */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wsTry(label, url, params, sec = 10) {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    let data = 0, ack = 0;
    const fin = () => { console.log(`  ${label.padEnd(40)} 数据帧=${data} 回执=${ack}`); try { ws.close(); } catch { } resolve(); };
    setTimeout(fin, sec * 1000);
    ws.addEventListener('open', () => { if (params) ws.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: 1 })); });
    ws.addEventListener('error', () => { });
    ws.addEventListener('message', ev => {
      const s = typeof ev.data === 'string' ? ev.data : String(ev.data);
      try { const m = JSON.parse(s); if (m.result !== undefined) ack++; else data++; } catch { data++; }
    });
  });
}
console.log('\n=== 备选 WS 域名 ===');
await wsTry('fstream-auth.binance.com /ws', 'wss://fstream-auth.binance.com/ws', ['btcusdt@kline_1m']);
await wsTry('fstream.binance.com /stream (combined)', 'wss://fstream.binance.com/stream?streams=btcusdt@kline_1m', null);
await wsTry('fstream.binance.com /ws/btcusdt@depth@100ms', 'wss://fstream.binance.com/ws/btcusdt@depth@100ms', null);
