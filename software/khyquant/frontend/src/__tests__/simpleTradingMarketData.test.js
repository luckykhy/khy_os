// simpleTradingMarketData.test.js — 锁 mock 行情数据工具
// 覆盖：标的信息表、周期参数表、symbol 归一化、种子确定性、K线生成形状
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getInstrumentInfo,
  getPeriodInfo,
  getBaseVolume,
  getSymbolSeed,
  generateMockKlineData
} from '@/utils/simpleTradingMarketData'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('getInstrumentInfo', () => {
  it('已知标的（带交易所后缀）命中信息表', () => {
    const info = getInstrumentInfo('600519.SH')
    expect(info.name).toBe('贵州茅台')
    expect(info.listingDate).toBe('2001-08-27')
    expect(info.basePrice).toBe(1500)
  })

  it('sh/sz 前缀格式归一化后命中同一标的', () => {
    const info = getInstrumentInfo('sh600519')
    expect(info.name).toBe('贵州茅台')
  })

  it('纯 6 位代码：6 开头走 sh，其余走 sz', () => {
    expect(getInstrumentInfo('600519').name).toBe('贵州茅台')
    expect(getInstrumentInfo('000002').name).toBe('万科A')
  })

  it('未知标的回退默认值并告警', () => {
    const info = getInstrumentInfo('CU9999.SHFE')
    expect(info.name).toBe('未知标的')
    expect(info.basePrice).toBe(10)
    expect(console.warn).toHaveBeenCalled()
  })

  it('自定义归一化函数优先于内置规则', () => {
    const info = getInstrumentInfo('X', () => '600519.SH')
    expect(info.name).toBe('贵州茅台')
  })
})

describe('getPeriodInfo / getBaseVolume', () => {
  it('已知周期返回对应参数', () => {
    expect(getPeriodInfo('5m').intervalSeconds).toBe(300)
    expect(getPeriodInfo('1d').maxDataPoints).toBe(3650)
    expect(getBaseVolume('1h')).toBe(1000000)
  })

  it('未知周期回退日线参数', () => {
    expect(getPeriodInfo('xx')).toBe(getPeriodInfo('1d'))
    expect(getBaseVolume('xx')).toBe(10000000)
  })
})

describe('getSymbolSeed', () => {
  it('同一 symbol 种子确定性稳定，不同 symbol 种子不同', () => {
    expect(getSymbolSeed('sh000001')).toBe(getSymbolSeed('sh000001'))
    expect(getSymbolSeed('sh000001')).not.toBe(getSymbolSeed('sz399001'))
    expect(getSymbolSeed('sh000001')).toBeGreaterThan(12345)
  })
})

describe('generateMockKlineData', () => {
  it('生成非空 K 线，形状与字段合规', () => {
    const data = generateMockKlineData({
      symbol: '600519.SH',
      selectedPeriod: '1d',
      selectedSymbol: '600519.SH',
      contract: '600519.SH'
    })
    expect(data.length).toBeGreaterThan(0)
    const bar = data[data.length - 1]
    expect(bar).toHaveProperty('time')
    expect(bar).toHaveProperty('open')
    expect(bar.high).toBeGreaterThanOrEqual(bar.low)
    expect(bar.volume).toBeGreaterThanOrEqual(0)
    // 时间升序
    for (let i = 1; i < data.length; i++) {
      expect(data[i].time).toBeGreaterThan(data[i - 1].time)
    }
  })

  it('同一输入两次生成结果一致（种子确定）', () => {
    const a = generateMockKlineData({ symbol: '000002.SZ', selectedPeriod: '1d' })
    const b = generateMockKlineData({ symbol: '000002.SZ', selectedPeriod: '1d' })
    expect(a).toEqual(b)
  })

  it('沪深300 日线走专属周期算法', () => {
    const data = generateMockKlineData({ symbol: '000300.SH', selectedPeriod: '1d' })
    expect(data.length).toBeGreaterThan(0)
    // 起始价 807.78 附近起步（周期算法首日开盘）
    expect(data[0].open).toBeCloseTo(807.78, 0)
  })

  it('symbol 缺失时回退 contract 参数，再缺失用默认标的', () => {
    const data = generateMockKlineData({ contract: '600036.SH', selectedPeriod: '1d' })
    expect(data.length).toBeGreaterThan(0)
    const def = generateMockKlineData({})
    expect(def.length).toBeGreaterThan(0)
  })

  it('支持注入自定义 instrument/seed 函数', () => {
    const data = generateMockKlineData({
      symbol: 'ANY',
      selectedPeriod: '1d',
      getInstrumentInfoFn: () => ({ listingDate: '2020-01-02', basePrice: 100, name: 'X' }),
      getSymbolSeedFn: () => 77
    })
    expect(data.length).toBeGreaterThan(0)
    expect(data[0].open).toBeGreaterThan(0)
  })
})
