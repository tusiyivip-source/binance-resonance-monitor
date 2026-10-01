/** 合约 WS 数据面阻塞范围探测 */
import dns from 'node:dns/promises';
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('=== DNS 解析 ===');
for (const host of ['fstream.binance.com', 'stream.binance.com', 'dstream.binance.com', 'fapi.binance.com']) {
  try {
    const [v4, v6] = await Promise.all([
      dns.resolve4(host).catch(() => []),
      dns.resolve6(host).catch(() => []),
    ]);
    console.log(`  ${host.padEnd(24)} A=${v4.join(',') || '无'}  AAAA=${v6.join(',') || '无'}`);
  } catch (e) { console.log(`  ${host} 解析失败 ${e.message}`); }
}

async function test(label, url, params, seconds = 14) {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    let raw = 0, kline = 0, other = 0, ack = 0, sample = '', err = '';
    const done = () => {
      console.log(`  ${label.padEnd(46)} raw=${String(raw).padStart(4)} kline=${String(kline).padStart(4)} 其他=${String(other).padStart(4)}`);
      if (sample) console.log(`     样例: ${sample.slice(0, 150)}`);
      if (err) console.log(`     错误: ${err}`);
      try { ws.close(); } catch { }
      resolve();
    };
    const t = setTimeout(done, seconds * 1000);
    ws.addEventListener('open', () => { if (params) ws.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: 1 })); });
    ws.addEventListener('error', () => { err = 'error 事件'; });
    ws.addEventListener('close', e => { if (e.code !== 1000 && e.code !== 1005) err = `意外关闭 code=${e.code}`; });
    ws.addEventListener('message', ev => {
      raw++;
      const s = typeof ev.data === 'string' ? ev.data : String(ev.data);
      try {
        const m = JSON.parse(s);
        if (m.result !== undefined) { ack++; return; }
        if (m.e === 'kline') kline++;
        else if (m.data?.e === 'kline') kline++;
        else other++;
        if (!sample) sample = s;
      } catch { other++; }
    });
  });
}

console.log('\n=== 合约 WS 各流类型（每条 14s）===');
await test('fstream /ws  单流 kline（URL 方式）', 'wss://fstream.binance.com/ws/btcusdt@kline_1m', null);
await test('fstream /ws  SUBSCRIBE kline', 'wss://fstream.binance.com/ws', ['btcusdt@kline_1m']);
await test('fstream /ws  SUBSCRIBE aggTrade', 'wss://fstream.binance.com/ws', ['btcusdt@aggTrade']);
await test('fstream /ws  SUBSCRIBE markPrice@1s', 'wss://fstream.binance.com/ws', ['btcusdt@markPrice@1s']);
await test('fstream /ws  SUBSCRIBE !miniTicker@arr', 'wss://fstream.binance.com/ws', ['!miniTicker@arr']);
await test('fstream /ws  SUBSCRIBE !ticker@arr', 'wss://fstream.binance.com/ws', ['!ticker@arr']);
await test('fstream /ws  端口443显式', 'wss://fstream.binance.com:443/ws', ['btcusdt@kline_1m']);

console.log('\n=== 其他域名对照 ===');
await test('dstream(币本位) /ws kline', 'wss://dstream.binance.com/ws', ['btcusdt@kline_1m']);
await test('spot /ws kline（对照，应正常）', 'wss://stream.binance.com:9443/ws', ['btcusdt@kline_1m'], 10);

console.log('\n=== 合约 端口9443 ===');
await test('fstream :9443 /ws kline', 'wss://fstream.binance.com:9443/ws', ['btcusdt@kline_1m'], 10);
