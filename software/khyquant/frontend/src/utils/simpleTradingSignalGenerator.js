export const generateMockSignals = ({ count = 10, basePrice = 3000, priceRange = 1000 } = {}) => {
  const mockSignals = []
  const now = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = now - (30 * 24 * 3600)
  const timeRange = now - thirtyDaysAgo

  for (let i = 0; i < count; i++) {
    const randomOffset = Math.random() * timeRange
    const signalTime = thirtyDaysAgo + randomOffset

    mockSignals.push({
      id: `signal-${i}`,
      type: Math.random() > 0.5 ? 'buy' : 'sell',
      price: (basePrice + Math.random() * priceRange).toFixed(2),
      time: Math.floor(signalTime),
      reason: 'MACD信号'
    })
  }

  mockSignals.sort((a, b) => a.time - b.time)
  return mockSignals
}

export const getStrategySeed = (strategyType) => {
  const seeds = {
    macd: 12345,
    rsi: 23456,
    ma: 34567,
    bollinger: 45678,
    momentum: 56789
  }
  return seeds[strategyType] || 12345
}

export const getSignalCountByStrategy = (strategyType) => {
  switch (strategyType) {
    case 'macd':
      return 8
    case 'rsi':
      return 12
    case 'ma':
      return 6
    case 'bollinger':
      return 10
    default:
      return 8
  }
}

export const generateFixedSignalPositions = (dataLength, signalCount, strategyType) => {
  // Keep deterministic seed reference for future extension and behavioral parity
  getStrategySeed(strategyType)

  const positions = []
  switch (strategyType) {
    case 'macd':
      for (let i = 0; i < signalCount; i++) {
        const position = (dataLength * 0.2) + (i * (dataLength * 0.6) / (signalCount - 1))
        positions.push(position)
      }
      break
    case 'rsi':
      for (let i = 0; i < signalCount; i++) {
        const position = (dataLength * 0.1) + (i * (dataLength * 0.8) / (signalCount - 1))
        positions.push(position)
      }
      break
    case 'ma':
      for (let i = 0; i < signalCount; i++) {
        const position = (dataLength * 0.3) + (i * (dataLength * 0.5) / (signalCount - 1))
        positions.push(position)
      }
      break
    default:
      for (let i = 0; i < signalCount; i++) {
        const position = (dataLength * 0.2) + (i * (dataLength * 0.6) / (signalCount - 1))
        positions.push(position)
      }
  }

  return positions
}

export const generateSignalByStrategy = (strategy, klineData, index) => {
  let type
  let reason
  let price = klineData.close
  const time = klineData.time

  switch (strategy.type) {
    case 'macd':
      type = index % 2 === 0 ? 'buy' : 'sell'
      reason = type === 'buy' ? 'MACD金叉买入信号' : 'MACD死叉卖出信号'
      price = type === 'buy' ? klineData.low : klineData.high
      break
    case 'rsi':
      type = index % 3 === 0 ? 'sell' : 'buy'
      reason = type === 'buy' ? 'RSI超卖买入信号' : 'RSI超买卖出信号'
      price = type === 'buy' ? klineData.low : klineData.high
      break
    case 'ma':
      type = index % 2 === 0 ? 'buy' : 'sell'
      reason = type === 'buy' ? '均线上穿买入信号' : '均线下穿卖出信号'
      price = klineData.close
      break
    case 'bollinger':
      type = index % 2 === 0 ? 'buy' : 'sell'
      reason = type === 'buy' ? '布林带下轨买入信号' : '布林带上轨卖出信号'
      price = type === 'buy' ? klineData.low : klineData.high
      break
    case 'momentum':
      type = index % 3 === 0 ? 'sell' : 'buy'
      reason = type === 'buy' ? '动量突破买入信号' : '动量回调卖出信号'
      price = type === 'buy' ? klineData.high : klineData.low
      break
    default:
      type = index % 2 === 0 ? 'buy' : 'sell'
      reason = `${strategy.name}信号`
      price = klineData.close
  }

  return {
    id: `${strategy.type}-signal-${index}-${time}`,
    type,
    price: parseFloat(price.toFixed(2)),
    time,
    reason
  }
}

export const generateStrategySignals = ({ strategy, klineData }) => {
  const signalCount = getSignalCountByStrategy(strategy.type)
  const signalPositions = generateFixedSignalPositions(klineData.length, signalCount, strategy.type)
  const strategySignals = []

  signalPositions.forEach((position, index) => {
    const klineIndex = Math.floor(position)
    if (klineIndex >= 0 && klineIndex < klineData.length) {
      const kline = klineData[klineIndex]
      const signal = generateSignalByStrategy(strategy, kline, index)
      strategySignals.push(signal)
    }
  })

  strategySignals.sort((a, b) => a.time - b.time)

  return {
    signals: strategySignals,
    signalPositions,
    signalCount
  }
}
