/** 验证：三个卡片视图 + 全景屏，点固定都不跳位；按刷新才置顶 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9571;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-'));
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
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(24000);

  async function testView(tabSel, gridSel, cardSel, pinBtnSel, refreshSel, label, pinGoesTop) {
    await ev(`localStorage.removeItem('dsh.pinnedCards')`);
    await ev(`location.reload()`);
    await sleep(22000);
    await ev(`document.querySelector('${tabSel}').click()`);
    await sleep(10000);

    const info = await ev(`(() => {
      const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
      if (!cards.length) return null;
      const t = cards[Math.min(cards.length - 1, 3)];   // 取靠后的一个
      const idx = cards.indexOf(t);
      const id = t.dataset.pinId || t.dataset.pgId;
      const sym = (t.querySelector('.lv') || t.querySelector('.pg-sym'))?.textContent?.trim();
      const btn = t.querySelector('${pinBtnSel}');
      if (!btn) return { noBtn: true };
      btn.click();
      return { id, sym, idx, total: cards.length };
    })()`);
    if (!info || info.noBtn) { ok(label + '：找到图钉按钮', false, info ? '无按钮' : '无卡片'); return; }

    await sleep(2500);
    const a = await ev(`(() => {
      const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
      const i = cards.findIndex(c => (c.dataset.pinId||c.dataset.pgId) === ${JSON.stringify(info.id)});
      return { idx: i, pinned: cards[i]?.classList.contains('pinned'),
        firstSame: i === 0 };
    })()`);
    if (pinGoesTop) {
      ok(label + '：点固定后会排到最前（全景固定优先）', a.idx === 0, '原第 ' + (info.idx + 1) + ' → 现第 ' + (a.idx + 1));
    } else {
      ok(label + '：点固定后位置不变', a.idx === info.idx, '原第 ' + (info.idx + 1) + ' → 现第 ' + (a.idx + 1));
    }
    ok(label + '：固定标记生效', a.pinned === true);

    await sleep(7000);   // 等一轮轮询
    const b = await ev(`(() => {
      const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
      return cards.findIndex(c => (c.dataset.pinId||c.dataset.pgId) === ${JSON.stringify(info.id)});
    })()`);
    if (pinGoesTop) {
      ok(label + '：轮询后仍在最前', b === 0, '第 ' + (b + 1) + ' 个');
    } else {
      ok(label + '：轮询一次后仍不跳位', b === info.idx, '第 ' + (b + 1) + ' 个');
    }

    const rf = await ev(`!!document.querySelector('${refreshSel}')`);
    if (rf) {
      await ev(`document.querySelector('${refreshSel}').click()`);
      await sleep(7000);
      const c = await ev(`(() => {
        const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
        return cards.findIndex(c => (c.dataset.pinId||c.dataset.pgId) === ${JSON.stringify(info.id)});
      })()`);
      ok(label + '：按刷新后跑到第 1 位', c === 0, '第 ' + (c + 1) + ' 个');
    }
  }

  console.log('\n\u001b[36m▌配对监控（卡片版）\u001b[0m');
  await testView('#tab-zero', '#pairchartgrid', '.chartcard', '.pinbtn', '#zero-refresh', '配对监控');

  console.log('\n\u001b[36m▌单K回踩不破\u001b[0m');
  await testView('#tab-single', '#singlechartgrid', '.chartcard', '.pinbtn', '#single-refresh', '单K');

  console.log('\n\u001b[36m▌配对全景\u001b[0m');
  await testView('#tab-pgrid', '#pggrid', '.pgcard', '.pg-act[data-act="pin"]', '#pg-refresh', '全景屏', true);

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
