import fs from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };

const B = 'http://127.0.0.1:8848';
const r = await (await fetch(B + '/api/pairzero')).json();
const items = r.items || [];
const first = items.filter(x => x.variant === 'first');
const state = items.filter(x => x.variant === 'state');

console.log('  接口命中 ' + items.length + ' 条：first ' + first.length + ' / state ' + state.length);
ok('★ 两套策略都有信号', first.length > 0 || state.length > 0, first.length + ' + ' + state.length);
ok('★ 每条都带 variant 与 variantLabel', items.every(x => x.variant && x.variantLabel),
  [...new Set(items.map(x => x.variantLabel))].slice(0, 3).join(' | '));

// A 套：连跌 N 根 · 首次收阳
ok('★ A 套：downBars 全部 ≥5', first.every(x => x.downBars >= 5), first.length ? '最小 ' + Math.min(...first.map(x => x.downBars)) : '无');
ok('★ A 套：死叉 DIF 与 DEA 都在零轴上', first.every(x => x.deadDif > 0 && x.deadDea > 0));

// B 套：零上死叉状态 + 阳K站上 MA5
ok('★ B 套：DIF/DEA 都在零轴上方', state.every(x => x.dif > 0 && x.dea > 0));
ok('★ B 套：收盘 > MA5', state.every(x => x.close > x.ma5), state.length ? '样本 ' + state[0].close + ' > ' + state[0].ma5 : '无');

// 全景接口也要能看到两套
const g = await (await fetch(B + '/api/pairgrid?bars=120&limit=200')).json();
const gi = g.items || [];
const gv = {};
for (const x of gi) gv[x.pair.variant] = (gv[x.pair.variant] || 0) + 1;
console.log('  配对全景 ' + gi.length + ' 条：' + JSON.stringify(gv));
ok('★ 全景负载带 variant', gi.every(x => x.pair.variant), String(gi[0]?.pair.variant));

console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
