/**
 * 统一的市场数据服务
 * 实现三级降级策略: 真实数据 → 缓存数据 → 模拟数据
 * 标的列表永久保存在localStorage
 */

import axios from 'axios'
import { getApiBaseUrl as getRuntimeApiBaseUrl } from '@/utils/connectionMode'

const API_TIMEOUT = 5000 // 5s timeout
const CACHE_MAX_AGE = 24 * 60 * 60 * 1000 // 24h

// In-flight request deduplication
const inflightRequests = new Map()

function deduplicatedFetch(key, fetchFn) {
  if (inflightRequests.has(key)) {
    return inflightRequests.get(key)
  }
  const promise = fetchFn().finally(() => {
    inflightRequests.delete(key)
  })
  inflightRequests.set(key, promise)
  return promise
}

/**
 * 获取API基础URL
 */
function getApiBaseUrl() {
  const apiBase = getRuntimeApiBaseUrl()
  return apiBase.endsWith('/api') ? apiBase.slice(0, -4) : apiBase
}

/**
 * 获取标的列表(永久保存)
 * @param {string} type - 标的类型: 'index', 'stock', 'etf', 'bond', 'futures'
 * @param {number} limit - 限制数量,0表示不限制
 * @returns {Promise<Array>} 标的列表
 */
export async function getInstrumentsList(type = 'stock', limit = 0) {
  return deduplicatedFetch(`instruments_${type}_${limit}`, async () => {
  const cacheKey = `instruments_list_${type}`
  
  // 1. 从localStorage获取永久保存的标的列表
  let symbolsList = getDefaultSymbols(type)
  const savedSymbols = localStorage.getItem(cacheKey)
  if (savedSymbols) {
    try {
      const parsed = JSON.parse(savedSymbols)
      if (parsed && parsed.length > 0) {
        symbolsList = parsed
        console.log(`📦 从本地加载 ${symbolsList.length} 个${type}标的`)
      }
    } catch (e) {
      console.warn('解析本地标的列表失败:', e)
    }
  }
  
  // 2. 尝试从数据库API更新标的列表
  try {
    const response = await axios.get(`${getApiBaseUrl()}/api/market/symbols`, {
      params: { type, limit },
      timeout: API_TIMEOUT
    })
    
    if (response.data.success && response.data.data.instruments && response.data.data.instruments.length > 0) {
      symbolsList = response.data.data.instruments.map(item => ({
        symbol: item.symbol,
        name: item.name,
        type: item.type || type,
        basePrice: item.price || getDefaultPrice(type)
      }))
      
      // 永久保存到localStorage
      localStorage.setItem(cacheKey, JSON.stringify(symbolsList))
      console.log(`✅ 从数据库更新标的列表: ${symbolsList.length} 个${type}`)
    }
  } catch (error) {
    console.warn(`⚠️ 获取${type}标的列表失败,使用本地列表:`, error.message)
  }
  
  return symbolsList
  }) // end deduplicatedFetch
}

/**
 * 获取行情数据(三级降级: AData优先 → 缓存数据 → 模拟数据)
 * @param {Array} symbolsList - 标的列表
 * @param {string} type - 标的类型
 * @returns {Promise<Array>} 行情数据
 */
export async function getMarketQuotes(symbolsList, type = 'stock') {
  const cacheKey = `market_quotes_${type}`
  
  // 1. 优先尝试从AData获取真实行情数据
  try {
    console.log(`🔍 尝试从AData获取${type}行情数据...`)
    const response = await axios.get(`${getApiBaseUrl()}/api/comprehensive-data/test-source/adata`, {
      params: { 
        symbols: symbolsList.map(s => s.symbol).join(','),
        type: type
      },
      timeout: API_TIMEOUT
    })
    
    if (response.data.success && response.data.samples && response.data.samples.length > 0) {
      const quotes = response.data.samples.map(item => ({
        symbol: item.symbol || item.code,
        name: item.name,
        type: type,
        price: parseFloat(item.price || item.close || 0),
        open: parseFloat(item.open || 0),
        high: parseFloat(item.high || 0),
        low: parseFloat(item.low || 0),
        volume: item.volume || 0,
        change: parseFloat(item.change || 0),
        changePercent: parseFloat(item.changePercent || item.change_percent || item.change || 0),
        time: item.time || item.timestamp || new Date().toISOString(),
        dataSource: 'AData实时数据'
      }))
      
      // 缓存到localStorage
      localStorage.setItem(cacheKey, JSON.stringify({
        data: quotes,
        timestamp: Date.now()
      }))
      
      console.log(`✅ 使用AData实时数据: ${quotes.length} 个${type}`)
      return quotes
    }
  } catch (error) {
    console.warn(`⚠️ AData获取${type}行情失败:`, error.message)
  }
  
  // 1.5 如果AData失败,尝试通用市场行情API
  try {
    console.log(`🔍 尝试从通用API获取${type}行情数据...`)
    const response = await axios.get(`${getApiBaseUrl()}/api/market/quotes`, {
      params: { 
        symbols: symbolsList.map(s => s.symbol).join(','),
        limit: symbolsList.length 
      },
      timeout: API_TIMEOUT
    })
    
    if (response.data.success && response.data.data && response.data.data.length > 0) {
      const quotes = response.data.data.map(item => ({
        symbol: item.symbol || item.code,
        name: item.name,
        type: type,
        price: parseFloat(item.price || item.close || 0),
        open: parseFloat(item.open || 0),
        high: parseFloat(item.high || 0),
        low: parseFloat(item.low || 0),
        volume: item.volume || 0,
        change: parseFloat(item.change || 0),
        changePercent: parseFloat(item.changePercent || item.change_percent || 0),
        time: item.time || item.timestamp || new Date().toISOString(),
        dataSource: '实时数据'
      }))
      
      // 缓存到localStorage
      localStorage.setItem(cacheKey, JSON.stringify({
        data: quotes,
        timestamp: Date.now()
      }))
      
      console.log(`✅ 使用通用API实时数据: ${quotes.length} 个${type}`)
      return quotes
    }
  } catch (error) {
    console.warn(`⚠️ 通用API获取${type}行情失败:`, error.message)
  }
  
  // 2. 尝试从localStorage获取缓存数据
  const cached = localStorage.getItem(cacheKey)
  if (cached) {
    try {
      const { data, timestamp } = JSON.parse(cached)
      const cacheAge = Date.now() - timestamp
      
      if (cacheAge < CACHE_MAX_AGE && data && data.length > 0) {
        const quotes = data.map(item => ({
          ...item,
          dataSource: '缓存数据'
        }))
        console.log(`✅ 使用缓存数据: ${quotes.length} 个${type} (${Math.floor(cacheAge / 1000 / 60)} 分钟前)`)
        return quotes
      }
    } catch (e) {
      console.warn('解析缓存数据失败:', e)
    }
  }
  
  // 3. 使用模拟数据
  console.log(`⚠️ 使用模拟数据: ${type}`)
  return generateMockQuotes(symbolsList, type)
}

/**
 * 生成模拟行情数据
 */
function generateMockQuotes(symbolsList, type) {
  return symbolsList.map(item => {
    const changePercent = (Math.random() - 0.5) * (type === 'index' ? 4 : 10)
    const basePrice = item.basePrice || getDefaultPrice(type)
    const price = basePrice * (1 + changePercent / 100)
    const change = price - basePrice
    
    return {
      symbol: item.symbol,
      name: item.name,
      type: type,
      price: parseFloat(price.toFixed(2)),
      open: parseFloat((basePrice * (1 + (Math.random() - 0.5) * 0.02)).toFixed(2)),
      high: parseFloat((price * (1 + Math.random() * 0.03)).toFixed(2)),
      low: parseFloat((price * (1 - Math.random() * 0.03)).toFixed(2)),
      volume: Math.floor(Math.random() * 100000000) + 10000000,
      change: parseFloat(change.toFixed(2)),
      changePercent: parseFloat(changePercent.toFixed(2)),
      time: new Date().toISOString(),
      dataSource: '模拟数据'
    }
  })
}

/**
 * 获取默认标的列表
 */
function getDefaultSymbols(type) {
  const defaults = {
    index: [
      { symbol: 'sh000001', name: '上证指数', basePrice: 3100 },
      { symbol: 'sh000300', name: '沪深300', basePrice: 4660 },
      { symbol: 'sz399001', name: '深证成指', basePrice: 10500 },
      { symbol: 'sz399006', name: '创业板指', basePrice: 2100 },
      { symbol: 'sz399005', name: '中小板指', basePrice: 6800 },
      { symbol: 'sh000016', name: '上证50', basePrice: 2650 },
      { symbol: 'sh000688', name: '科创50', basePrice: 980 },
      { symbol: 'sh000905', name: '中证500', basePrice: 5800 }
    ],
    stock: [
      { symbol: 'sh600519', name: '贵州茅台', basePrice: 1680 },
      { symbol: 'sz000858', name: '五粮液', basePrice: 158 },
      { symbol: 'sh600036', name: '招商银行', basePrice: 35 },
      { symbol: 'sz000001', name: '平安银行', basePrice: 12.8 },
      { symbol: 'sh601318', name: '中国平安', basePrice: 45.6 },
      { symbol: 'sz000333', name: '美的集团', basePrice: 58.9 },
      { symbol: 'sz002594', name: '比亚迪', basePrice: 245.8 },
      { symbol: 'sh600276', name: '恒瑞医药', basePrice: 42.8 }
    ],
    etf: [
      { symbol: 'sh510300', name: '300ETF', basePrice: 4.5 },
      { symbol: 'sh510500', name: '500ETF', basePrice: 6.8 },
      { symbol: 'sh588000', name: '科创50ETF', basePrice: 1.2 }
    ],
    bond: [
      { symbol: 'sh113050', name: '南银转债', basePrice: 125 },
      { symbol: 'sh110059', name: '浦发转债', basePrice: 118 }
    ],
    futures: [
      { symbol: 'IF2403', name: '沪深300期货', basePrice: 4660 },
      { symbol: 'IC2403', name: '中证500期货', basePrice: 5800 },
      { symbol: 'rb_main', name: '螺纹钢主力', basePrice: 3380 },
      { symbol: 'rb2510', name: '螺纹钢2510', basePrice: 3380 }
    ]
  }
  
  return defaults[type] || defaults.stock
}

/**
 * 获取默认价格
 */
function getDefaultPrice(type) {
  const prices = {
    index: 3000,
    stock: 10,
    etf: 1,
    bond: 100,
    futures: 3000
  }
  return prices[type] || 10
}

/**
 * 清除所有缓存
 */
export function clearAllCache() {
  const keys = ['index', 'stock', 'etf', 'bond', 'futures']
  keys.forEach(type => {
    localStorage.removeItem(`market_quotes_${type}`)
  })
  console.log('✅ 已清除所有行情缓存')
}

/**
 * 清除标的列表缓存(慎用!)
 */
export function clearInstrumentsCache() {
  const keys = ['index', 'stock', 'etf', 'bond', 'futures']
  keys.forEach(type => {
    localStorage.removeItem(`instruments_list_${type}`)
  })
  console.log('⚠️ 已清除所有标的列表缓存')
}

export default {
  getInstrumentsList,
  getMarketQuotes,
  clearAllCache,
  clearInstrumentsCache
}
