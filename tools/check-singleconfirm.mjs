import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9721;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-conf-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m)); } }, 60000); }); };
const ev = async e => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval');
  return r.result.value;
};
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };

/* 先用接口校验规则本身 */
const api = await (await fetch('http://127.0.0.1:8848/api/singlekchart?bars=120&limit=200')).json();
const items = api.items || [];
const map = { '15分': '2时', '30分': '3时', '1时': '6时', '2时': '12时', '3时': '日线', '4时': '日线', '6时': '日线' };
let badCross = 0, badDir = 0, noConf = 0;
for (const it of items) {
  const s = it.single || {};
  if (!s.confirm) { noConf++; continue; }
  const isUp = (s.side || 'long') === 'long';
  const golden = s.confirm.dif > s.confirm.dea;
  if (isUp !== golden) badDir++;
  if (!s.confirm.agree) badCross++;
}
console.log('  接口 ' + items.length + ' 条：缺确认 ' + noConf + '，方向不符 ' + badDir + '，交叉不符 ' + badCross);
ok('★ 每条都有上级确认信息', noConf === 0 && items.length > 0, noConf + ' 条缺失');
ok('★ 做多都是金叉、做空都是死叉', badDir === 0, badDir + ' 条不符');
ok('★ confirm.agree 全部为真', badCross === 0, badCross + ' 条不符');

/* 界面校验 */
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(22000);
  await ev(`document.querySelector('#tab-single').click()`);
  await sleep(13000);

  const r = await ev(`(() => {
    const cards=[...document.querySelectorAll('#singlechartgrid .chartcard')];
    const confs = cards.map(c => (c.querySelector('.sk-conf')?.textContent||'').replace(/\\s+/g,' ').trim());
    return { n: cards.length, withConf: confs.filter(Boolean).length, sample: confs.filter(Boolean).slice(0,3) };
  })()`);
  console.log('  卡片 ' + r.n + ' 张，带确认行 ' + r.withConf);
  for (const s of r.sample) console.log('    ' + s);
  ok('★ 每张卡片底部都显示上级确认', r.n > 0 && r.withConf === r.n, r.withConf + '/' + r.n);
  ok('★ 确认行含「金叉/死叉 ✓ 同向」', /金叉|死叉/.test(r.sample[0] || '') && /同向/.test(r.sample[0] || ''), r.sample[0]);
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/single-confirm.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/single-confirm.png');
} catch (e) { console.error('界面校验失败: ' + e.message); fail++; }

console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
try { ws?.close(); } catch { }
try { child.kill(); } catch { }
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
