/** 验证「多级别零轴回调」界面：标签存在、矩阵已移除、表格渲染出格子和高亮 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9411;
const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zero-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 90000); }); };
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
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  await sleep(12000);
  // 零轴页默认是 K 线图模式，这里测的是表格，先切过去
  await ev(`(() => { const s = document.querySelector('#zero-mode'); if (s) { s.value = 'table'; s.dispatchEvent(new Event('change')); } })()`);
  await sleep(2500);

  console.log('\n\u001b[36m▌界面结构\u001b[0m');
  const tabs = await ev(`[...document.querySelectorAll('.viewtabs .vt')].map(b => b.id + ':' + b.textContent.trim())`);
  console.log('    ' + tabs.join('  |  '));
  ok('旧「多级别矩阵」标签已移除', !(await ev(`!!document.querySelector('#tab-matrix')`)));
  ok('新「多级别零轴回调」标签存在', await ev(`!!document.querySelector('#tab-zero')`), await ev(`document.querySelector('#tab-zero')?.textContent.trim()`));
  ok('筛选控件齐备（方向 / 靠近程度）',
    await ev(`!!document.querySelector('#f-side') && !!document.querySelector('#f-near')`));

  console.log('\n\u001b[36m▌表格渲染（配对视图）\u001b[0m');
  const r = await ev("(() => {" +
    "const rows=[...document.querySelectorAll('#body tr')];" +
    "const td=(n)=>rows.map(tr=>tr.children[n]).filter(Boolean);" +
    "const head=[...document.querySelectorAll('#head th')].map(t=>t.textContent.trim());" +
    "const pairs=td(2).map(c=>c.textContent.trim()).filter(Boolean);" +
    "const dirs=td(3).map(c=>c.textContent.trim()).filter(Boolean);" +
    "const nears=td(4).map(c=>c.textContent.trim()).filter(Boolean);" +
    "return {rows:rows.length, cols:head.length, head:head," +
    " pairs: pairs.slice(0,4), pairCount: pairs.length," +
    " dirs: dirs.slice(0,4), dirCount: dirs.length," +
    " nears: nears.slice(0,4), nearCount: nears.length," +
    " empty: document.querySelector('#empty')?.style.display !== 'none'};" +
  "})()");
  console.log('    表头(' + r.cols + '列): ' + r.head.join(' | '));
  console.log('    行 ' + r.rows + ' · 配对 ' + r.pairCount + ' · 方向 ' + r.dirCount + ' · 靠近 ' + r.nearCount);
  console.log('    样例配对: ' + r.pairs.join('  '));
  console.log('    样例方向: ' + r.dirs.join('  '));
  console.log('    样例靠近: ' + r.nears.join('  '));
  ok('表格渲染出配对行', r.rows > 0, r.rows + ' 行');
  ok('表头是独立周期口径（含 独立周期 / 靠近零轴 / 持续根数）',
    /独立周期/.test(r.head.join('')) && /靠近零轴/.test(r.head.join('')) && /持续根数/.test(r.head.join('')),
    r.head.join(' | '));
  ok('★ 每行都有周期标识（如 6时 / 30分）',
    r.pairCount === r.rows && r.pairs.every(p => /^\d+(分|时|日|周)$/.test(p)),
    r.pairs.join(' '));
  ok('★ 每行都有方向（多/空）',
    r.dirCount === r.rows && r.dirs.every(d => d === '多' || d === '空'),
    r.dirs.join(' '));
  ok('★ 每行都有靠近零轴程度（百分比）',
    r.nearCount === r.rows && r.nears.every(x => /^\d+(\.\d+)?%$/.test(x)),
    r.nears.join(' '));

  // 接口交叉核对：前端行数应等于接口返回的 items 条数
  const api = await (await fetch('http://127.0.0.1:8848/api/zeroaxis')).json();
  ok('前端行数与接口 items 条数一致',
    r.rows === (api.items || []).length,
    r.rows + ' / 接口 ' + (api.items || []).length);
  ok('接口返回 7 个监控级别',
    (api.levels || []).length === 7,
    (api.levels || []).join(' '));


  console.log('\n\u001b[36m▌筛选交互\u001b[0m');
  const beforeN = await ev(`document.querySelectorAll('#body tr').length`);
  await ev(`(() => { const s = document.querySelector('#f-side'); s.value = 'long'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1500);
  const onlyLong = await ev(`(() => { const d=[...document.querySelectorAll('#body tr')].map(tr=>tr.children[3]?.textContent.trim()).filter(Boolean); return {n:d.length, allLong:d.every(x=>x==='多')}; })()`);
  ok('★ 按方向筛选（只看多）只留多头配对', onlyLong.n > 0 && onlyLong.allLong, onlyLong.n + ' 行，全部为多=' + onlyLong.allLong);
  await ev(`(() => { const s = document.querySelector('#f-side'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  const backAll = await ev(`document.querySelectorAll('#body tr').length`);
  ok('切回「全部」行数恢复', backAll >= onlyLong.n, onlyLong.n + ' → ' + backAll);

  console.log('\n\u001b[36m▌其他视图仍可用\u001b[0m');
  ok('K线图标签已移除', !(await ev(`!!document.querySelector('#tab-multi')`)));
  await ev(`document.querySelector('#tab-single').click()`); await sleep(9000);
  const singleCards = await ev(`document.querySelectorAll('#singlechartgrid .chartcard').length`);
  ok('单K回踩不破视图正常', singleCards > 0, singleCards + ' 张');
  await ev(`document.querySelector('#tab-zero').click()`); await sleep(2000);
  const back = await ev(`document.querySelectorAll('#body tr').length`);
  ok('切回零轴视图正常', back > 0, back + ' 行');

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/zero-axis.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/zero-axis.png');

  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
