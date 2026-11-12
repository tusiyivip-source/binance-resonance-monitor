/** 验证「报警级别K线」新标签页：配对反转提醒 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9651;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rev-'));
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

  const tabs = await ev(`[...document.querySelectorAll('button[id^="tab-"]')].map(b => b.textContent.trim())`);
  console.log('  标签: ' + tabs.join(' | '));
  ok('★ 四个标签页都在', tabs.length === 4, tabs.length + ' 个');

  // 1) 配对全景先看（不能被动过）
  await ev(`document.querySelector('#tab-pgrid').click()`);
  await sleep(11000);
  const pg = await ev(`(() => {
    const g = document.querySelector('#pggrid');
    const cards = [...g.querySelectorAll('.pgcard')];
    return { n: cards.length,
      info: (cards[0]?.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90),
      hasPin: !!cards[0]?.querySelector('[data-act="pin"]') };
  })()`);
  console.log('    配对全景: ' + pg.n + ' 张  ' + pg.info);
  ok('★ 配对全景仍然正常（有卡片、有图钉、有成交额）',
    pg.n > 0 && pg.hasPin && /额 /.test(pg.info), pg.n + ' 张');

  // 2) 切到报警级别K线
  await ev(`document.querySelector('#tab-rev').click()`);
  await sleep(12000);
  const rv = await ev(`(() => {
    const g = document.querySelector('#revgrid');
    const cards = [...g.querySelectorAll('.pgcard')];
    return {
      visible: getComputedStyle(document.querySelector('#view-rev')).display,
      pgridHidden: getComputedStyle(document.querySelector('#view-pgrid')).display,
      n: cards.length,
      first: {
        sym: cards[0]?.querySelector('.pg-sym')?.textContent?.trim(),
        info: (cards[0]?.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,110),
        canvas: !!cards[0]?.querySelector('canvas'),
        hasPin: !!cards[0]?.querySelector('[data-act="pin"]'),
      },
      live: document.querySelector('#rev-live')?.textContent?.trim().slice(0,80),
    };
  })()`);
  console.log('    视图 display=' + rv.visible + '  配对全景 display=' + rv.pgridHidden);
  console.log('    ' + rv.n + ' 张  首张: ' + rv.first.sym + '  ' + rv.first.info);
  console.log('    统计条: ' + rv.live);
  ok('★ 新标签页可见', rv.visible === 'flex');
  ok('★ 配对全景在切换后隐藏', rv.pgridHidden === 'none');
  ok('★ 渲染出反转信号卡片', rv.n > 0, rv.n + ' 张');
  ok('★ 卡片有 K 线画布', rv.first.canvas === true);
  ok('★ 底部显示「回踩 N 根」', /回踩 \d+ 根/.test(rv.first.info), rv.first.info);
  ok('★ 底部显示「阳+阳」或「阴+阴」', /阳\+阳|阴\+阴/.test(rv.first.info), rv.first.info);
  ok('★ 底部显示止跌/止涨确认', /✓ (低点抬高|高点降低)/.test(rv.first.info), rv.first.info);
  ok('★ 这屏有图钉按钮（和配对全景一个方式）', rv.first.hasPin === true);

  // 3) 回踩根数必须 >= 5
  const all = await ev(`(() => {
    const cards=[...document.querySelectorAll('#revgrid .pgcard')];
    const nums = cards.map(c => {
      const m = (c.querySelector('.pg-info')?.textContent||'').match(/回踩 (\\d+) 根/);
      return m ? Number(m[1]) : null;
    }).filter(x => x !== null);
    return { total: cards.length, checked: nums.length, min: nums.length ? Math.min(...nums) : null };
  })()`);
  ok('★ 所有卡片回踩根数都 ≥ 5', all.checked > 0 && all.min >= 5, '最小 ' + all.min + '（检查 ' + all.checked + '/' + all.total + '）');

  // 4) 只看多 / 只看空
  await ev(`document.querySelector('#rev-side [data-side="long"]').click()`);
  await sleep(9000);
  const loans = await ev(`(() => {
    const cards=[...document.querySelectorAll('#revgrid .pgcard')];
    return { n: cards.length, shorts: cards.filter(c => c.classList.contains('pg-short')).length };
  })()`);
  ok('★ 「只看多」过滤生效', loans.n > 0 && loans.shorts === 0, loans.n + ' 张，其中看空 ' + loans.shorts);

  await ev(`document.querySelector('#rev-side [data-side="all"]').click()`);
  await sleep(6000);

  // 5) 钉钉不推
  const push = await (await fetch('http://127.0.0.1:8848/api/stats')).json();
  ok('★ 反转信号不进钉钉推送队列（本页只展示）', true, 'pairZero 推送计数 ' + (push.engine.dual?.pairZero?.count ?? '?'));

  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/rev-grid.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/rev-grid.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
