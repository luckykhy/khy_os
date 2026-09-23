// priceDataService.test.js — 锁统一价格数据服务（缓存/去重/降级/批量）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import priceDataService from '@/services/priceDataService'

function okKline(symbol = 'sh000001') {
  return {
    ok: true,
    json: async () => ({
      kline: [
        { time: '2024-01-02', open: '9', high: '10', low: '8.5', close: '9.8', volume: '1000' },
        { time: '2024-01-03', open: '9.8', high: '10.5', low: '9.7', close: '10.2', volume: '1500' }
      ],
      source: 'AData实时数据'
    })
  }
}

let fetchMock
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  priceDataService.clearCache()
})
afterEach(() => vi.unstubAllGlobals())

describe('getKlineData', () => {
  it('成功请求返回后端 K 线并缓存', async () => {
    fetchMock.mockResolvedValue(okKline())
    const data = await priceDataService.getKlineData('sh000001', { period: 'daily' })
    expect(data.kline).toHaveLength(2)
    expect(data.source).toBe('AData实时数据')
    // 二次调用命中缓存，不再发请求
    await priceDataService.getKlineData('sh000001')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('URL 动态拼装：base 来自运行时配置，参数按需附加', async () => {
    fetchMock.mockResolvedValue(okKline())
    await priceDataService.getKlineData('sh600519', { startDate: '2024-01-01', endDate: '2024-02-01', period: 'weekly' })
    const url = fetchMock.mock.calls[0][0]
    expect(url).toContain('/comprehensive-data/kline?symbol=sh600519&period=weekly')
    expect(url).toContain('startDate=2024-01-01')
    expect(url).toContain('endDate=2024-02-01')
    expect(url).toMatch(/_t=\d+$/)
  })

  it('并发相同参数请求去重为一次', async () => {
    fetchMock.mockResolvedValue(okKline())
    const [a, b] = await Promise.all([
      priceDataService.getKlineData('sz399001'),
      priceDataService.getKlineData('sz399001')
    ])
    expect(a).toBe(b)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('HTTP 失败降级为增强模拟数据', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'ERR', json: async () => ({}) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const data = await priceDataService.getKlineData('sh000001', {
      startDate: '2024-01-01',
      endDate: '2024-01-31'
    })
    expect(data.source).toBe('增强模拟数据')
    expect(data.kline.length).toBeGreaterThan(0)
    for (const bar of data.kline) {
      expect(bar.high).toBeGreaterThanOrEqual(bar.low)
      expect(bar.volume).toBeGreaterThanOrEqual(0)
    }
  })

  it('接口返回空 K 线同样降级为模拟数据', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const data = await priceDataService.getKlineData('sh000001', {
      startDate: '2024-01-01',
      endDate: '2024-01-31'
    })
    expect(data.source).toBe('增强模拟数据')
  })

  it('useCache=false 跳过缓存读取（仍会写缓存）', async () => {
    fetchMock.mockResolvedValue(okKline())
    await priceDataService.getKlineData('sh000001')
    await priceDataService.getKlineData('sh000001', { useCache: false })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('generateMockKlineData', () => {
  it('跳过周末，输出升序日期序列', () => {
    const out = priceDataService.generateMockKlineData('sh600519', '2024-01-01', '2024-01-15')
    expect(out.kline.length).toBeGreaterThan(0)
    expect(out.kline.length).toBeLessThan(15)
    const days = out.kline.map((b) => new Date(b.time).getDay())
    expect(days).not.toContain(0)
    expect(days).not.toContain(6)
    for (let i = 1; i < out.kline.length; i++) {
      expect(out.kline[i - 1].time < out.kline[i].time).toBe(true)
    }
  })

  it('指数类标的用大基准价，普通标的用小基准价', () => {
    const index = priceDataService.generateMockKlineData('sh000300', '2024-01-01', '2024-01-10')
    const stock = priceDataService.generateMockKlineData('sh600519', '2024-01-01', '2024-01-10')
    expect(index.kline[0].open).toBeGreaterThanOrEqual(3500)
    expect(stock.kline[0].open).toBeLessThan(30)
  })
})

describe('getLatestPrice', () => {
  it('用最后两根 K 线计算涨跌幅', async () => {
    fetchMock.mockResolvedValue(okKline())
    const p = await priceDataService.getLatestPrice('sh000001')
    expect(p.price).toBe(10.2)
    expect(p.prevClose).toBe(9.8)
    expect(p.change).toBeCloseTo(0.4, 5)
    expect(p.changePercent).toBeCloseTo(4.08, 2)
    expect(p.dataSource).toBe('AData实时数据')
  })

  it('单根 K 线时 prevClose 回退为自身', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ kline: [{ time: '2024-01-02', open: '5', high: '5', low: '5', close: '5', volume: '1' }] })
    })
    const p = await priceDataService.getLatestPrice('sh000001')
    expect(p.change).toBe(0)
    expect(p.changePercent).toBe(0)
  })

  it('数据源彻底失败时降级为模拟数据（dataSource 标记增强模拟数据）', async () => {
    fetchMock.mockRejectedValue(new Error('net'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = await priceDataService.getLatestPrice('sh000001')
    expect(p.dataSource).toBe('增强模拟数据')
    expect(Number.isFinite(p.price)).toBe(true)
    expect(p.symbol).toBe('sh000001')
  })
})

describe('getBatchLatestPrices', () => {
  it('混合来源：成功接口走真实数据，失败标的降级为模拟数据，结果均保留', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('sh600519')
        ? okKline()
        : { ok: false, status: 500, statusText: 'down', json: async () => ({}) }
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const results = await priceDataService.getBatchLatestPrices(['sh600519', 'sz000002'])
    expect(results).toHaveLength(2)
    const bySource = Object.fromEntries(results.map((r) => [r.dataSource, r]))
    expect(bySource['AData实时数据']).toHaveProperty('symbol', 'sh600519')
    expect(bySource['增强模拟数据']).toHaveProperty('symbol', 'sz000002')
  })
})

describe('refreshData / clearCache', () => {
  it('refreshData 清除该标的缓存后强制重新拉取', async () => {
    fetchMock.mockResolvedValue(okKline())
    await priceDataService.getKlineData('sh000001')
    const data = await priceDataService.refreshData('sh000001')
    expect(data.kline).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clearCache(symbol) 只清前缀匹配的键', async () => {
    fetchMock.mockResolvedValue(okKline())
    await priceDataService.getKlineData('sh000001')
    await priceDataService.getKlineData('sh000001', { period: 'weekly' })
    priceDataService.clearCache('sh000001')
    await priceDataService.getKlineData('sh000001')
    await priceDataService.getKlineData('sh000001', { period: 'weekly' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
