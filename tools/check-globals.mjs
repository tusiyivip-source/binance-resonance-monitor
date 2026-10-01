/**
 * 跨脚本顶层符号冲突检查。
 *
 * 为什么需要它：app.js 与 chart.js 都是 classic script，共享同一个全局词法环境。
 * 顶层 const/let 重名会直接抛 "Identifier 'X' has already been declared"，
 * 导致**整个脚本不执行**（不是局部报错）。
 * 而 `node --check` 只做单文件语法检查，**抓不到这种冲突** —— 只有真跑浏览器才暴露。
 *
 *   node tools/check-globals.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const PUB = path.resolve('public');
const SYM = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;

function topLevelSymbols(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(SYM)) names.add(m[1]);
  return names;
}

const scripts = fs.readdirSync(PUB)
  .filter(f => f.endsWith('.js'))
  .sort();

const map = new Map();
for (const f of scripts) {
  for (const n of topLevelSymbols(path.join(PUB, f))) {
    if (!map.has(n)) map.set(n, []);
    map.get(n).push(f);
  }
}

let bad = 0;
for (const [name, files] of map) {
  if (files.length > 1) {
    console.log(`✗ 顶层符号冲突: ${name}  出现在 ${files.join(' 与 ')}`);
    bad++;
  }
}

console.log(`\n检查 ${scripts.length} 个脚本，顶层符号共 ${map.size} 个`);
if (bad) {
  console.log(`存在 ${bad} 处冲突 —— 会导致脚本整体不执行，必须改名`);
  process.exit(1);
} else {
  console.log('无顶层符号冲突');
}
