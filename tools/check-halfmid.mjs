import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9701;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mid-'));
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
  await ev(`document.querySelector('#tab-half').click()`);
  await sleep(13000);

  const r = await ev(`(() => {
    const cards=[...document.querySelectorAll('#halfgrid .pgcard')];
    const shown = cards.map(c => {
      const chip = c.querySelector('.hg-mid');
      if (!chip) return null;
      return { text: chip.textContent.trim(), top: chip.style.top, display: chip.style.display };
    }).filter(Boolean);
    const visible = shown.filter(x => x.display !== 'none' && x.top);
    return { cards: cards.length, chips: shown.length, visible: visible.length,
      sample: visible.slice(0, 3),
      firstInfo: (cards[0]?.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim() };
  })()`);
  console.log('  卡片 ' + r.cards + '，有标签 ' + r.chips + '，可见 ' + r.visible);
  for (const s of r.sample) console.log('    ' + s.text + '  top=' + s.top);
  console.log('  首张底部: ' + r.firstInfo);
  ok('★ 每张卡片都有 50% 价位标签', r.chips === r.cards, r.chips + '/' + r.cards);
  ok('★ 标签都已定位（有 top 坐标）', r.visible > 0 && r.visible === r.chips, r.visible + ' 可见');
  ok('★ 标签文字是「50% + 价位」', /^50% [\d.]+/.test(r.sample[0]?.text || ''), r.sample[0]?.text);
  ok('★ 标签与底部 50% 价格一致',
    (r.sample[0]?.text || '').includes((r.firstInfo.match(/50% ([\d.]+)/) || [])[1] || '###'),
    r.sample[0]?.text + '  vs  ' + (r.firstInfo.match(/50% ([\d.]+)/) || [])[1]);

  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/half-midlabel.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/half-midlabel.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
