// simpleTradingSignalGenerator.test.js — 锁交易信号生成器
// 覆盖：模拟信号、策略种子/数量表、固定信号位、各策略信号语义
import { describe, it, expect } from 'vitest'
import {
  generateMockSignals,
  getStrategySeed,
  getSignalCountByStrategy,
  generateFixedSignalPositions,
  generateSignalByStrategy,
  generateStrategySignals
} from '@/utils/simpleTradingSignalGenerator'

describe('generateMockSignals', () => {
  it('生成指定数量且时间升序、价格在基准区间内', () => {
    const out = generateMockSignals({ count: 8, basePrice: 3000, priceRange: 1000 })
    expect(out).toHaveLength(8)
    for (let i = 1; i < out.length; i++) {
      expect(out[i].time).toBeGreaterThanOrEqual(out[i - 1].time)
    }
    for (const s of out) {
      expect(s.type).toMatch(/^(buy|sell)$/)
      expect(Number(s.price)).toBeGreaterThanOrEqual(3000)
      expect(Number(s.price)).toBeLessThan(4000)
      expect(s.id).toMatch(/^signal-\d+$/)
      expect(s.reason).toBe('MACD信号')
    }
  })

  it('默认参数：10 个信号、30 天窗口内', () => {
    const now = Math.floor(Date.now() / 1000)
    const out = generateMockSignals({})
    expect(out).toHaveLength(10)
    for (const s of out) {
      expect(s.time).toBeGreaterThan(now - 30 * 24 * 3600 - 60)
      expect(s.time).toBeLessThanOrEqual(now + 1)
    }
  })
})

describe('策略元数据', () => {
  it('getStrategySeed 已知类型返回专属种子，未知回退 macd 种子', () => {
    expect(getStrategySeed('macd')).toBe(12345)
    expect(getStrategySeed('rsi')).toBe(23456)
    expect(getStrategySeed('ma')).toBe(34567)
    expect(getStrategySeed('unknown')).toBe(12345)
  })

  it('getSignalCountByStrategy 数量表与默认值', () => {
    expect(getSignalCountByStrategy('macd')).toBe(8)
    expect(getSignalCountByStrategy('rsi')).toBe(12)
    expect(getSignalCountByStrategy('ma')).toBe(6)
    expect(getSignalCountByStrategy('bollinger')).toBe(10)
    expect(getSignalCountByStrategy('momentum')).toBe(8)
    expect(getSignalCountByStrategy('other')).toBe(8)
  })
})

describe('generateFixedSignalPositions', () => {
  it('信号位数量等于 signalCount，且首尾位置落在数据域内', () => {
    const pos = generateFixedSignalPositions(100, 8, 'macd')
    expect(pos).toHaveLength(8)
    expect(pos[0]).toBeCloseTo(20)      // 0.2 * 100
    expect(pos[pos.length - 1]).toBeCloseTo(20 + 60) // 0.2L + 0.6L
  })

  it('不同策略使用不同起始/跨度比例（ma 从 0.3 起）', () => {
    const ma = generateFixedSignalPositions(100, 6, 'ma')
    expect(ma[0]).toBeCloseTo(30)
    expect(ma[5]).toBeCloseTo(30 + 50)
  })

  it('未识别策略按默认分布（0.2 起、0.6 跨）', () => {
    const pos = generateFixedSignalPositions(100, 8, 'momentum')
    expect(pos[0]).toBeCloseTo(20)
  })
})

describe('generateSignalByStrategy', () => {
  const kline = { time: 100, open: 9, high: 11, low: 8, close: 10, volume: 100 }

  it('macd：偶数位买入取最低价，奇数位卖出取最高价', () => {
    const buy = generateSignalByStrategy({ type: 'macd' }, kline, 0)
    expect(buy.type).toBe('buy')
    expect(buy.price).toBe(8)
    expect(buy.reason).toBe('MACD金叉买入信号')
    const sell = generateSignalByStrategy({ type: 'macd' }, kline, 1)
    expect(sell.type).toBe('sell')
    expect(sell.price).toBe(11)
    expect(sell.reason).toBe('MACD死叉卖出信号')
  })

  it('rsi：index%3===0 卖出，其余买入', () => {
    expect(generateSignalByStrategy({ type: 'rsi' }, kline, 3).type).toBe('sell')
    expect(generateSignalByStrategy({ type: 'rsi' }, kline, 4).type).toBe('buy')
  })

  it('ma：价格始终取收盘价', () => {
    const s = generateSignalByStrategy({ type: 'ma' }, kline, 0)
    expect(s.price).toBe(10)
  })

  it('momentum：买入取最高价、卖出取最低价（与 macd 相反）', () => {
    const buy = generateSignalByStrategy({ type: 'momentum' }, kline, 1)
    expect(buy.type).toBe('buy')
    expect(buy.price).toBe(11)
    const sell = generateSignalByStrategy({ type: 'momentum' }, kline, 0)
    expect(sell.type).toBe('sell')
    expect(sell.price).toBe(8)
  })

  it('bollinger/未知策略：偶数位买入', () => {
    expect(generateSignalByStrategy({ type: 'bollinger' }, kline, 2).type).toBe('buy')
    expect(generateSignalByStrategy({ type: 'bollinger' }, kline, 3).price).toBe(11)
    const custom = generateSignalByStrategy({ type: 'xx', name: '自定义' }, kline, 0)
    expect(custom.reason).toBe('自定义信号')
    expect(custom.price).toBe(10)
  })

  it('信号 ID 含策略类型、序号与时间戳', () => {
    const s = generateSignalByStrategy({ type: 'macd' }, kline, 7)
    expect(s.id).toBe('macd-signal-7-100')
  })
})

describe('generateStrategySignals', () => {
  const klineData = Array.from({ length: 100 }, (_, i) => ({
    time: 1000 + i,
    open: 10,
    high: 11,
    low: 9,
    close: 10 + i * 0.01,
    volume: 100
  }))

  it('输出信号数量等于策略数量表，时间升序', () => {
    const { signals, signalCount, signalPositions } = generateStrategySignals({
      strategy: { type: 'rsi', name: 'RSI策略' },
      klineData
    })
    expect(signalCount).toBe(12)
    expect(signalPositions).toHaveLength(12)
    expect(signals.length).toBeLessThanOrEqual(12)
    expect(signals.length).toBeGreaterThan(0)
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i].time).toBeGreaterThanOrEqual(signals[i - 1].time)
    }
    expect(signals[0].id).toMatch(/^rsi-signal-\d+-\d+$/)
  })

  it('K线不足时越界信号位被过滤', () => {
    const short = klineData.slice(0, 5)
    const { signals } = generateStrategySignals({ strategy: { type: 'ma' }, klineData: short })
    // ma 首位在 0.3*5=1.5→1，末位 0.3L+0.5L*5/5=... 超出部分被过滤
    for (const s of signals) {
      const idx = short.findIndex((k) => k.time === s.time)
      expect(idx).toBeGreaterThanOrEqual(0)
    }
  })
})
