/** 验证「背驰50%」标签页 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9681;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-half-'));
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
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 260));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(22000);

  const tabs = await ev(`[...document.querySelectorAll('button[id^="tab-"]')].map(b => b.textContent.trim())`);
  console.log('  标签: ' + tabs.join(' | '));
  ok('★ 五个标签页都在', tabs.length === 5, tabs.length + ' 个');

  await ev(`document.querySelector('#tab-half').click()`);
  await sleep(13000);

  const s = await ev(`(() => {
    const g = document.querySelector('#halfgrid');
    const cards = [...g.querySelectorAll('.pgcard')];
    return {
      visible: getComputedStyle(document.querySelector('#view-half')).display,
      revHidden: getComputedStyle(document.querySelector('#view-rev')).display,
      n: cards.length,
      first: {
        sym: cards[0]?.querySelector('.pg-sym')?.textContent?.trim(),
        info: (cards[0]?.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120),
        canvas: !!cards[0]?.querySelector('canvas'),
        hasPin: !!cards[0]?.querySelector('[data-act="pin"]'),
      },
      live: document.querySelector('#half-live')?.textContent?.trim().slice(0,110),
      axisBtns: [...document.querySelectorAll('#half-axis [data-axis]')].length,
      modeBtns: [...document.querySelectorAll('#half-mode [data-mode]')].length,
    };
  })()`);
  console.log('    视图=' + s.visible + '  反转页=' + s.revHidden + '  卡片=' + s.n);
  console.log('    首张: ' + s.first.sym + '  ' + s.first.info);
  console.log('    统计: ' + s.live);
  ok('★ 标签页可见、其它页隐藏', s.visible === 'flex' && s.revHidden === 'none');
  ok('★ 渲染出卡片', s.n > 0, s.n + ' 张');
  ok('★ 卡片有K线画布', s.first.canvas === true);
  ok('★ 底部显示「笔 N 根」', /笔 \d+ 根/.test(s.first.info), s.first.info);
  ok('★ 底部显示 50% 价位', /50% [\d.]+/.test(s.first.info), s.first.info);
  ok('★ 底部标明提醒类型', /背驰50%|反弹50%|回落50%/.test(s.first.info), s.first.info);
  ok('★ 有图钉按钮', s.first.hasPin === true);
  ok('★ 零轴筛选按钮齐全', s.axisBtns === 3, s.axisBtns + ' 个');
  ok('★ 提醒方式筛选按钮齐全', s.modeBtns === 3, s.modeBtns + ' 个');

  // 所有卡片的笔根数 >= 5
  const all = await ev(`(() => {
    const cards=[...document.querySelectorAll('#halfgrid .pgcard')];
    const nums = cards.map(c => {
      const m = (c.querySelector('.pg-info')?.textContent||'').match(/笔 (\\d+) 根/);
      return m ? Number(m[1]) : null;
    }).filter(x => x !== null);
    return { n: cards.length, checked: nums.length, min: nums.length ? Math.min(...nums) : null };
  })()`);
  ok('★ 所有卡片「笔」根数都 ≥ 5', all.checked > 0 && all.min >= 5, '最小 ' + all.min + '（' + all.checked + '/' + all.n + '）');

  // 零轴上筛选
  await ev(`document.querySelector('#half-axis [data-axis="above"]').click()`);
  await sleep(9000);
  const up = await ev(`(() => {
    const cards=[...document.querySelectorAll('#halfgrid .pgcard')];
    return { n: cards.length, shorts: cards.filter(c=>c.classList.contains('pg-short')).length };
  })()`);
  ok('★ 「零轴上(多)」筛选后没有看空卡片', up.shorts === 0, up.n + ' 张，看空 ' + up.shorts);

  await ev(`document.querySelector('#half-axis [data-axis="all"]').click()`);
  await sleep(6000);
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/half-grid.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/half-grid.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
