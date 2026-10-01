/** 合约 WebSocket 定点排查：为什么订阅了却收不到数据 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function trial(label, url, act) {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    let raw = 0, parsed = 0, samples = [], types = new Set(), err = null;
    const timer = setTimeout(() => {
      console.log(`\n【${label}】`);
      console.log(`  收到原始消息 ${raw} 条，其中 e==='kline' ${parsed} 条`);
      console.log(`  ev.data 类型: ${[...types].join(', ') || '（无）'}`);
      if (err) console.log(`  错误: ${err}`);
      for (const s of samples.slice(0, 2)) console.log(`  样例: ${s}`);
      try { ws.close(); } catch { }
      resolve();
    }, 12000);
    ws.addEventListener('open', async () => { console.log(`\n【${label}】open`); await act(ws); });
    ws.addEventListener('error', e => { err = 'error 事件 ' + (e.message ?? e.type); });
    ws.addEventListener('close', e => { if (e.code !== 1005 && e.code !== 1000) err = `close code=${e.code} ${e.reason}`; });
    ws.addEventListener('message', ev => {
      raw++;
      types.add(typeof ev.data);
      const s = typeof ev.data === 'string' ? ev.data : ev.data?.toString?.() ?? String(ev.data);
      if (samples.length < 2) samples.push(s.slice(0, 220));
      try { const m = JSON.parse(s); if (m.e === 'kline') parsed++; } catch { }
    });
    ws._timer = timer;
  });
}

// A. 合约：单条流直接放进 URL（最基础的用法）
await trial('futures 单流 @ /ws/btcusdt@kline_1m', 'wss://fstream.binance.com/ws/btcusdt@kline_1m', async () => { });

// B. 合约：裸 /ws + SUBSCRIBE 单条
await trial('futures SUBSCRIBE 单条', 'wss://fstream.binance.com/ws', async ws => {
  ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: ['btcusdt@kline_1m'], id: 1 }));
});

// C. 合约：裸 /ws + SUBSCRIBE 多条（含迷你行情，验证通道本身是否活）
await trial('futures SUBSCRIBE 多条(含 aggTrade)', 'wss://fstream.binance.com/ws', async ws => {
  ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: ['btcusdt@kline_1m', 'btcusdt@aggTrade', 'ethusdt@kline_1m'], id: 1 }));
});

// D. 现货对照：裸 /ws + SUBSCRIBE 单条
await trial('spot SUBSCRIBE 单条（对照）', 'wss://stream.binance.com:9443/ws', async ws => {
  ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: ['btcusdt@kline_1m'], id: 1 }));
});

// E. 合约：combined 端点
await trial('futures combined /stream?streams=', 'wss://fstream.binance.com/stream?streams=btcusdt@kline_1m/ethusdt@kline_1m', async () => { });

// F. 合约：SUBSCRIBE 是否被受理（看回执）
await new Promise(resolve => {
  const ws = new WebSocket('wss://fstream.binance.com/ws');
  ws.addEventListener('open', () => {
    console.log('\n【futures SUBSCRIBE 回执检查】open');
    ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: ['btcusdt@kline_1m'], id: 777 }));
    ws.send(JSON.stringify({ method: 'LIST_SUBSCRIPTIONS', id: 778 }));
    setTimeout(() => { ws.close(); resolve(); }, 6000);
  });
  ws.addEventListener('message', ev => {
    const s = typeof ev.data === 'string' ? ev.data : ev.data?.toString?.();
    if (s && (s.includes('"id":777') || s.includes('"id":778') || s.includes('result'))) {
      console.log('  回执: ' + s.slice(0, 300));
    }
  });
});
