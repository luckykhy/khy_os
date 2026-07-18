/**
 * 统一价格数据服务
 * 确保所有页面（主页、交易页面、测试页面）使用相同的数据源和价格
 */

import { getApiBaseUrl } from '@/config/api'

class PriceDataService {
  constructor() {
    this.cache = new Map()
    this.cacheTimeout = 5000 // 5秒缓存，确保数据新鲜
    this.pendingRequests = new Map() // 防止重复请求
  }

  /**
   * 获取K线数据（统一入口）
   * @param {string} symbol - 标的代码
   * @param {object} options - 选项
   * @returns {Promise<object>} K线数据
   */
  async getKlineData(symbol, options = {}) {
    const {
      startDate = null,
      endDate = null,
      period = 'daily',
      useCache = true
    } = options

    // 生成缓存键
    const cacheKey = `${symbol}_${startDate}_${endDate}_${period}`
    
    // 检查缓存
    if (useCache) {
      const cached = this.cache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        console.log(`📦 使用缓存数据: ${symbol}`)
        return cached.data
      }
    }

    // 检查是否有正在进行的请求
    if (this.pendingRequests.has(cacheKey)) {
      console.log(`⏳ 等待正在进行的请求: ${symbol}`)
      return this.pendingRequests.get(cacheKey)
    }

    // 创建新请求
    const requestPromise = this._fetchKlineData(symbol, startDate, endDate, period)
    this.pendingRequests.set(cacheKey, requestPromise)

    try {
      const data = await requestPromise
      
      // 缓存结果
      this.cache.set(cacheKey, {
        data,
        timestamp: Date.now()
      })
      
      return data
    } finally {
      // 清除pending请求
      this.pendingRequests.delete(cacheKey)
    }
  }

  /**
   * 内部方法：实际获取K线数据
   */
  async _fetchKlineData(symbol, startDate, endDate, period) {
    try {
      // 构建API URL
      let url = `${getApiBaseUrl()}/comprehensive-data/kline?symbol=${symbol}&period=${period}`
      
      if (startDate) {
        url += `&startDate=${startDate}`
      }
      if (endDate) {
        url += `&endDate=${endDate}`
      }

      // 添加时间戳防止浏览器缓存
      url += `&_t=${Date.now()}`

      console.log(`🌐 获取K线数据: ${symbol}`)
      console.log(`   API: ${url}`)

      const response = await fetch(url, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const raw = await response.json()
      const data = raw?.kline ? raw : (raw?.data || raw)

      if (!data.kline || data.kline.length === 0) {
        throw new Error('返回数据为空')
      }

      console.log(`✅ K线数据获取成功: ${symbol}`)
      console.log(`   数据源: ${data.source}`)
      console.log(`   数据条数: ${data.kline.length}`)
      console.log(`   最新价格: ${data.kline[data.kline.length - 1].close}`)

      return data
    } catch (error) {
      console.error(`❌ 获取K线数据失败: ${symbol}`, error)
      return this.generateMockKlineData(symbol, startDate, endDate)
    }
  }

  generateMockKlineData(symbol, startDate, endDate) {
    const data = []
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    const end = endDate ? new Date(endDate) : new Date()
    const dayMs = 24 * 60 * 60 * 1000
    const base = /000300|399001|399006|000001/.test(symbol) ? 3600 : 20
    let price = base

    for (let ts = start.getTime(); ts <= end.getTime(); ts += dayMs) {
      const d = new Date(ts)
      const day = d.getDay()
      if (day === 0 || day === 6) continue
      const drift = (Math.random() - 0.48) * base * 0.015
      const open = price
      const close = Math.max(0.1, open + drift)
      const high = Math.max(open, close) * (1 + Math.random() * 0.01)
      const low = Math.min(open, close) * (1 - Math.random() * 0.01)
      const volume = Math.floor(100000 + Math.random() * 5000000)

      data.push({
        time: d.toISOString().split('T')[0],
        open: Number(open.toFixed(2)),
        high: Number(high.toFixed(2)),
        low: Number(low.toFixed(2)),
        close: Number(close.toFixed(2)),
        volume
      })
      price = close
    }

    return {
      symbol,
      source: '增强模拟数据',
      dataQuality: 'mock',
      kline: data
    }
  }

  /**
   * 获取最新价格（从K线数据中提取）
   * @param {string} symbol - 标的代码
   * @returns {Promise<object>} 价格信息
   */
  async getLatestPrice(symbol) {
    try {
      // 获取最近30天的数据
      const endDate = new Date()
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - 30)

      const data = await this.getKlineData(symbol, {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        period: 'daily'
      })

      if (!data.kline || data.kline.length === 0) {
        throw new Error('无K线数据')
      }

      // 获取最后一根K线
      const lastCandle = data.kline[data.kline.length - 1]
      const prevCandle = data.kline.length > 1 ? data.kline[data.kline.length - 2] : lastCandle

      // 计算涨跌幅
      const price = parseFloat(lastCandle.close)
      const prevClose = parseFloat(prevCandle.close)
      const change = price - prevClose
      const changePercent = (change / prevClose) * 100

      return {
        symbol,
        price,
        open: parseFloat(lastCandle.open),
        high: parseFloat(lastCandle.high),
        low: parseFloat(lastCandle.low),
        close: price,
        volume: parseInt(lastCandle.volume || 0),
        change,
        changePercent,
        prevClose,
        time: lastCandle.time,
        dataSource: data.source
      }
    } catch (error) {
      console.error(`❌ 获取最新价格失败: ${symbol}`, error)
      throw error
    }
  }

  /**
   * 批量获取最新价格
   * @param {Array<string>} symbols - 标的代码数组
   * @returns {Promise<Array<object>>} 价格信息数组
   */
  async getBatchLatestPrices(symbols) {
    const promises = symbols.map(symbol => 
      this.getLatestPrice(symbol).catch(error => {
        console.warn(`获取 ${symbol} 价格失败:`, error.message)
        return null
      })
    )

    const results = await Promise.all(promises)
    return results.filter(r => r !== null)
  }

  /**
   * 清除缓存
   * @param {string} symbol - 标的代码（可选，不传则清除所有）
   */
  clearCache(symbol = null) {
    if (symbol) {
      // 清除特定标的的缓存
      for (const key of this.cache.keys()) {
        if (key.startsWith(symbol)) {
          this.cache.delete(key)
        }
      }
      console.log(`🗑️ 已清除 ${symbol} 的缓存`)
    } else {
      // 清除所有缓存
      this.cache.clear()
      console.log(`🗑️ 已清除所有缓存`)
    }
  }

  /**
   * 强制刷新数据（不使用缓存）
   * @param {string} symbol - 标的代码
   * @param {object} options - 选项
   * @returns {Promise<object>} K线数据
   */
  async refreshData(symbol, options = {}) {
    this.clearCache(symbol)
    return this.getKlineData(symbol, { ...options, useCache: false })
  }
}

// 导出单例
export const priceDataService = new PriceDataService()
export default priceDataService
