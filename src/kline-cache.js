/**
 * K线缓存的文件读写（**Node 专用**）。
 *
 * 为什么单独拆出来：
 *   market.js 是要下发给浏览器的共用模块，**不能** import node:fs。
 *   所以 market.js 只负责纯数据（collectCache / applyCache），
 *   文件读写留在这里，由 server.js 调用。
 *
 * 为什么需要缓存：
 *   每次重启都要重新播种 200 标的 × 12 级别 = 2400 个请求 / 4800 权重，
 *   几乎顶满合约 2400/分钟的上限，叠加滚动补K线就会撞 418。
 *   而 418 期间播种必然失败 —— 服务会卡在「有标的名、无K线」出不来。
 *   反复重启会把限流越撞越死。
 */
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const MAX_AGE_MS = 24 * 3600_000;

export function readCache(file, log) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.v !== VERSION) { log?.info('K线缓存版本不符，忽略'); return null; }
    const ageMs = Date.now() - (raw.savedAt ?? 0);
    if (ageMs > MAX_AGE_MS) { log?.info(`K线缓存已过期（${(ageMs / 3600000).toFixed(1)} 小时前），忽略`); return null; }
    return raw;
  } catch (e) {
    log?.warn('K线缓存读取失败：' + e.message);
    return null;
  }
}

/**
 * 写入缓存（带防覆盖保护）。
 * @param {string} file
 * @param {object} obj market.collectCache() 的结果
 */
export function writeCache(file, obj, log) {
  try {
    const count = Object.keys(obj?.symbols ?? {}).length;

    // —— 防覆盖保护 ——
    // 服务在限流期间会以 0 个标的状态继续跑，定时写盘如果照写，
    // 就会用一份**空缓存覆盖掉之前那份好缓存**（实测丢过一次 20 MB / 200 标的）。
    // 所以：空缓存一律不写；新缓存明显缩水时也不写，保留旧的。
    if (count === 0) {
      log?.warn('本次没有可缓存的K线（尚未播种？）—— 跳过写盘，保留原有缓存');
      return null;
    }
    let prevCount = 0;
    try {
      if (fs.existsSync(file)) {
        const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
        prevCount = Object.keys(prev.symbols ?? {}).length;
      }
    } catch { /* 旧文件坏了就当作没有 */ }
    if (prevCount > 0 && count < prevCount * 0.5) {
      log?.warn(`本次只缓存到 ${count} 个标的（原有 ${prevCount} 个）—— 疑似异常缩水，跳过写盘以保留原有缓存`);
      return null;
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);        // 原子替换，避免写一半崩掉留下坏文件
    return { symbols: count, bytes: fs.statSync(file).size, prevCount };
  } catch (e) {
    log?.warn('K线缓存写入失败：' + e.message);
    return null;
  }
}
