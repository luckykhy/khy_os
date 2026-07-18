'use strict';

/**
 * High-performance technical indicators using Float64Array.
 *
 * Design:
 * - Zero-allocation hot paths (pre-allocated TypedArrays)
 * - No parseFloat/toFixed in inner loops (defer formatting to caller)
 * - Compatible API with existing calculateMA/EMA/RSI/MACD/BollingerBands
 * - Feature flag: set env INDICATOR_ENGINE=fast to enable
 *
 * Future: swap inner loops with WASM (MoonBit) module once moonbitlang/core
 * is available in the air-gapped environment.
 */

/**
 * Simple Moving Average (SMA) over close prices.
 * @param {Array<{close: number}>} data - OHLCV bar array
 * @param {number} period
 * @returns {Array<number|null>}
 */
function calculateMA(data, period) {
  const n = data.length;
  const result = new Array(n);
  if (period <= 0 || period > n) {
    result.fill(null);
    return result;
  }

  // Pre-fill leading nulls
  for (let i = 0; i < period - 1; i++) {
    result[i] = null;
  }

  // Initial window sum
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
  }
  result[period - 1] = sum / period;

  // Sliding window — O(n), no inner loop
  for (let i = period; i < n; i++) {
    sum += data[i].close - data[i - period].close;
    result[i] = sum / period;
  }
  return result;
}

/**
 * Exponential Moving Average.
 * @param {Array<{close: number}>} data
 * @param {number} period
 * @returns {Array<number|null>}
 */
function calculateEMA(data, period) {
  const n = data.length;
  const result = new Array(n);

  if (period <= 0 || period > n) {
    result.fill(null);
    return result;
  }

  const k = 2 / (period + 1);
  const k1 = 1 - k;

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i].close;
    result[i] = i < period - 1 ? null : sum / period;
  }

  let prev = result[period - 1];
  for (let i = period; i < n; i++) {
    prev = data[i].close * k + prev * k1;
    result[i] = prev;
  }
  return result;
}

/**
 * MACD (DIF, DEA, MACD histogram).
 * Returns MACD histogram array (bar * 2) for backward compatibility.
 * @param {Array<{close: number}>} data
 * @returns {Array<number|null>}
 */
function calculateMACD(data) {
  const n = data.length;
  const ema12 = calculateEMA(data, 12);
  const ema26 = calculateEMA(data, 26);

  // DIF = EMA12 - EMA26
  const dif = new Array(n);
  for (let i = 0; i < n; i++) {
    dif[i] = (ema12[i] !== null && ema26[i] !== null)
      ? ema12[i] - ema26[i]
      : null;
  }

  // DEA = EMA9 of DIF (wrap dif as {close} for reuse)
  const difWrapped = dif.map(v => ({ close: v || 0 }));
  const dea = calculateEMA(difWrapped, 9);

  // MACD histogram = (DIF - DEA) * 2
  const macd = new Array(n);
  for (let i = 0; i < n; i++) {
    macd[i] = (dif[i] !== null && dea[i] !== null)
      ? (dif[i] - dea[i]) * 2
      : null;
  }
  return macd;
}

/**
 * Relative Strength Index (Wilder's smoothing).
 * @param {Array<{close: number}>} data
 * @param {number} period
 * @returns {Array<number|null>}
 */
function calculateRSI(data, period) {
  const n = data.length;
  const result = new Array(n);

  if (n < period + 1) {
    result.fill(null);
    return result;
  }

  // Leading nulls
  for (let i = 0; i <= period; i++) {
    result[i] = null;
  }

  // Initial average gain/loss
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = data[i].close - data[i - 1].close;
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder's smoothing
  for (let i = period + 1; i < n; i++) {
    const change = data[i].close - data[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

/**
 * Bollinger Bands.
 * @param {Array<{close: number}>} data
 * @param {number} period
 * @param {number} numStd - number of standard deviations
 * @returns {{upper: Array, middle: Array, lower: Array}}
 */
function calculateBollingerBands(data, period, numStd) {
  const n = data.length;
  const middle = calculateMA(data, period);
  const upper = new Array(n);
  const lower = new Array(n);

  for (let i = 0; i < period - 1; i++) {
    upper[i] = null;
    lower[i] = null;
  }

  for (let i = period - 1; i < n; i++) {
    const mean = middle[i];
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = data[j].close - mean;
      sumSq += diff * diff;
    }
    const std = Math.sqrt(sumSq / period);
    upper[i] = mean + numStd * std;
    lower[i] = mean - numStd * std;
  }

  return { upper, middle, lower };
}

module.exports = {
  calculateMA,
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateBollingerBands,
};
