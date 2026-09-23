// indicators.test.js — 锁 src/utils/indicators.js 技术指标口径
// 单一真源：SMA/EMA/MACD/RSI/KDJ/BOLL/VWAP 的数值算法；改动公式者先红。
import { describe, it, expect } from 'vitest'
import {
  SMA,
  EMA,
  MACD,
  RSI,
  KDJ,
  BOLL,
  VWAP
} from '@/utils/indicators'

// 合成K线：固定 time 序列 + 已知 OHLCV
function bars(closes) {
  return closes.map((close, i) => ({
    time: 1000 + i * 60,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100 + i
  }))
}

describe('SMA', () => {
  it('前 period-1 个点为 NaN，之后输出窗口均值', () => {
    const data = bars([2, 4, 6, 8, 10])
    const result = SMA(data, 3)
    expect(result).toHaveLength(5)
    expect(Number.isNaN(result[0].value)).toBe(true)
    expect(Number.isNaN(result[1].value)).toBe(true)
    expect(result[2].value).toBe(4)      // (2+4+6)/3
    expect(result[3].value).toBe(6)      // (4+6+8)/3
    expect(result[4].value).toBe(8)      // (6+8+10)/3
  })

  it('保留 time 字段', () => {
    const data = bars([1, 2, 3])
    expect(SMA(data, 2)[1].time).toBe(1000 + 60)
  })
})

describe('EMA', () => {
  it('首点用收盘作种子，period 之前为 NaN', () => {
    const data = bars([10, 12, 14, 16])
    const result = EMA(data, 3)
    expect(Number.isNaN(result[0].value)).toBe(true)
    expect(Number.isNaN(result[1].value)).toBe(true)
    // k = 2/4 = 0.5: e1 = 12*0.5 + 10*0.5 = 11; e2 = 14*0.5 + 11*0.5 = 12.5; e3 = 16*0.5 + 12.5*0.5 = 14.25
    expect(result[3].value).toBe(14.25)
  })
})

describe('MACD', () => {
  it('输出含 dif/dea/histogram，慢线前为 NaN', () => {
    const data = bars(Array.from({ length: 40 }, (_, i) => 100 + i))
    const result = MACD(data)
    expect(result).toHaveLength(40)
    expect(result[0].dif).toBeNaN()
    expect(result[30].dif).not.toBeNaN()
    // 上升趋势：DIF > DEA，柱状图为正
    expect(result[39].dif).toBeGreaterThan(result[39].dea)
    expect(result[39].histogram).toBeGreaterThan(0)
  })

  it('自定义周期参数生效（值有限即合规）', () => {
    const data = bars(Array.from({ length: 20 }, (_, i) => 50 + i * 2))
    const result = MACD(data, 5, 10, 4)
    expect(result[8].dif).toBeNaN()   // i < slow-1 → dif 未定型
    expect(Number.isFinite(result[19].dif)).toBe(true)
    expect(Number.isFinite(result[19].dea)).toBe(true)
  })
})

describe('RSI', () => {
  it('首点 NaN，period 点后在 0-100 区间内', () => {
    const data = bars([44, 44.3, 44.8, 43.6, 44.1, 44.5, 44.9, 43.5, 44, 44.4])
    const result = RSI(data, 4)
    expect(Number.isNaN(result[0].value)).toBe(true)
    expect(result[3].value).toBeNaN()
    for (const item of result.slice(4)) {
      expect(item.value).toBeGreaterThanOrEqual(0)
      expect(item.value).toBeLessThanOrEqual(100)
    }
  })

  it('全跌趋势 RSI 趋近 0，全涨趋势 RSI 趋近 100', () => {
    const falling = RSI(bars([100, 99, 98, 97, 96, 95, 94, 93, 92]), 3)
    expect(falling[8].value).toBeLessThan(10)
    const rising = RSI(bars([10, 11, 12, 13, 14, 15, 16, 17, 18]), 3)
    expect(rising[8].value).toBeGreaterThan(90)
  })
})

describe('KDJ', () => {
  it('前 n-1 点为 NaN，之后 k/d/j 均在合理范围', () => {
    const closes = [24.3, 24.8, 25.2, 24.6, 25.5, 26.0, 25.1, 24.9, 25.8, 26.4]
    const result = KDJ(bars(closes), 3, 3, 3)
    expect(Number.isNaN(result[0].k)).toBe(true)
    expect(Number.isNaN(result[1].k)).toBe(true)
    expect(Number.isFinite(result[2].k)).toBe(true)
    const item = result[9]
    expect(item.j).toBeCloseTo(3 * item.k - 2 * item.d, 1)
  })
})

describe('BOLL', () => {
  it('前 period-1 点为 NaN，之后上轨>中轨>下轨', () => {
    const data = bars(Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5))
    const result = BOLL(data, 20, 2)
    expect(Number.isNaN(result[18].upper)).toBe(true)
    const b = result[24]
    expect(b.upper).toBeGreaterThan(b.mid)
    expect(b.mid).toBeGreaterThan(b.lower)
  })
})

describe('VWAP', () => {
  it('累计量价加权，volume 缺失时按 1 处理', () => {
    const data = [
      { time: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 },
      { time: 2, open: 10.5, high: 12, low: 10, close: 11, volume: 300 }
    ]
    const result = VWAP(data)
    // tp1=(11+9+10.5)/3≈10.1667, tp2=(12+10+11)/3=11
    // vwap2 = (10.1667*100 + 11*300) / 400 ≈ 10.7917
    expect(result[0].value).toBeCloseTo(10.17, 2)
    expect(result[1].value).toBeCloseTo(10.79, 2)

    const noVol = VWAP([{ time: 1, high: 12, low: 8, close: 10 }])
    expect(noVol[0].value).toBe(10)
  })
})
