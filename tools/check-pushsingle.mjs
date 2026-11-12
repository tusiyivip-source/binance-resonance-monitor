/** 验证钉钉只推单K不破 */
import fs from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };

const B = 'http://127.0.0.1:8848';
const s = await (await fetch(B + '/api/stats')).json();
const c = s.engine.cfg || {};

console.log('  推送开关：');
console.log('    singleKAlertEnabled  = ' + c.singleKAlertEnabled);
console.log('    pairZeroAlertEnabled = ' + c.pairZeroAlertEnabled);
console.log('    zeroAlertEnabled     = ' + c.zeroAlertEnabled);

ok('★ 单K不破推送已开启', c.singleKAlertEnabled === true);
ok('★ 配对（次级别回踩/主级别零轴）推送已关闭', c.pairZeroAlertEnabled === false);
ok('★ 零轴配对推送保持关闭', c.zeroAlertEnabled === false);

/* 源码层面确认三个 sweep 都按开关短路 */
const src = fs.readFileSync('src/engine.js', 'utf8');
ok('★ singleKAlertSweep 有开关判断', src.includes('if (this.cfg.singleKAlertEnabled === false) return;'));
// 配对不再「整段短路」：报警照常生成（配对全景要用），只是打 noPush 不推钉钉
ok('★ pairZero 报警仍会生成（不整体短路）', !src.includes('if (this.cfg.pairZeroAlertEnabled === false) return;'));
ok('★ pairZero 报警带 noPush 标记（不推钉钉）', src.includes('noPush: this.cfg.pairZeroAlertEnabled === false'));
ok('★ server 按 noPush 跳过推送', fs.readFileSync('server.js', 'utf8').includes('if (!alert.noPush) pusher.push(alert);'));
ok('★ zeroAlertSweep 有开关判断', src.includes('if (this.cfg.zeroAlertEnabled === false) return;'));

/* 单K报警也要带上级确认 */
ok('★ 单K报警带上「上级确认」信息', src.includes('confirm: conf,'));
ok('★ 单K只扫做多那一支', src.includes('singleKLongOnly'));

/* 推送文案里能看到确认行 */
const push = fs.readFileSync('src/push.js', 'utf8');
ok('★ 推送文案会写「确认 X 金叉 ✓ 同向」', push.includes('确认 ${a.confirm.label}'));

/* 最近的推送日志里不该再出现配对/零轴 */
const log = fs.readFileSync('data/service.log', 'utf8');
const tail = log.split('\n').slice(-400).join('\n');
const pairPushed = /\[push\].*(配对|零轴配对)/.test(tail);
ok('最近日志里没有配对/零轴的推送记录', !pairPushed, pairPushed ? '仍有配对推送' : '无');

console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
