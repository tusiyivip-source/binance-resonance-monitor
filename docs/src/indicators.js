/** 技术指标：SMA / EMA，均为 O(n) 一次构建、与输入等长对齐 */

export function buildSMA(values, period) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA，用前 period 根的 SMA 作为种子（比首值种子收敛更快、更稳） */
export function buildEMA(values, period) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 简单收益率，用于展示 */
export function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

/**
 * MACD（12, 26, 9）。
 * DIF = EMA12 − EMA26；DEA = EMA9(DIF)；柱 = 2 × (DIF − DEA)（国内软件口径）。
 * DIF 从第 26 根起才有值，DEA 再用前 9 个有效 DIF 做 SMA 种子。
 */
export function buildMACD(closes, fast = 12, slow = 26, signal = 9) {
  const n = closes.length;
  const ef = buildEMA(closes, fast);
  const es = buildEMA(closes, slow);
  const dif = new Float64Array(n).fill(NaN);
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(ef[i]) && Number.isFinite(es[i])) {
      dif[i] = ef[i] - es[i];
      if (start < 0) start = i;
    }
  }
  const dea = new Float64Array(n).fill(NaN);
  if (start >= 0) {
    const k = 2 / (signal + 1);
    let sum = 0, cnt = 0, prev = NaN;
    for (let i = start; i < n; i++) {
      const v = dif[i];
      if (!Number.isFinite(v)) continue;
      if (!Number.isFinite(prev)) {
        sum += v; cnt++;
        if (cnt === signal) { prev = sum / signal; dea[i] = prev; }
        continue;
      }
      prev = v * k + prev * (1 - k);
      dea[i] = prev;
    }
  }
  const hist = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(dif[i]) && Number.isFinite(dea[i])) hist[i] = 2 * (dif[i] - dea[i]);
  }
  return { dif, dea, hist };
}
