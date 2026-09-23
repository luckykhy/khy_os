// apiMarketData.test.js — 锁 src/api/marketData.js 行情 API 封装
// 请求走 @/api/request 单例（此处打桩，不发真实请求）；锁 URL/参数与三级降级
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/api/request', () => ({ default: vi.fn() }))

import request from '@/api/request'
import {
  getKlineData,
  getRealtimeData,
  getInstrumentList,
  getMarketQuotes
} from '@/api/marketData'

beforeEach(() => vi.clearAllMocks())

describe('基础请求透传', () => {
  it('getKlineData 透传查询参数', async () => {
    request.mockResolvedValue({ success: true })
    const params = { symbol: 'sh000300', startDate: '2024-01-01', endDate: '2024-06-01', period: 'daily' }
    const out = await getKlineData(params)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toEqual({
      url: '/comprehensive-data/kline',
      method: 'get',
      params
    })
    expect(out).toEqual({ success: true })
  })

  it('getRealtimeData 只传 symbol', async () => {
    request.mockResolvedValue({})
    await getRealtimeData('sh600519')
    expect(request.mock.calls[0][0]).toMatchObject({
      url: '/comprehensive-data/realtime',
      params: { symbol: 'sh600519' }
    })
  })

  it('getInstrumentList 传市场类型', async () => {
    request.mockResolvedValue([])
    await getInstrumentList('etf')
    expect(request.mock.calls[0][0]).toMatchObject({
      url: '/comprehensive-data/instruments',
      params: { market: 'etf' }
    })
  })
})

describe('getMarketQuotes 三级降级', () => {
  it('AData 成功：返回 samples 并标记数据源', async () => {
    request.mockResolvedValueOnce({ samples: [{ symbol: 'sh600519', price: 10 }] })
    const out = await getMarketQuotes(5)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ symbol: 'sh600519', dataSource: 'AData实时数据' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0].url).toBe('/comprehensive-data/test-source/adata')
    expect(request.mock.calls[0][0].params).toEqual({ limit: 5 })
  })

  it('AData 空 samples 时降级到通用行情接口', async () => {
    request.mockResolvedValueOnce({ samples: [] }).mockResolvedValueOnce([{ symbol: 'sz000858', price: 20 }])
    const out = await getMarketQuotes(10)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ symbol: 'sz000858', dataSource: '实时数据' })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][0].url).toBe('/comprehensive-data/market-quotes')
  })

  it('全部失败时返回空数组（不抛错）', async () => {
    request.mockRejectedValue(new Error('down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await getMarketQuotes(3)
    expect(out).toEqual([])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('通用接口空数据继续落到空数组兜底', async () => {
    request.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce([])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await getMarketQuotes(1)
    expect(out).toEqual([])
  })

  it('通用接口返回信封 { success, data:{quotes} } 时同样可用', async () => {
    request.mockResolvedValueOnce({ samples: [] }).mockResolvedValueOnce({
      success: true,
      data: { quotes: [{ symbol: 'sz000858', price: 20 }] }
    })
    const out = await getMarketQuotes(10)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ symbol: 'sz000858', dataSource: '实时数据' })
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[1][0].url).toBe('/comprehensive-data/market-quotes')
  })
})
