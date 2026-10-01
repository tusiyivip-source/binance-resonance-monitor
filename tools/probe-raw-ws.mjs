/**
 * 手工 WebSocket 握手 + 原始帧收发：绕开所有 WS 库，判定数据到底有没有到达网卡。
 *   node tools/probe-raw-ws.mjs
 */
import tls from 'node:tls';
import crypto from 'node:crypto';

function rawWs({ host, path: p, label, subscribe, seconds = 12 }) {
  return new Promise(resolve => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET ${p} HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n' +
        '\r\n',
      );
    });

    let handshake = '', upgraded = false, buf = Buffer.alloc(0);
    let totalBytes = 0, textFrames = 0, kline = 0, firstDataAt = 0, firstLen = 0;
    const t0 = Date.now();

    const parseFrames = () => {
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x1) {
          textFrames++;
          totalBytes += len;
          if (!firstDataAt) { firstDataAt = Date.now(); firstLen = len; }
          const s = payload.toString('utf8');
          try { if (JSON.parse(s).e === 'kline') kline++; } catch { }
        } else if (opcode === 0x9) {
          // 收到 ping，回 pong（手工构造未分片帧）
          const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
          socket.write(pong);
        }
        if (!fin) { /* 分片：此处不做重组，仅计数 */ }
      }
    };

    const finish = () => {
      console.log(`\n【${label}】`);
      console.log(`  握手: ${upgraded ? '101 成功' : '失败 — ' + handshake.split('\r\n')[0]}`);
      console.log(`  原始字节: ${totalBytes}  文本帧: ${textFrames}  其中 kline: ${kline}`);
      if (firstDataAt) console.log(`  首个数据帧: 订阅后 ${firstDataAt - t0}ms, 长度 ${firstLen} 字节`);
      else console.log('  ⚠ 订阅后 12 秒内没有收到任何数据帧');
      try { socket.destroy(); } catch { }
      resolve();
    };

    socket.on('data', chunk => {
      if (!upgraded) {
        handshake += chunk.toString('binary');
        const idx = handshake.indexOf('\r\n\r\n');
        if (idx >= 0) {
          const head = handshake.slice(0, idx);
          if (!/101/.test(head.split('\r\n')[0])) { console.log(`【${label}】升级失败: ${head.split('\r\n')[0]}`); socket.destroy(); resolve(); return; }
          upgraded = true;
          const rest = Buffer.from(handshake.slice(idx + 4), 'binary');
          handshake = '';
          // 发送订阅帧（客户端帧必须加掩码）
          const payload = Buffer.from(JSON.stringify({ method: 'SUBSCRIBE', params: subscribe, id: 1 }));
          const mask = crypto.randomBytes(4);
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
          let header;
          if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
          else header = Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 0xff]);
          socket.write(Buffer.concat([header, mask, masked]));
          console.log(`【${label}】升级成功，已发送订阅帧 (${payload.length} 字节)`);
          buf = Buffer.concat([buf, rest]);
          parseFrames();
        }
      } else {
        buf = Buffer.concat([buf, chunk]);
        parseFrames();
      }
    });

    socket.on('error', e => { console.log(`【${label}】socket 错误: ${e.message}`); resolve(); });
    socket.on('close', () => { });
    setTimeout(finish, seconds * 1000);
  });
}

await rawWs({
  host: 'fstream.binance.com', path: '/ws', label: '合约 fstream（手工握手）',
  subscribe: ['btcusdt@kline_1m'],
});
await rawWs({
  host: 'stream.binance.com', path: '/ws', label: '现货 stream（对照）',
  subscribe: ['btcusdt@kline_1m'],
});
await rawWs({
  host: 'dstream.binance.com', path: '/ws', label: '币本位 dstream（对照）',
  subscribe: ['btcusdt@kline_1m'],
});
