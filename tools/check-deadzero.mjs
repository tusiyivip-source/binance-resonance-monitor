import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9751;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-z-'));
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

  // 配对全景
  await ev(`document.querySelector('#tab-pgrid').click()`);
  await sleep(13000);
  const g = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    const infos = cards.map(c => (c.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim());
    const nums = infos.map(t => { const m = t.match(/死叉 DIF (-?[\\d.]+)/); return m ? Number(m[1]) : null; }).filter(x => x !== null);
    return { n: cards.length, infos: infos.slice(0,2), checked: nums.length, negative: nums.filter(x => x <= 0).length };
  })()`);
  console.log('  全景卡片 ' + g.n + ' 张');
  for (const s of g.infos) console.log('    ' + s);
  if (g.n === 0) {
    // 重启后报警历史清空，要等下一根K线收盘才会产生——这时改校验接口层
    const api = await (await fetch('http://127.0.0.1:8848/api/pairzero')).json();
    const ds = (api.items || []).map(x => x.deadDif);
    console.log('    （全景暂无卡片，改校验接口：' + ds.length + ' 条）');
    ok('★ 死叉DIF 全部为正（零轴上方）', ds.length > 0 && ds.every(v => v > 0), '负数 ' + ds.filter(v => v <= 0).length);
    ok('★ 全景卡片文案（接口侧字段齐全）', (api.items || []).every(x => x.levelLabel && x.ma5 != null), 'ok');
  } else {
    ok('★ 卡片显示「死叉 DIF / DEA」', /死叉 DIF/.test(g.infos[0] || '') && /\/ DEA/.test(g.infos[0] || ''), g.infos[0]);
    ok('★ 死叉DIF 全部为正（零轴上方）', g.checked > 0 && g.negative === 0, g.checked + ' 个，负数 ' + g.negative);
  }

  // 配对监控
  await ev(`document.querySelector('#tab-zero').click()`);
  await sleep(13000);
  const z = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pairchartgrid .chartcard')];
    const metas = cards.map(c => (c.querySelector('[class*=meta]')?.textContent||'').replace(/\\s+/g,' ').trim());
    const nums = metas.map(t => { const m = t.match(/死叉 DIF (-?[\\d.]+)\\s*\\/\\s*DEA (-?[\\d.]+)/); return m ? Number(m[1]) : null; }).filter(x => x !== null);
    return { n: cards.length, first: metas[0] || '', checked: nums.length, negative: nums.filter(x => x <= 0).length };
  })()`);
  console.log('  监控卡片 ' + z.n + ' 张：' + z.first);
  ok('★ 监控卡片标出「死叉 DIF / DEA」', /死叉 DIF [-\d.]+ \/ DEA [-\d.]+/.test(z.first), z.first);
  ok('★ 该 DIF 全部为正', z.checked > 0 && z.negative === 0, z.checked + ' 个，负数 ' + z.negative);
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/dead-zero.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: docs/img/dead-zero.png');
} catch (e) { console.error('失败: ' + e.message); fail++; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}

console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
