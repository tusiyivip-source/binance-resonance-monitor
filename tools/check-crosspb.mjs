import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9901;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cg-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m)); } }, 60000); }); };
const ev = async e => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || String(r.exceptionDetails.text)).slice(0, 300) };
  return r.result.value;
};
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(22000);

  const tabs = await ev(`[...document.querySelectorAll('button[id^="tab-"]')].map(b => b.textContent.trim())`);
  console.log('  标签: ' + tabs.join(' | '));
  ok('★ 「阳内阴回踩」标签已加上', tabs.some(t => t.includes('阳内阴')), tabs.length + ' 个');

  await ev(`document.querySelector('#tab-cg').click()`);
  await sleep(16000);

  const r = await ev(`(() => {
    const g = document.querySelector('#cggrid');
    const cards = [...g.querySelectorAll('.pgcard')];
    const named = cards.filter(c => c.querySelector('.pg-sym')?.textContent?.trim());
    return {
      visible: getComputedStyle(document.querySelector('#view-cg')).display,
      n: cards.length, named: named.length,
      first: (cards[0]?.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim(),
      axisBtns: document.querySelectorAll('#cg-axis [data-axis]').length,
      depthBtns: document.querySelectorAll('#cg-depth [data-depth]').length,
      live: document.querySelector('#cg-live')?.textContent?.trim().slice(0,80),
    };
  })()`);
  console.log('  卡片 ' + r.n + ' 张（有内容 ' + r.named + '）');
  console.log('    首张: ' + r.first);
  console.log('    统计: ' + r.live);
  ok('★ 页面可见', r.visible === 'flex');
  ok('★ 卡片渲染', r.n > 0 && r.named === r.n, r.named + '/' + r.n);
  ok('★ 显示级别', /(15分|30分|1时|2时|3时|4时|6时|12时)/.test(r.first), r.first);
  ok('★ 显示零轴上/下金叉筛选结果', /零轴上|零轴下|跨零轴/.test(r.first), r.first);
  ok('★ 显示形态（阳内阴）', /阳内阴|阴内阳|双阳包阴|双阴包阳/.test(r.first), r.first);
  ok('★ 零轴筛选栏 3 个按钮', r.axisBtns === 3, String(r.axisBtns));
  ok('★ 只剩零轴 + 级别两个筛选栏', !r.depthBtns, '回踩栏已删除');

  // 切到「零轴下」应全部是零轴下
  await ev(`document.querySelector('#cg-axis [data-axis="below"]').click()`);
  await sleep(11000);
  const r2 = await ev(`(() => {
    const cards=[...document.querySelectorAll('#cggrid .pgcard')];
    const infos = cards.map(c => (c.querySelector('.pg-info')?.textContent||''));
    return { n: cards.length, allBelow: infos.every(t => /零轴下/.test(t)), sample: infos[0]?.replace(/\\s+/g,' ').trim() };
  })()`);
  console.log('  零轴下: ' + r2.n + ' 张  ' + (r2.sample||''));
  ok('★ 切到「零轴下」全部生效', r2.n > 0 && r2.allBelow, r2.n + ' 张');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/cross-pb.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: docs/img/cross-pb.png');
} catch (e) { console.error('失败: ' + e.message); fail++; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
