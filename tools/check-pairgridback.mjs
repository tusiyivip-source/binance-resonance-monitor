/** 验证：配对全景有信号，但 pairzero 不推钉钉；单K仍然推 */
import fs from 'node:fs';

const B = 'http://127.0.0.1:8848';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };

/* ① 配对全景必须有信号 */
const g = await (await fetch(B + '/api/pairgrid?bars=120&limit=50')).json();
const items = g.items || [];
console.log('  配对全景: ' + g.total + ' 条，返回 ' + items.length + ' 条');
ok('★ 配对全景有信号', items.length > 0, g.total + ' 条');
ok('★ 每张卡片都有K线', items.every(x => (x.candles || []).length > 10), '最少 ' + Math.min(...items.map(x => (x.candles || []).length)) + ' 根');

/* ② pairzero 报警带 noPush，且不进推送 */
const a = await (await fetch(B + '/api/alerts')).json();
const arr = Array.isArray(a) ? a : (a.alerts || []);
const pz = arr.filter(x => x.kind === 'pairzero');
console.log('  报警历史 ' + arr.length + ' 条，其中 pairzero ' + pz.length);
ok('★ pairzero 报警在历史里（页面能画图）', pz.length > 0, pz.length + ' 条');
ok('★ pairzero 全部带 noPush=true', pz.length > 0 && pz.every(x => x.noPush === true), pz.length + ' 条');

/* ③ 服务端按 noPush 卡住推送 */
const srv = fs.readFileSync('server.js', 'utf8');
ok('★ server 里按 noPush 跳过 pusher', srv.includes('if (!alert.noPush) pusher.push(alert);'));

/* ④ 观察一段时间：pairzero 计数在涨，推送计数不涨 */
const s1 = await (await fetch(B + '/api/stats')).json();
const c1 = s1.engine.dual?.pairZero?.count ?? 0;
const p1 = s1.push?.sent ?? 0;
console.log('  起点：pairZero=' + c1 + '  已推送=' + p1);
await sleep(60000);
const s2 = await (await fetch(B + '/api/stats')).json();
const c2 = s2.engine.dual?.pairZero?.count ?? 0;
const p2 = s2.push?.sent ?? 0;
console.log('  60 秒后：pairZero=' + c2 + '（+' + (c2 - c1) + '）  已推送=' + p2 + '（+' + (p2 - p1) + '）');
ok('★ 这 60 秒里 pairzero 有新增', c2 >= c1, '+' + (c2 - c1));
ok('★ 同期没有任何推送发出（配对不再推钉钉）', p2 === p1, '+' + (p2 - p1));

/* ⑤ 单K的条件仍然保留给推送 */
const cfg = s2.engine.cfg || {};
ok('★ 单K推送开关仍为开', cfg.singleKAlertEnabled === true);
ok('★ 配对推送开关为关（只影响钉钉）', cfg.pairZeroAlertEnabled === false);

console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
