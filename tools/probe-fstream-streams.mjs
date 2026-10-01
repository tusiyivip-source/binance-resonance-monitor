/** 逐流类型探测：fstream 上到底哪些流能收到数据 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function t(label, url, params, sec = 10) {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    let data = 0, ack = 0, err = '', sample = '', bytes = 0;
    const fin = () => {
      const mark = data > 0 ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
      console.log(`  ${mark} ${label.padEnd(36)} 数据帧 ${String(data).padStart(5)}  回执 ${ack}  字节 ${bytes}`);
      if (err) console.log(`      错误: ${err}`);
      if (sample) console.log(`      样例: ${sample.slice(0, 130)}`);
      try { ws.close(); } catch { }
      resolve();
    };
    setTimeout(fin, sec * 1000);
    ws.addEventListener('open', () => { if (params) ws.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: 1 })); });
    ws.addEventListener('error', () => { });
    ws.addEventListener('message', ev => {
      const s = typeof ev.data === 'string' ? ev.data : String(ev.data);
      bytes += s.length;
      try {
        const m = JSON.parse(s);
        if (m.result !== undefined) { ack++; if (m.error) err = JSON.stringify(m.error); return; }
        data++;
        if (!sample) sample = s;
      } catch { data++; if (!sample) sample = s; }
    });
  });
}

const W = 'wss://fstream.binance.com/ws';
console.log('=== fstream 单流 URL 方式 ===');
await t('/ws/btcusdt@kline_1m', 'wss://fstream.binance.com/ws/btcusdt@kline_1m', null);
await t('/ws/btcusdt@depth@100ms', 'wss://fstream.binance.com/ws/btcusdt@depth@100ms', null);
await t('/ws/btcusdt@bookTicker', 'wss://fstream.binance.com/ws/btcusdt@bookTicker', null);
await t('/ws/btcusdt@depth5@100ms', 'wss://fstream.binance.com/ws/btcusdt@depth5@100ms', null);
await t('/ws/btcusdt@markPrice@1s', 'wss://fstream.binance.com/ws/btcusdt@markPrice@1s', null);
await t('/ws/btcusdt@aggTrade', 'wss://fstream.binance.com/ws/btcusdt@aggTrade', null);

console.log('\n=== fstream SUBSCRIBE 方式 ===');
await t('SUBSCRIBE btcusdt@kline_1m', W, ['btcusdt@kline_1m']);
await t('SUBSCRIBE btcusdt@bookTicker', W, ['btcusdt@bookTicker']);
await t('SUBSCRIBE !bookTicker (全市场)', W, ['!bookTicker']);
await t('SUBSCRIBE !markPrice@arr@1s (全市场)', W, ['!markPrice@arr@1s']);
await t('SUBSCRIBE !miniTicker@arr (全市场)', W, ['!miniTicker@arr']);

console.log('\n=== 多流混合（bookTicker + kline）===');
await t('SUBSCRIBE 3条 bookTicker + 1条 kline', W,
  ['btcusdt@bookTicker', 'ethusdt@bookTicker', 'solusdt@bookTicker', 'btcusdt@kline_1m']);

console.log('\n=== !bookTicker 承载能力（全市场 200 币）===');
await new Promise(resolve => {
  const ws = new WebSocket(W);
  let n = 0, syms = new Set(), bytes = 0, t0 = 0;
  ws.addEventListener('open', () => {
    t0 = Date.now();
    ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: ['!bookTicker'], id: 1 }));
  });
  ws.addEventListener('message', ev => {
    const s = typeof ev.data === 'string' ? ev.data : String(ev.data);
    bytes += s.length;
    try {
      const m = JSON.parse(s);
      if (m.result !== undefined) { console.log('  回执: ' + s.slice(0, 100)); return; }
      if (m.s) { n++; syms.add(m.s); }
    } catch { }
  });
  setTimeout(() => {
    const el = (Date.now() - t0) / 1000;
    console.log(`  !bookTicker 15s: 消息 ${n} 条, 覆盖 ${syms.size} 个币, ${(bytes / 1024 / el).toFixed(0)} KB/s, ${(n / el).toFixed(0)} 条/秒`);
    console.log(`  样例: ${[...syms].slice(0, 8).join(', ')}`);
    ws.close(); resolve();
  }, 15000);
});
