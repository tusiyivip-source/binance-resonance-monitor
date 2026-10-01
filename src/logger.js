/** 轻量日志（带时间戳与级别着色） */
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

const TZ = new Intl.DateTimeFormat('zh-CN', {
  timeZone: process.env.TZ_NAME || 'Asia/Shanghai',
  hour12: false, month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function stamp() { return C.dim + TZ.format(new Date()).replace(/\//g, '-') + C.reset; }

export function createLogger(scope = 'app') {
  const write = (color, tag, args) => {
    console.log(`${stamp()} ${color}${tag.padEnd(5)}${C.reset} ${C.dim}[${scope}]${C.reset}`, ...args);
  };
  return {
    info: (...a) => write(C.cyan, 'INFO', a),
    warn: (...a) => write(C.yellow, 'WARN', a),
    error: (...a) => write(C.red, 'ERROR', a),
    signal: (...a) => write(C.magenta, 'SIGNAL', a),
    ok: (...a) => write(C.green, 'OK', a),
    debug: (...a) => { if (process.env.DEBUG) write(C.dim, 'DEBUG', a); },
  };
}
