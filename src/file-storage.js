/**
 * 文件存储适配器（Node 专用）—— 单独成文件，让 tracker.js 保持零 Node 依赖，
 * 这样浏览器版可以直接复用同一个 Tracker（换成 localStorage 适配器即可）。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} file 数据文件路径
 * @returns {{load:()=>string|null, append:(line:string)=>void, rewrite:(text:string)=>void}}
 */
export function fileStorage(file) {
  return {
    load: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null),
    append: line => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, line); },
    rewrite: text => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); },
  };
}

/** 纯内存适配器（测试用） */
export function memoryStorage() {
  let buf = null;
  return {
    load: () => buf,
    append: line => { buf = (buf ?? '') + line; },
    rewrite: text => { buf = text; },
  };
}
