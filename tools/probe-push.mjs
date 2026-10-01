/** 推送通道连通性探测（不依赖任何凭证，只看服务是否可达、报错格式是否可解析） */
const tests = [
  {
    name: '企业微信群机器人',
    url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=00000000-0000-0000-0000-000000000000',
    body: { msgtype: 'text', text: { content: 'probe' } },
    note: '用无效 key 探测：能收到 errcode 说明通道可用（正常应为 93000 无效 key）',
  },
  {
    name: 'Server酱³ (sctapi)',
    url: 'https://sctapi.ftqq.com/SCT0000000000000000000000000000.send',
    body: { title: 'probe', desp: 'probe' },
    form: true,
    note: '正常应返回 code!=0（无效 SendKey）',
  },
  {
    name: 'PushPlus',
    url: 'http://www.pushplus.plus/send',
    body: { token: '00000000000000000000000000000000', title: 'probe', content: 'probe' },
    note: '正常应返回 code!=200（无效 token）',
  },
  {
    name: '企业微信 API 主机',
    url: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=x&corpsecret=x',
    body: null,
    note: '应用消息通道的入口',
  },
];

for (const t of tests) {
  const t0 = Date.now();
  try {
    let res;
    if (!t.body) {
      res = await fetch(t.url, { signal: AbortSignal.timeout(15000) });
    } else if (t.form) {
      res = await fetch(t.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(t.body).toString(),
        signal: AbortSignal.timeout(15000),
      });
    } else {
      res = await fetch(t.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(t.body),
        signal: AbortSignal.timeout(15000),
      });
    }
    const txt = (await res.text()).slice(0, 200);
    console.log(`\u001b[32m✓\u001b[0m ${t.name}  HTTP ${res.status}  ${Date.now() - t0}ms`);
    console.log(`    响应: ${txt}`);
    console.log(`    \u001b[2m${t.note}\u001b[0m`);
  } catch (e) {
    console.log(`\u001b[31m✗\u001b[0m ${t.name}  ${Date.now() - t0}ms  失败: ${e.message}`);
  }
}
