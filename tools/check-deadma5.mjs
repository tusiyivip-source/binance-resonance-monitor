/** 验证新的「零轴上死叉 → 阳K站上 MA5」策略 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEAD_MA5_LEVELS, deadMa5At } from '../src/dead-ma5.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };

/* ---------- 1) 单元：合成数据 ---------- */
{
  const mkS = (o, c) => ({ o, c, h: o.map((x, i) => Math.max(x, c[i])), l: o.map((x, i) => Math.min(x, c[i])), t: o.map((_, i) => i * 900000), ms: 900000 });

  // 构造：一段上涨 → 零轴上死叉 → 连续 6 根阴线 → 第一根阳线
  const o = [], c = [];
  for (let i = 0; i < 20; i++) { o.push(100 + i * 0.2); c.push(100.15 + i * 0.2); }   // 上涨
  const deadAt = o.length;                                                            // 死叉发生在这根
  for (let i = 0; i < 6; i++) { o.push(104 - i * 0.5); c.push(103.7 - i * 0.5); }      // 6 根阴线
  o.push(101.0); c.push(101.6);                                                       // 第一根阳线
  const s = mkS(o, c);
  const n = o.length;

  // 指标：deadAt 处 DIF 下穿 DEA，且两者都 > 0
  const dif = new Array(n).fill(0.4), dea = new Array(n).fill(0.4);
  dif[deadAt - 1] = 0.60; dea[deadAt - 1] = 0.50;   // 死叉前 DIF > DEA
  dif[deadAt] = 0.45; dea[deadAt] = 0.48;           // 死叉：DIF 下穿，且 0.45 > 0（零轴上）
  for (let i = deadAt + 1; i < n; i++) { dif[i] = 0.20; dea[i] = 0.25; }
  const ind = { macd: { dif, dea, hist: new Array(n).fill(0) } };

  const hit = deadMa5At(s, ind, n - 1, { minBars: 5 });
  console.log('  合成数据 →', hit ? '命中（下跌 ' + hit.downBars + ' 根）' : '未命中');
  ok('★ 零轴上死叉 + 连跌 6 根 + 首次收阳 → 命中', !!hit, hit ? hit.downBars + ' 根' : 'null');
  // 死叉那根本身不算「下跌」（下跌是死叉之后才开始的），所以 6 根阴线里算 5 根
  ok('★ 下跌根数正确（死叉后 5 根阴线）', !!hit && hit.downBars === 5, hit ? String(hit.downBars) : '—');
  ok('★ 死叉时 DIF 与 DEA 都在零轴上', !!hit && hit.deadDif > 0 && hit.deadDea > 0,
    hit ? hit.deadDif + ' / ' + hit.deadDea : '—');

  // 下跌不足 5 根
  ok('★ 下跌不足 5 根 → 不命中', deadMa5At(s, ind, n - 3, { minBars: 5 }) === null);

  // 死叉在零轴下
  const dif2 = dif.slice(), dea2 = dea.slice();
  dif2[deadAt] = -0.45; dea2[deadAt] = -0.48;
  ok('★ 死叉在零轴下 → 不命中', deadMa5At(s, { macd: { dif: dif2, dea: dea2, hist: [] } }, n - 1, { minBars: 5 }) === null);

  // 第二根阳线（前一根已经是阳）→ 不命中
  const o3 = o.slice(), c3 = c.slice();
  o3.push(101.6); c3.push(102.2);
  ok('★ 已经是第二根阳线 → 不命中', deadMa5At(mkS(o3, c3), ind, o3.length - 1, { minBars: 5 }) === null);

  // 当前不是阳线
  const o4 = o.slice(), c4 = c.slice();
  c4[n - 1] = o4[n - 1] - 0.3;
  ok('★ 当前不是阳线 → 不命中', deadMa5At(mkS(o4, c4), ind, n - 1, { minBars: 5 }) === null);
}


/* ---------- 2) 接口 ---------- */
const B = 'http://127.0.0.1:8848';
const pz = await (await fetch(B + '/api/pairzero')).json();
console.log('  接口命中: ' + pz.total + ' 条');
ok('★ 接口有信号', pz.total > 0, pz.total + ' 条');
ok('★ 信号都落在监控级别上',
  (pz.items || []).every(x => DEAD_MA5_LEVELS.includes(x.level)),
  [...new Set((pz.items || []).map(x => x.level))].join(' '));
ok('★ A 套「连跌N根」全部 ≥ 5', (pz.items || []).filter(x => x.variant === 'first').every(x => x.downBars >= 5),
  '最小 ' + Math.min(...(pz.items || []).map(x => x.barsSinceDead)));
ok('★ 死叉时 DIF 全部 > 0（零轴上）', (pz.items || []).every(x => x.deadDif > 0));
  ok('★ B 套「零上死叉状态」DIF/DEA 都在零轴上', (pz.items || []).filter(x => x.variant === 'state').every(x => x.dif > 0 && x.dea > 0));
ok('★ 全部做多', (pz.items || []).every(x => x.dir === 'long'));

const g = await (await fetch(B + '/api/pairgrid?bars=120&limit=50')).json();
console.log('  配对全景: ' + g.total + ' 条');
ok('★ 配对全景也切到新策略', (g.items || []).every(x => DEAD_MA5_LEVELS.includes(x.pair.sub)),
  (g.items || []).slice(0, 3).map(x => x.pair.levelLabel).join(' '));

/* ---------- 3) 界面 ---------- */
const PORT = 9741;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dm-'));
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
  await ev(`document.querySelector('#tab-pgrid').click()`);
  await sleep(13000);
  const r = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    return { n: cards.length, info: (cards[0]?.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim() };
  })()`);
  console.log('  全景卡片 ' + r.n + ' 张：' + r.info);
  ok('★ 全景卡片显示级别', /15分|30分|1时|2时|3时|6时|12时/.test(r.info), r.info);
  ok('★ 显示策略标签（下跌N根 / 零上死叉·阳收MA5）', /下跌 \d+ 根|零上死叉·阳收MA5/.test(r.info), r.info);
  ok('★ 显示 MA5', /MA5/.test(r.info), r.info);
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/dead-ma5.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: docs/img/dead-ma5.png');
} catch (e) { console.error('界面校验失败: ' + e.message); fail++; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}

console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
