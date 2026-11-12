/** 验证「报警级别K线」已拆干净，其余三屏正常 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9641;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rm-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 60000); }); };
const ev = async expr => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval');
  return r.result.value;
};
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 260));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(24000);

  const info = await ev(`(() => ({
    tabs: [...document.querySelectorAll('button[id^="tab-"]')].map(b => ({ id: b.id, text: b.textContent.trim() })),
    hasAlertTab: !!document.querySelector('#tab-rev'),
    hasAlertGrid: !!document.querySelector('#alertchartgrid'),
    hasAlertWrap: !!document.querySelector('#alertchartwrap'),
    hasAlertSymbar: !!document.querySelector('#alert-symbar'),
    hasAlertLive: !!document.querySelector('#alert-live'),
    bodyHasAlertClass: document.body.classList.contains('alertchartmode'),
    hasView: typeof VIEWS !== 'undefined' ? Object.keys(VIEWS) : null,
  }))()`);
  console.log('  标签: ' + info.tabs.map(t => t.text).join(' | '));
  ok('★ 五个标签页齐全', info.tabs.length === 5, info.tabs.length + ' 个');
  ok('★ 「报警级别K线」标签已恢复', info.hasAlertTab);
  ok('★ 旧 #alertchartgrid 不再使用（改用 #revgrid）', !info.hasAlertGrid);
  ok('★ 旧 #alertchartwrap 不再使用（改用 #view-rev）', !info.hasAlertWrap);
  ok('★ 旧 #alert-symbar / #alert-live 已移除', !info.hasAlertSymbar && !info.hasAlertLive);
  ok('★ VIEWS 里是 rev 而不是 alert', Array.isArray(info.hasView) && info.hasView.includes('rev') && !info.hasView.includes('alert'), String(info.hasView));

  // 三个标签页逐个点一遍
  for (const [sel, name, gridSel] of [['#tab-zero', '配对监控', '#pairchartgrid'], ['#tab-single', '单K回踩不破', '#singlechartgrid'], ['#tab-pgrid', '配对全景', '#pggrid']]) {
    await ev(`document.querySelector('${sel}').click()`);
    await sleep(9000);
    const r = await ev(`(() => {
      const g = document.querySelector('${gridSel}');
      return { exists: !!g, cards: g ? g.children.length : 0,
        on: document.querySelector('${sel}').classList.contains('on'),
        bodyCls: document.body.className };
    })()`);
    ok(`${name}：标签可切换且渲染正常`, r.exists && r.on && r.cards > 0, r.cards + ' 张卡片');
  }

  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/tabs-3.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/tabs-3.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
