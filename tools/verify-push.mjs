/**
 * 钉钉推送端到端验证：  node tools/verify-push.mjs
 *
 * 起一个「Mock 钉钉机器人」HTTP 服务，逐项校验：
 *   · 请求路径与参数（access_token / timestamp / sign）
 *   · 加签算法是否与官方规则一致（服务端独立重算 HMAC 比对）
 *   · 消息体结构（msgtype=markdown、title、text）与关键词注入
 *   · 聚合窗口、评分过滤、仅已确认过滤
 *   · 失败重试、限流退避、错误码解析
 * 最后再对**真实钉钉接口**发一次无效 token 请求，证明网络与请求格式在真实环境同样被受理。
 */
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(cond ? `  \u001b[32m✓\u001b[0m ${name}${detail ? '  \u001b[2m' + detail + '\u001b[0m' : ''}`
    : `  \u001b[31m✗\u001b[0m ${name}  \u001b[31m${detail}\u001b[0m`);
  cond ? pass++ : fail++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- Mock 钉钉服务 ---------------- */
const received = [];
let mode = 'ok';                    // ok | fail2then | ratelimit | keyword
let failCount = 0;
const SECRET = 'SEC0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd';
const TOKEN = 'a'.repeat(64);

const mock = http.createServer((req, res) => {
  const rawUrl = req.url;
  const u = new URL(req.url, 'http://127.0.0.1');
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    // —— 独立重算签名，验证客户端加签是否正确 ——
    // 注意：searchParams.get() 会自动做 URL 解码，所以这里要和「原始 base64」比对；
    // 同时用原始 query string 校验线上传的确实是「已编码」的形式。
    const ts = u.searchParams.get('timestamp');
    const signDecoded = u.searchParams.get('sign');
    const expectB64 = ts
      ? crypto.createHmac('sha256', SECRET).update(`${ts}\n${SECRET}`, 'utf8').digest('base64')
      : null;
    const expectEncoded = expectB64 ? encodeURIComponent(expectB64) : null;
    const signOk = !!expectB64 && signDecoded === expectB64;
    const onWireEncoded = !!expectEncoded && rawUrl.includes('sign=' + expectEncoded);

    let parsed = null;
    try { parsed = JSON.parse(body); } catch { /* 非 JSON */ }
    received.push({
      path: u.pathname, rawUrl,
      token: u.searchParams.get('access_token'),
      ts, signDecoded, expectB64, signOk, onWireEncoded, parsed, raw: body,
    });
    res.setHeader('content-type', 'application/json');

    if (mode === 'ratelimit') return res.end(JSON.stringify({ errcode: 660026, errmsg: 'sending too many messages per minute' }));
    if (mode === 'keyword') return res.end(JSON.stringify({ errcode: 310000, errmsg: 'keywords not in content' }));
    if (mode === 'fail2then' && failCount++ < 2) return res.end(JSON.stringify({ errcode: 500, errmsg: 'server error' }));
    res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const PORT = mock.address().port;
console.log(`\nMock 钉钉服务已启动 :${PORT}\n`);
process.env.DINGTALK_URL = `http://127.0.0.1:${PORT}/robot/send`;

/* ---------------- 导入被测模块 ---------------- */
const { Pusher, formatAlerts, dingtalkSign } = await import('../src/push.js');

const tmp = path.join(os.tmpdir(), `dsh-push-${Date.now()}.json`);
const silent = { info() { }, warn() { }, error() { }, signal() { } };
const livePushers = [];
/** 关掉之前所有实例的定时器，避免它们的重投污染后续用例的计数 */
function killAll() {
  for (const p of livePushers) {
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    p.queue.length = 0;
  }
  livePushers.length = 0;
}
const mkPusher = (extra = {}) => {
  killAll();
  received.length = 0;
  const p = new Pusher(tmp, silent);
  livePushers.push(p);
  p.sentTimes = [];
  p.queue = [];
  if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  p.setConfig({
    enabled: true,
    minScore: 0,
    batchWindowMs: 0,
    maxPerMinute: 20,
    maxItemsPerMessage: 8,
    confirmedOnly: false,
    channels: [{ type: 'dingtalk', enabled: true, accessToken: TOKEN, secret: SECRET, keyword: '盯盘' }],
    ...extra,
  });
  return p;
};

const alert = (symbol, score, confirmed = true) => ({
  symbol, group: '3m>15m>2h', base: '3m', mid: '15m', big: '2h',
  score, confirmed, price: 1.2345, distBaseMa7Pct: 0.42, bullCount: 9, ts: Date.now(),
  text: `${symbol} 回踩后上穿MA7/EMA7，15分同步上穿均线，2时站稳EMA7不破`,
});

/* ---------------- 1. 加签算法 ---------------- */
console.log('\u001b[36m▌1. 加签算法\u001b[0m');
{
  const ts = 1700000000000;
  const expect = encodeURIComponent(crypto.createHmac('sha256', SECRET).update(`${ts}\n${SECRET}`).digest('base64'));
  ok('签名与独立实现一致', dingtalkSign(SECRET, ts) === expect, String(dingtalkSign(SECRET, ts)).slice(0, 42) + '…');
  ok('签名做了 URL 编码（+ / = 必须转义）',
    !/[+/=]/.test(dingtalkSign(SECRET, ts)), '无裸 + / = 字符');
  ok('同一时间戳可复现', dingtalkSign(SECRET, ts) === dingtalkSign(SECRET, ts));
  ok('不同时间戳结果不同', dingtalkSign(SECRET, ts) !== dingtalkSign(SECRET, ts + 1));
}

/* ---------------- 2. 单条发送 + 结构校验 ---------------- */
console.log('\n\u001b[36m▌2. 单条发送与请求结构\u001b[0m');
{
  received.length = 0;
  const p = mkPusher({ batchWindowMs: 0 });
  const r = await p.sendTest();
  ok('测试消息发送成功', r.ok, r.results?.map(x => `${x.label}:${x.ok ? 'ok' : x.error}`).join(', '));

  const msg = received[0];
  ok('请求打到 Mock 服务且路径正确', !!msg && msg.path === '/robot/send', msg?.path);
  ok('access_token 正确传递', msg?.token === TOKEN, String(msg?.token).slice(0, 12) + '…');
  ok('timestamp / sign 参数齐全', !!msg?.ts && !!msg?.signDecoded);
  ok('★ 线上传输的 sign 是 URL 编码形式（+ / = 已转义）', msg?.onWireEncoded === true,
    msg?.onWireEncoded ? '原始 query 中为编码后的 sign' : `raw=${String(msg?.rawUrl).slice(0, 90)}`);
  ok('★ 服务端独立重算签名一致', msg?.signOk === true, msg?.signOk ? 'HMAC-SHA256 校验通过' : '签名不匹配！');
  ok('消息结构为 markdown', msg?.parsed?.msgtype === 'markdown'
    && typeof msg?.parsed?.markdown?.title === 'string'
    && typeof msg?.parsed?.markdown?.text === 'string',
    `title="${msg?.parsed?.markdown?.title}"`);
  ok('自定义关键词被注入标题', String(msg?.parsed?.markdown?.title ?? '').includes('盯盘'), msg?.parsed?.markdown?.title);
  ok('正文含标题与信号明细',
    String(msg?.parsed?.markdown?.text ?? '').includes('###') && String(msg?.parsed?.markdown?.text).includes('TESTUSDT'));
  {
    // 非测试消息才带来源行
    const real = formatAlerts([alert('SRC', 80)], {});
    ok('正式消息带来源尾注', real.text.includes('来源：币安多级别共振盯盘系统'));
    ok('正式消息标题为单信号摘要', real.title.includes('SRC') && real.title.includes('3m→15m→2h'), real.title);
  }
}

/* ---------------- 3. 批量聚合 ---------------- */
console.log('\n\u001b[36m▌3. 批量聚合（避免刷屏与撞限流）\u001b[0m');
{
  received.length = 0;
  const p = mkPusher({ batchWindowMs: 300 });
  for (const s of ['AAAUSDT', 'BBBUSDT', 'CCCUSDT']) ok(`  push(${s}) 入队`, p.push(alert(s, 70)) === true);
  ok('入队后尚未发送（等聚合窗口）', received.length === 0, `已发 ${received.length} 条`);
  await sleep(900);
  ok('窗口到期后合并成 1 条消息发出', received.length === 1, `实际发出 ${received.length} 条`);
  const txt = received[0]?.parsed?.markdown?.text ?? '';
  ok('同一条消息里包含全部 3 个信号',
    txt.includes('AAAUSDT') && txt.includes('BBBUSDT') && txt.includes('CCCUSDT'),
    `标题="${received[0]?.parsed?.markdown?.title}"`);
  ok('多处信号时标题显示条数', String(received[0]?.parsed?.markdown?.title).includes('×3'), received[0]?.parsed?.markdown?.title);
}

/* ---------------- 4. 过滤规则 ---------------- */
console.log('\n\u001b[36m▌4. 过滤规则\u001b[0m');
{
  received.length = 0;
  const p = mkPusher({ batchWindowMs: 0, minScore: 70, confirmedOnly: true });
  ok('低分信号被丢弃', p.push(alert('LOWSCORE', 55)) === false);
  ok('未收盘预警被丢弃（仅已确认模式）', p.push(alert('PREVIEW', 90, false)) === false);
  ok('达标且已确认的信号入队', p.push(alert('GOOD', 88, true)) === true);
  await p.flush();
  await sleep(200);
  ok('只有 1 条达标信号被发出', received.length === 1 && received[0].parsed.markdown.text.includes('GOOD'),
    `发出 ${received.length} 条`);
  ok('丢弃计数正确', p.stats.dropped === 2, `dropped=${p.stats.dropped}`);
}

/* ---------------- 5. 重试与限流 ---------------- */
console.log('\n\u001b[36m▌5. 失败重试与限流退避\u001b[0m');
{
  received.length = 0; mode = 'fail2then'; failCount = 0;
  const p = mkPusher({ batchWindowMs: 0 });
  p.push(alert('RETRY', 80));
  await p.flush();
  await sleep(300);
  ok('前两次失败后自动重试成功', p.stats.sent === 1 && received.length === 3,
    `请求 ${received.length} 次，sent=${p.stats.sent}`);
  mode = 'ok';

  received.length = 0; mode = 'ratelimit';
  const p2 = mkPusher({ batchWindowMs: 0 });
  p2.push(alert('LIMIT', 80));
  const t0 = Date.now();
  await p2.flush();
  const elapsed = Date.now() - t0;
  ok('限流(660026)时立即返回、不长睡阻塞', elapsed < 3000, `flush 耗时 ${elapsed}ms`);
  ok('★ 限流后消息留在队列（不被静默丢弃）',
    p2.stats.sent === 0 && p2.queue.length === 1 && p2.stats.retried === 1,
    `queue=${p2.queue.length} sent=${p2.stats.sent} retried=${p2.stats.retried}`);

  // 恢复后应能自动补发
  mode = 'ok'; received.length = 0;
  if (p2.timer) { clearTimeout(p2.timer); p2.timer = null; }
  await p2.flush();
  await sleep(150);
  ok('★ 限流恢复后自动补发成功', received.length === 1 && p2.queue.length === 0 && p2.stats.sent === 1,
    `已发 ${received.length} 条，队列 ${p2.queue.length}`);

  received.length = 0; mode = 'keyword';
  const p3 = mkPusher({ batchWindowMs: 0 });
  p3.push(alert('KW', 80));
  await p3.flush();
  ok('关键词不通过(310000)时给出可操作提示',
    /自定义关键词/.test(p3.stats.lastError ?? ''), p3.stats.lastError);
  mode = 'ok';

  // 持续失败应在达到上限后放弃，避免无限重试
  received.length = 0; mode = 'keyword';
  const p4 = mkPusher({ batchWindowMs: 0, maxPerMinute: 20 });
  p4.cfg.channels[0].keyword = '';          // 去掉关键词注入，模拟永远失败
  p4.push(alert('GIVEUP', 80));
  for (let i = 0; i < 6; i++) {
    if (p4.timer) { clearTimeout(p4.timer); p4.timer = null; }
    await p4.flush();
    await sleep(60);
  }
  ok('永久失败时达上限后放弃（不无限重试）',
    p4.queue.length === 0 && p4.stats.failed === 1, `queue=${p4.queue.length} failed=${p4.stats.failed}`);
  mode = 'ok';
}

/* ---------------- 6. 速率闸门 ---------------- */
console.log('\n\u001b[36m▌6. 每分钟上限闸门\u001b[0m');
{
  const p = mkPusher({ batchWindowMs: 0, maxPerMinute: 2, maxItemsPerMessage: 1 });
  for (let i = 0; i < 4; i++) { p.queue.push(alert('RATE' + i, 80)); }
  for (let i = 0; i < 4; i++) {
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    await p.flush();
    await sleep(80);
  }
  ok('达到每分钟上限后停止发送、剩余留在队列',
    p.stats.sent === 2 && p.queue.length === 2 && received.length === 2,
    `已发 ${p.stats.sent} 条，请求 ${received.length} 次，队列剩 ${p.queue.length}`);
  killAll();
}

/* ---------------- 7. 密钥掩码 ---------------- */
console.log('\n\u001b[36m▌7. 密钥不泄露\u001b[0m');
{
  const p = mkPusher({});
  const pub = p.publicConfig();
  const c = pub.channels[0];
  ok('publicConfig 隐藏 accessToken', !c.accessToken && !!c.accessTokenMasked, c.accessTokenMasked);
  ok('publicConfig 隐藏 secret', !c.secret && !!c.secretMasked, c.secretMasked);
  ok('掩码不包含完整密钥', !JSON.stringify(pub).includes(TOKEN));

  // 回传掩码时应保留原值
  p.setConfig({ channels: [{ type: 'dingtalk', enabled: true, accessToken: c.accessTokenMasked, secret: c.secretMasked, keyword: '盯盘' }] });
  ok('回传掩码时保留原密钥', p.cfg.channels[0].accessToken === TOKEN && p.cfg.channels[0].secret === SECRET);
}

/* ---------------- 8. 真实钉钉接口 ---------------- */
console.log('\n\u001b[36m▌8. 真实钉钉接口连通性（无效 token，只验证网络与格式）\u001b[0m');
{
  delete process.env.DINGTALK_URL;
  const p = new Pusher(path.join(os.tmpdir(), `dsh-push-real-${Date.now()}.json`), silent);
  p.setConfig({
    enabled: true, minScore: 0, batchWindowMs: 0, maxPerMinute: 20,
    channels: [{ type: 'dingtalk', enabled: true, accessToken: '0'.repeat(64), secret: SECRET, keyword: '盯盘' }],
  });
  const r = await p.sendTest();
  const err = (r.results ?? [])[0]?.error ?? '';
  // 合法结果有两种：token 无效(300005) 或 被限流(660026) —— 都证明请求被服务端正常受理。
  // 不该出现的是：网络错误、签名错误、消息格式错误。
  ok('真实接口可达且受理了请求（业务错误码，而非网络/格式错误）',
    /errcode=300005|token is not exist|660026/.test(err), err.slice(0, 130));
  ok('★ 签名被真实服务端接受（错误与 sign 无关）',
    !/\bsign\b|签名不匹配|sign not match/i.test(err), err.slice(0, 110));
  ok('错误被正确归类（限流走退避、其余走失败）',
    /660026/.test(err) ? /限流/.test(err) : true, err.slice(0, 110));
}

/* ---------------- 汇总 ---------------- */
try { fs.rmSync(tmp, { force: true }); } catch { }
mock.close();
console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
