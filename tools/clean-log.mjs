/** 清理绩效库中的测试探针记录 */
import fs from 'node:fs';
const f = 'data/signals.jsonl';
if (!fs.existsSync(f)) { console.log('文件不存在'); process.exit(0); }
const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const kept = lines.filter(l => !l.includes('|PROBE|') && !/"score":99/.test(l));
fs.writeFileSync(f, kept.join('\n') + (kept.length ? '\n' : ''));
console.log(`清理前 ${lines.length} 条 → 清理后 ${kept.length} 条（移除 ${lines.length - kept.length} 条测试探针）`);
