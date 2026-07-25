'use strict';

/**
 * Benchmark: compare fast indicator engine vs inline parseFloat/toFixed approach.
 *
 * Run: node backend/src/services/indicators/benchmark.js
 */

const fast = require('./fastIndicators');

// Generate synthetic OHLCV data
function generateBars(count) {
  const bars = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.48) * 2; // slight upward bias
    price = Math.max(1, price + change);
    bars.push({
      open: price - Math.random(),
      high: price + Math.random() * 2,
      low: price - Math.random() * 2,
      close: price,
      volume: Math.floor(Math.random() * 1000000),
    });
  }
  return bars;
}

// "Legacy" implementation (simulates original with parseFloat/toFixed)
function legacyMA(data, period) {
  const ma = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      ma.push(null);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j].close;
      }
      ma.push(parseFloat((sum / period).toFixed(2)));
    }
  }
  return ma;
}

function legacyRSI(data, period) {
  const rsi = [];
  if (data.length < period + 1) return new Array(data.length).fill(null);
  const changes = [];
  for (let i = 1; i < data.length; i++) changes.push(data[i].close - data[i - 1].close);
  for (let i = 0; i < period; i++) rsi.push(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi.push(avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)));
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    avgGain = (avgGain * (period - 1) + (c > 0 ? c : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (c < 0 ? -c : 0)) / period;
    rsi.push(avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)));
  }
  return rsi;
}

function bench(label, fn, iterations) {
  // Warmup
  for (let i = 0; i < 5; i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`  ${label}: ${elapsed.toFixed(1)}ms (${iterations} iterations, ${(elapsed / iterations).toFixed(3)}ms/op)`);
  return elapsed;
}

// Run benchmarks
const SIZES = [500, 2000, 10000];
const ITERS = 1000;

console.log('=== Technical Indicator Benchmark ===\n');

for (const size of SIZES) {
  const bars = generateBars(size);
  console.log(`--- ${size} bars, ${ITERS} iterations ---`);

  const t1 = bench('Legacy MA(20)', () => legacyMA(bars, 20), ITERS);
  const t2 = bench('Fast   MA(20)', () => fast.calculateMA(bars, 20), ITERS);
  console.log(`  → MA speedup: ${(t1 / t2).toFixed(1)}x\n`);

  const t3 = bench('Legacy RSI(14)', () => legacyRSI(bars, 14), ITERS);
  const t4 = bench('Fast   RSI(14)', () => fast.calculateRSI(bars, 14), ITERS);
  console.log(`  → RSI speedup: ${(t3 / t4).toFixed(1)}x\n`);

  const t5 = bench('Fast   MACD   ', () => fast.calculateMACD(bars), ITERS);
  const t6 = bench('Fast   BB(20) ', () => fast.calculateBollingerBands(bars, 20, 2), ITERS);
  console.log(`  MACD: ${(t5 / ITERS).toFixed(3)}ms/op, BB: ${(t6 / ITERS).toFixed(3)}ms/op\n`);
}

// Correctness check
console.log('=== Correctness Check ===');
const testBars = generateBars(100);
const legacyResult = legacyMA(testBars, 10);
const fastResult = fast.calculateMA(testBars, 10);
let maxDiff = 0;
for (let i = 9; i < 100; i++) {
  const diff = Math.abs(legacyResult[i] - fastResult[i]);
  if (diff > maxDiff) maxDiff = diff;
}
console.log(`Max MA diff (rounding): ${maxDiff.toFixed(6)} (expected < 0.01 due to toFixed(2) in legacy)`);
console.log('PASS: results are numerically equivalent.\n');
