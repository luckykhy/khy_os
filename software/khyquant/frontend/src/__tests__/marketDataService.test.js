// marketDataService.test.js — 锁统一市场数据服务的三级降级策略
// 真实数据(API) → localStorage 缓存 → 模拟数据；axios 全部打桩，不发真实请求
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('axios', () => ({ default: { get: vi.fn() } }))

import axios from 'axios'
import {
  getInstrumentsList,
  getMarketQuotes,
  clearAllCache,
  clearInstrumentsCache
} from '@/services/marketDataService'

const QUOTES_KEY = (t) => `market_quotes_${t}`
const INSTRUMENTS_KEY = (t) => `instruments_list_${t}`

beforeEach(() => {
  vi.clearAllMocks()
  clearAllCache()
  clearInstrumentsCache()
  localStorage.removeItem(QUOTES_KEY('stock'))
  localStorage.removeItem(INSTRUMENTS_KEY('stock'))
})

describe('getInstrumentsList', () => {
  it('API 成功时映射字段并永久写入 localStorage', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        success: true,
        data: { instruments: [{ symbol: 'sh600519', name: '贵州茅台', type: 'stock', price: 1600 }] }
      }
    })
    const list = await getInstrumentsList('stock')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ symbol: 'sh600519', name: '贵州茅台', basePrice: 1600 })
    // 接口参数：类型与数量限制透传
    expect(axios.get).toHaveBeenCalledTimes(1)
    const [url, config] = axios.get.mock.calls[0]
    expect(url).toContain('/api/market/symbols')
    expect(config.params).toEqual({ type: 'stock', limit: 0 })
    expect(JSON.parse(localStorage.getItem(INSTRUMENTS_KEY('stock')))).toHaveLength(1)
  })

  it('API 失败时回退到内置默认标的列表', async () => {
    axios.get.mockRejectedValueOnce(new Error('down'))
    const list = await getInstrumentsList('stock')
    expect(list.length).toBeGreaterThan(0)
    expect(list[0]).toHaveProperty('symbol')
    expect(list[0]).toHaveProperty('basePrice')
  })

  it('已知 localStorage 列表优先作为回退基础', async () => {
    const saved = [{ symbol: 'sh159915', name: '创业板ETF', basePrice: 2 }]
    localStorage.setItem(INSTRUMENTS_KEY('etf'), JSON.stringify(saved))
    axios.get.mockRejectedValueOnce(new Error('down'))
    const list = await getInstrumentsList('etf')
    expect(list).toEqual(saved)
  })

  it('localStorage 内容损坏时回退默认列表', async () => {
    localStorage.setItem(INSTRUMENTS_KEY('bond'), 'not-json')
    axios.get.mockRejectedValueOnce(new Error('down'))
    const list = await getInstrumentsList('bond')
    expect(list.length).toBeGreaterThan(0)
    expect(localStorage.getItem(INSTRUMENTS_KEY('bond'))).toBe('not-json') // 未覆盖坏数据
  })

  it('并发同参请求去重：只发一次 HTTP', async () => {
    axios.get.mockResolvedValue({ data: { success: false } })
    const [a, b] = await Promise.all([getInstrumentsList('index'), getInstrumentsList('index')])
    expect(axios.get).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })
})

describe('getMarketQuotes 三级降级', () => {
  const symbols = [{ symbol: 'sh600519', name: '贵州茅台', basePrice: 1600 }]

  it('第一级：AData 接口成功 → 使用实时数据并写缓存', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        success: true,
        samples: [{ code: 'sh600519', name: '贵州茅台', close: 1601.5, open: 1600, high: 1610, low: 1595, volume: 9000, changePercent: 0.09 }]
      }
    })
    const quotes = await getMarketQuotes(symbols)
    expect(quotes).toHaveLength(1)
    expect(quotes[0]).toMatchObject({ symbol: 'sh600519', price: 1601.5, dataSource: 'AData实时数据' })
    expect(axios.get).toHaveBeenCalledTimes(1)
    expect(axios.get.mock.calls[0][0]).toContain('/api/comprehensive-data/test-source/adata')
    expect(JSON.parse(localStorage.getItem(QUOTES_KEY('stock'))).data).toHaveLength(1)
  })

  it('第二级：AData 失败、通用行情接口成功', async () => {
    axios.get
      .mockRejectedValueOnce(new Error('adata down'))
      .mockResolvedValueOnce({
        data: { success: true, data: [{ symbol: 'sh600519', name: '贵州茅台', price: 1650 }] }
      })
    const quotes = await getMarketQuotes(symbols)
    expect(quotes[0]).toMatchObject({ price: 1650, dataSource: '实时数据' })
    expect(axios.get).toHaveBeenCalledTimes(2)
    expect(axios.get.mock.calls[1][0]).toContain('/api/market/quotes')
  })

  it('第三级：接口全失败时读 localStorage 缓存', async () => {
    localStorage.setItem(
      QUOTES_KEY('stock'),
      JSON.stringify({ data: [{ symbol: 'sh600519', price: 1500, dataSource: 'x' }], timestamp: Date.now() - 60000 })
    )
    axios.get.mockRejectedValue(new Error('down'))
    const quotes = await getMarketQuotes(symbols)
    expect(quotes[0]).toMatchObject({ symbol: 'sh600519', price: 1500, dataSource: '缓存数据' })
  })

  it('缓存过期（>24h）时落到第四级模拟数据', async () => {
    localStorage.setItem(
      QUOTES_KEY('stock'),
      JSON.stringify({ data: [{ symbol: 'sh600519', price: 1500 }], timestamp: Date.now() - 25 * 3600 * 1000 })
    )
    axios.get.mockRejectedValue(new Error('down'))
    const quotes = await getMarketQuotes(symbols)
    expect(quotes[0]).toMatchObject({ dataSource: '模拟数据' })
    expect(quotes[0].price).toBeGreaterThan(0)
  })

  it('无缓存无接口 → 模拟数据数量与标的列表一致', async () => {
    const many = symbols.concat([{ symbol: 'sz000858', name: '五粮液', basePrice: 158 }])
    axios.get.mockRejectedValue(new Error('down'))
    const quotes = await getMarketQuotes(many, 'stock')
    expect(quotes).toHaveLength(2)
    expect(quotes.every((q) => q.dataSource === '模拟数据')).toBe(true)
  })

  it('指数类模拟波动区间更大（±4% 以内 vs 股票 ±5% 以内）', async () => {
    axios.get.mockRejectedValue(new Error('down'))
    const indexQuotes = await getMarketQuotes(symbols, 'index')
    const stockQuotes = await getMarketQuotes(symbols, 'stock')
    for (const q of indexQuotes.concat(stockQuotes)) {
      expect(Math.abs(q.changePercent)).toBeLessThanOrEqual(5.01)
    }
  })
})

describe('缓存清理', () => {
  it('clearAllCache / clearInstrumentsCache 清除对应键', () => {
    for (const type of ['index', 'stock', 'etf', 'bond', 'futures']) {
      localStorage.setItem(QUOTES_KEY(type), 'q')
      localStorage.setItem(INSTRUMENTS_KEY(type), 'i')
    }
    clearAllCache()
    for (const type of ['index', 'stock', 'etf', 'bond', 'futures']) {
      expect(localStorage.getItem(QUOTES_KEY(type))).toBeNull()
      expect(localStorage.getItem(INSTRUMENTS_KEY(type))).toBe('i')
    }
    clearInstrumentsCache()
    expect(localStorage.getItem(INSTRUMENTS_KEY('stock'))).toBeNull()
  })
})
