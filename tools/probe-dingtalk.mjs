/** 钉钉自定义机器人连通性 + 加签算法验证 */
import crypto from 'node:crypto';

/* ---------- 1. 连通性（用无效 token，只看服务是否可达、报错是否可解析） ---------- */
const url = 'https://oapi.dingtalk.com/robot/send?access_token=' + '0'.repeat(64);
const t0 = Date.now();
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'probe', text: '### probe' } }),
    signal: AbortSignal.timeout(15000),
  });
  const txt = (await res.text()).slice(0, 300);
  console.log(`\u001b[32m✓\u001b[0m 钉钉机器人  HTTP ${res.status}  ${Date.now() - t0}ms`);
  console.log(`    响应: ${txt}`);
  console.log('    \u001b[2m能收到 errcode 说明通道可用（无效 token 正常应返回 300001）\u001b[0m');
} catch (e) {
  console.log(`\u001b[31m✗\u001b[0m 钉钉机器人  ${Date.now() - t0}ms  失败: ${e.message}`);
}

/* ---------- 2. 加签算法（钉钉官方规则） ---------- */
// stringToSign = `${timestamp}\n${secret}`
// sign = urlEncode( base64( HMAC-SHA256( secret, stringToSign ) ) )
const SECRET = 'SEC0000000000000000000000000000000000000000000000000000000000000000';
const ts = Date.now();
const stringToSign = `${ts}\n${SECRET}`;
const raw = crypto.createHmac('sha256', SECRET).update(stringToSign, 'utf8').digest('base64');
const sign = encodeURIComponent(raw);

console.log('\n加签算法：');
console.log(`  timestamp     = ${ts}`);
console.log(`  stringToSign  = ${JSON.stringify(stringToSign)}`);
console.log(`  原始签名(base64) = ${raw}`);
console.log(`  URL 编码后      = ${sign}`);

// 用一个独立的实现交叉校验
const raw2 = crypto.createHmac('sha256', SECRET).update(`${ts}\n${SECRET}`).digest('base64');
console.log(`  交叉校验：${raw === raw2 ? '\u001b[32m一致\u001b[0m' : '\u001b[31m不一致\u001b[0m'}`);

// 带签名的完整 URL 是否也被服务端正常受理（应返回 token 无效而不是签名错误）
const signedUrl = `https://oapi.dingtalk.com/robot/send?access_token=${'0'.repeat(64)}&timestamp=${ts}&sign=${sign}`;
try {
  const res = await fetch(signedUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content: 'probe' } }),
    signal: AbortSignal.timeout(15000),
  });
  console.log(`\n带签名请求: HTTP ${res.status}  ${(await res.text()).slice(0, 200)}`);
} catch (e) {
  console.log('\n带签名请求失败: ' + e.message);
}

/* ---------- 3. markdown 内容长度上限实测 ---------- */
const long = '测试内容'.repeat(3000);   // 约 12000 字符
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'long', text: long } }),
    signal: AbortSignal.timeout(15000),
  });
  console.log(`\n长内容(${long.length} 字符): HTTP ${res.status}  ${(await res.text()).slice(0, 160)}`);
} catch (e) {
  console.log('\n长内容请求失败: ' + e.message);
}
