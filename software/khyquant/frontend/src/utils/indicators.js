/**
 * Technical indicator calculations for K-line chart overlays
 */

/**
 * Simple Moving Average
 */
export function SMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push({ time: data[i].time, value: NaN }); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j].close;
    result.push({ time: data[i].time, value: parseFloat((sum / period).toFixed(4)) });
  }
  return result;
}

/**
 * Exponential Moving Average
 */
export function EMA(data, period) {
  const result = [];
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      prev = data[i].close;
    } else {
      prev = data[i].close * k + prev * (1 - k);
    }
    result.push({ time: data[i].time, value: i >= period - 1 ? parseFloat(prev.toFixed(4)) : NaN });
  }
  return result;
}

/**
 * MACD (12, 26, 9)
 */
export function MACD(data, fast = 12, slow = 26, signal = 9) {
  const emaFast = _emaValues(data, fast);
  const emaSlow = _emaValues(data, slow);
  const dif = emaFast.map((v, i) => v - emaSlow[i]);
  const dea = _emaFromArray(dif, signal);
  const macd = dif.map((v, i) => (v - dea[i]) * 2);

  return data.map((bar, i) => ({
    time: bar.time,
    dif: i >= slow - 1 ? parseFloat(dif[i].toFixed(4)) : NaN,
    dea: i >= slow + signal - 2 ? parseFloat(dea[i].toFixed(4)) : NaN,
    histogram: i >= slow + signal - 2 ? parseFloat(macd[i].toFixed(4)) : NaN
  }));
}

/**
 * RSI
 */
export function RSI(data, period = 14) {
  const result = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < data.length; i++) {
    if (i === 0) { result.push({ time: data[i].time, value: NaN }); continue; }
    const change = data[i].close - data[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result.push({ time: data[i].time, value: parseFloat((100 - 100 / (1 + rs)).toFixed(2)) });
      } else {
        result.push({ time: data[i].time, value: NaN });
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push({ time: data[i].time, value: parseFloat((100 - 100 / (1 + rs)).toFixed(2)) });
    }
  }
  return result;
}

/**
 * KDJ (9, 3, 3)
 */
export function KDJ(data, n = 9, m1 = 3, m2 = 3) {
  const result = [];
  let prevK = 50, prevD = 50;
  for (let i = 0; i < data.length; i++) {
    if (i < n - 1) { result.push({ time: data[i].time, k: NaN, d: NaN, j: NaN }); continue; }
    let high = -Infinity, low = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (data[j].high > high) high = data[j].high;
      if (data[j].low < low) low = data[j].low;
    }
    const rsv = high === low ? 50 : ((data[i].close - low) / (high - low)) * 100;
    const k = (2 / m1) * rsv + (1 - 2 / m1) * prevK;
    const d = (2 / m2) * k + (1 - 2 / m2) * prevD;
    const j = 3 * k - 2 * d;
    prevK = k; prevD = d;
    result.push({
      time: data[i].time,
      k: parseFloat(k.toFixed(2)),
      d: parseFloat(d.toFixed(2)),
      j: parseFloat(j.toFixed(2))
    });
  }
  return result;
}

/**
 * Bollinger Bands (20, 2)
 */
export function BOLL(data, period = 20, multiplier = 2) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push({ time: data[i].time, upper: NaN, mid: NaN, lower: NaN }); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j].close;
    const mid = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (data[j].close - mid) ** 2;
    const std = Math.sqrt(variance / period);
    result.push({
      time: data[i].time,
      upper: parseFloat((mid + multiplier * std).toFixed(4)),
      mid: parseFloat(mid.toFixed(4)),
      lower: parseFloat((mid - multiplier * std).toFixed(4))
    });
  }
  return result;
}

/**
 * Volume-Weighted Average Price
 */
export function VWAP(data) {
  let cumVol = 0, cumTP = 0;
  return data.map(bar => {
    const tp = (bar.high + bar.low + bar.close) / 3;
    cumVol += bar.volume || 1;
    cumTP += tp * (bar.volume || 1);
    return { time: bar.time, value: parseFloat((cumTP / cumVol).toFixed(4)) };
  });
}

// --- internal helpers ---
function _emaValues(data, period) {
  const result = [];
  const k = 2 / (period + 1);
  let prev = data[0].close;
  for (let i = 0; i < data.length; i++) {
    prev = i === 0 ? data[0].close : data[i].close * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function _emaFromArray(arr, period) {
  const result = [];
  const k = 2 / (period + 1);
  let prev = arr[0] || 0;
  for (let i = 0; i < arr.length; i++) {
    prev = i === 0 ? arr[0] : arr[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}
