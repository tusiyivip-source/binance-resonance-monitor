/** 验证零轴回调的 K 线图视图 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9444;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zc-'));
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
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(14000);

  console.log('\n\u001b[36m▌默认进入 K 线图模式\u001b[0m');
  ok('展示方式默认是「K线图」', (await ev(`document.querySelector('#zero-mode').value`)) === 'chart');
  ok('图表容器可见、表格已隐藏',
    await ev(`getComputedStyle(document.querySelector('#zerochartwrap')).display !== 'none' && getComputedStyle(document.querySelector('#tablewrap')).display === 'none'`));

  const g = await ev(`(() => {
    const cards = [...document.querySelectorAll('#zerochartgrid .chartcard')];
    const painted = cards.map(c => {
      const cv = c.querySelector('canvas');
      if (!cv) return 0;
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
      return n;
    });
    return {
      cards: cards.length,
      inited: cards.filter(c => c.querySelector('.tv-lightweight-charts')).length,
      painted,
      head: cards.slice(0, 4).map(c => ({
        lv: c.querySelector('.lv')?.textContent?.trim(),
        roles: c.querySelector('.roles')?.textContent?.trim(),
        st: c.querySelector('.st')?.textContent?.trim(),
        sp: c.querySelector('.sp')?.textContent?.replace(/\\s+/g, ' ').trim(),
        px: c.querySelector('.px')?.textContent?.trim(),
        meta: c.querySelector('.cmeta, .meta, [class*=meta]')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        cls: c.className,
      })),
      live: document.querySelector('#zero-live')?.textContent?.trim(),
    };
  })()`);
  console.log('    卡片 ' + g.cards + ' 张（已初始化 ' + g.inited + '）· 有像素 ' + g.painted.filter(x => x > 0).length + '/' + g.painted.length);
  console.log('    状态栏: ' + g.live);
  for (const h of g.head) console.log('    ' + (h.lv || '') + ' [' + (h.roles || '') + '] ' + (h.st || '') + '  ' + (h.sp || '') + '  ' + (h.meta || ''));
  ok('★ 渲染出 K 线卡片', g.cards > 0, g.cards + ' 张');
  ok('★ 每张卡片都真的画出了内容', g.painted.filter(x => x > 0).length === g.cards, g.painted.filter(x => x > 0).length + '/' + g.cards);
  // 当前布局是「七周期独立监控」：每张卡是一个 (币种 × 级别)，不再是配对
  ok('★ 卡片头显示 币种 + 级别 + 状态',
    /USDT/.test(g.head[0]?.lv || '') && /[分时线日周]/.test(g.head[0]?.roles || '')
    && /^[多空]$/.test(g.head[0]?.st || ''),
    g.head[0] ? g.head[0].lv + ' / ' + g.head[0].roles + ' / ' + g.head[0].st : '无');
  ok('★ 卡片显示靠近零轴程度与多空方向',
    /靠近零轴 \d+(\.\d+)?%/.test(g.head[0]?.meta || '') && /零轴[上下]方/.test(g.head[0]?.meta || ''),
    g.head[0]?.meta || '（meta 为空）');
  ok('★ 卡片头带级别标识（如 #1 · 6时 独立监控）',
    /#\d+ · .*(独立监控|分|时|日)/.test(g.head[0]?.sp || ''), g.head[0]?.sp);
  ok('★ 卡片写明 DIF / DEA',
    /DIF/.test(g.head[0]?.meta || '') && /DEA/.test(g.head[0]?.meta || ''), g.head[0]?.meta || '（meta 为空）');
  ok('排名 + 级别标在副标题', /#\d+ · /.test(g.head[0]?.sp || ''), g.head[0]?.sp);
  ok('多空方向用不同边框区分', g.head.some(h => /mode-zero-long/.test(h.cls)) || g.head.some(h => /mode-zero-short/.test(h.cls)),
    g.head.map(h => (h.cls.match(/mode-zero-\w+/) || [''])[0]).join(','));

  console.log('\n\u001b[36m▌切换到表格再切回\u001b[0m');
  await ev(`(() => { const s = document.querySelector('#zero-mode'); s.value = 'table'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1500);
  const t = await ev(`({
    wrap: getComputedStyle(document.querySelector('#zerochartwrap')).display,
    table: getComputedStyle(document.querySelector('#tablewrap')).display,
    rows: document.querySelectorAll('#body tr').length,
  })`);
  ok('切到表格：表格显示、图表隐藏', t.table !== 'none' && t.wrap === 'none', '行 ' + t.rows);

  await ev(`(() => { const s = document.querySelector('#zero-mode'); s.value = 'chart'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(6000);
  const back = await ev(`document.querySelectorAll('#zerochartgrid .chartcard').length`);
  ok('切回 K 线图：卡片重新渲染', back > 0, back + ' 张');

  console.log('\n\u001b[36m▌其他视图\u001b[0m');
  await ev(`document.querySelector('#tab-alert').click()`); await sleep(5000);
  ok('报警级别K线仍可用', await ev(`getComputedStyle(document.querySelector('#alertchartwrap')).display !== 'none'`));
  await ev(`document.querySelector('#tab-zero').click()`); await sleep(4000);
  ok('回到零轴页仍是图表模式', await ev(`getComputedStyle(document.querySelector('#zerochartwrap')).display !== 'none'`));

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/zero-charts.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/zero-charts.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
