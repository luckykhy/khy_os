/**
 *
 * KHY-Quant 量化交易系统 - 螺纹钢主力高频策略种子数据
 *
 * Copyright (c) 2026 孔浩原 (Kong Haoyuan). All Rights Reserved.
 *
 * 未经授权，禁止复制、修改或商业使用。
 *
 */

/**
 * 螺纹钢主力高频策略种子
 *
 * 从 server.js 的后台初始化 IIFE 中外置而来（H2），仅移动数据定义，
 * 保持原有 findOrCreate/幂等（存在则更新，不存在则创建）逻辑不变。
 */

// 策略代码字符串（EMA 金叉死叉 + 布林带 + RSI 的高频信号策略）
const rebarCode =
  "function strategy(data, params) {\n  var emaFast = params.ema_fast || 5;\n  var emaSlow = params.ema_slow || 20;\n  var rsiPeriod = params.rsi_period || 6;\n  var bollPeriod = params.boll_period || 20;\n  var bollStd = params.boll_std || 2;\n  var rsiOversold = params.rsi_oversold || 30;\n  var rsiOverbought = params.rsi_overbought || 75;\n  var signals = [];\n  function calcEMA(values, period) {\n    var ema = [values[0]];\n    var k = 2 / (period + 1);\n    for (var i = 1; i < values.length; i++) { ema.push(values[i] * k + ema[i - 1] * (1 - k)); }\n    return ema;\n  }\n  function calcRSI(closes, period) {\n    var rsi = [];\n    for (var i = 0; i < period; i++) rsi.push(50);\n    var avgGain = 0, avgLoss = 0;\n    for (var j = 1; j <= period; j++) { var d = closes[j] - closes[j - 1]; if (d > 0) avgGain += d; else avgLoss -= d; }\n    avgGain /= period; avgLoss /= period;\n    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));\n    for (var i = period + 1; i < closes.length; i++) {\n      var diff = closes[i] - closes[i - 1];\n      avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;\n      avgLoss = (avgLoss * (period - 1) + (diff > 0 ? -diff : 0)) / period;\n      rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));\n    }\n    return rsi;\n  }\n  function calcSMA(values, period) {\n    var sma = [];\n    for (var i = 0; i < values.length; i++) {\n      if (i < period - 1) { sma.push(values[i]); continue; }\n      var sum = 0;\n      for (var j = i - period + 1; j <= i; j++) sum += values[j];\n      sma.push(sum / period);\n    }\n    return sma;\n  }\n  function calcBoll(closes, period, std) {\n    var mid = calcSMA(closes, period);\n    var upper = [], lower = [];\n    for (var i = 0; i < closes.length; i++) {\n      if (i < period - 1) { upper.push(mid[i] + std * 0.01 * mid[i]); lower.push(mid[i] - std * 0.01 * mid[i]); continue; }\n      var sum2 = 0;\n      for (var j = i - period + 1; j <= i; j++) sum2 += (closes[j] - mid[i]) * (closes[j] - mid[i]);\n      var sd = Math.sqrt(sum2 / period);\n      upper.push(mid[i] + std * sd);\n      lower.push(mid[i] - std * sd);\n    }\n    return { mid: mid, upper: upper, lower: lower };\n  }\n  function calcVolMA(data, period) {\n    var vols = data.map(function(d) { return d.volume || 0; });\n    return calcSMA(vols, period);\n  }\n  var closes = data.map(function(d) { return d.close; });\n  var emaF = calcEMA(closes, emaFast);\n  var emaS = calcEMA(closes, emaSlow);\n  var rsi = calcRSI(closes, rsiPeriod);\n  var boll = calcBoll(closes, bollPeriod, bollStd);\n  var volMA = calcVolMA(data, 20);\n  var minBars = Math.max(emaSlow, bollPeriod, rsiPeriod) + 1;\n  for (var i = 0; i < data.length; i++) {\n    if (i < minBars) { signals.push({ type: 'hold', index: i }); continue; }\n    var c = data[i].close;\n    var vol = data[i].volume || 0;\n    var volRat = volMA[i] > 0 ? vol / volMA[i] : 1;\n    var goldenCross = emaF[i] > emaS[i] && emaF[i - 1] <= emaS[i - 1];\n    var deathCross = emaF[i] < emaS[i] && emaF[i - 1] >= emaS[i - 1];\n    var emaBullish = emaF[i] > emaS[i];\n    var rsiBounce = rsi[i] > rsiOversold && rsi[i - 1] <= rsiOversold && emaBullish;\n    var bollBounce = c > boll.lower[i] && data[i-1].close <= boll.lower[i-1] && emaBullish;\n    if (goldenCross && rsi[i] > rsiOversold) {\n      signals.push({ type: 'buy', index: i, price: c, time: data[i].time || data[i].date, reason: 'EMA golden cross, RSI=' + rsi[i].toFixed(1) });\n    } else if (rsiBounce) {\n      signals.push({ type: 'buy', index: i, price: c, time: data[i].time || data[i].date, reason: 'RSI bounce from oversold=' + rsi[i].toFixed(1) });\n    } else if (bollBounce && rsi[i] < 50) {\n      signals.push({ type: 'buy', index: i, price: c, time: data[i].time || data[i].date, reason: 'Bollinger lower bounce, RSI=' + rsi[i].toFixed(1) });\n    } else if (deathCross) {\n      signals.push({ type: 'sell', index: i, price: c, time: data[i].time || data[i].date, reason: 'EMA death cross' });\n    } else if (rsi[i] > rsiOverbought) {\n      signals.push({ type: 'sell', index: i, price: c, time: data[i].time || data[i].date, reason: 'RSI overbought=' + rsi[i].toFixed(1) });\n    } else if (c < boll.lower[i] * 0.98) {\n      signals.push({ type: 'sell', index: i, price: c, time: data[i].time || data[i].date, reason: 'Stop loss below BB lower' });\n    } else { signals.push({ type: 'hold', index: i }); }\n  }\n  signals.auxiliaryLines = { ema5: emaF, ema20: emaS, bollUpper: boll.upper, bollMid: boll.mid, bollLower: boll.lower };\n  return signals;\n}";

// 策略默认参数
const rebarParams = {
  ema_fast: 5,
  ema_slow: 20,
  rsi_period: 6,
  boll_period: 20,
  boll_std: 2,
  volume_ratio: 1.3,
  rsi_oversold: 30,
  rsi_overbought: 75,
};

/**
 * 幂等地写入螺纹钢主力高频策略模板。
 * 已存在则更新 code/parameters，否则创建。
 */
async function seedRebarStrategy() {
  const Strategy = require('../models').Strategy;
  const existing = await Strategy.findOne({ where: { name: '螺纹钢主力高频策略' } });
  if (existing) {
    await existing.update({ code: rebarCode, parameters: rebarParams });
  } else {
    await Strategy.create({
      user_id: 1,
      name: '螺纹钢主力高频策略',
      description: '基于EMA金叉死叉+布林带+RSI的高频信号策略。',
      type: 'trend',
      language: 'javascript',
      status: 'active',
      isPublic: true,
      parameters: rebarParams,
      code: rebarCode,
    });
  }
}

module.exports = { seedRebarStrategy, rebarCode, rebarParams };
