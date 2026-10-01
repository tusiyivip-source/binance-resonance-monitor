// WS 能力探测 v2：正确分批订阅，统计唯一流覆盖与真实速率
import { performance } from 'node:perf_hooks';

const URL = 'wss://stream.binance.com:9443/ws';
const LEVELS = ['kline_3m', 'kline_5m', 'kline_15m', 'kline_30m'];

const tickerRes = await fetch('https://api.binance.com/api/v3/ticker/24hr');
const all = await tickerRes.json();
const BAD = /(UP|DOWN|BULL|BEAR)USDT$/;
const symbols = all
  .filter(t => t.symbol.endsWith('USDT') && !BAD.test(t.symbol))
  .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
  .slice(0, 200)
  .map(t => t.symbol.toLowerCase());

const names = [];
for (const s of symbols) for (const l of LEVELS) names.push(`${s}@${l}`);
console.log('symbols:', symbols.length, 'streams:', names.length);

const ws = new WebSocket(URL);
let seen = new Set(), closed = 0, lastCloseMsgs = 0;
let msgCount = 0, byteCount = 0;

ws.addEventListener('open', () => {
  console.log('WS open');
  let idx = 0, id = 0;
  const timer = setInterval(() => {
    const chunk = names.slice(idx, idx + 200);
    if (!chunk.length) { clearInterval(timer); console.log('SUBSCRIBE 完成, 共', names.length, '条流'); return; }
    ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: chunk, id: ++id }));
    idx += chunk.length;
  }, 300);
});

ws.addEventListener('error', e => console.log('WS error:', e.message ?? e.type));
ws.addEventListener('close', e => console.log('WS close:', e.code, e.reason));

const t0 = performance.now();
let last = t0;
setInterval(() => {
  const now = performance.now(), dt = (now - last) / 1000; last = now;
  const rate = msgCount / dt;
  console.log(
    `t=${((now - t0) / 1000).toFixed(0)}s  msg/s=${rate.toFixed(0)}  KB/s=${(byteCount / dt / 1024).toFixed(1)}` +
    `  覆盖流=${seen.size}/${names.length}  本秒收盘K线=${lastCloseMsgs}  累计收盘=${closed}`,
  );
  msgCount = 0; byteCount = 0; lastCloseMsgs = 0;
}, 1000);

ws.addEventListener('message', ev => {
  const s = ev.data;
  msgCount++; byteCount += s.length;
  try {
    const m = JSON.parse(s);
    if (m.stream) seen.add(m.stream);
    if (m.data?.x === true) { closed++; lastCloseMsgs++; }
  } catch {}
});

setTimeout(() => { console.log('done'); process.exit(0); }, 40000);
