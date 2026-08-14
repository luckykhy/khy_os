import request from './request'

/**
 * 获取K线数据
 * @param {Object} params - 查询参数
 * @param {string} params.symbol - 标的代码 (如: sh000300, sz000001)
 * @param {string} params.startDate - 开始日期 (YYYY-MM-DD)
 * @param {string} params.endDate - 结束日期 (YYYY-MM-DD)
 * @param {string} params.period - 周期 (daily, weekly, monthly)
 * @returns {Promise} K线数据
 */
export function getKlineData(params) {
  return request({
    url: '/comprehensive-data/kline',
    method: 'get',
    params
  })
}

/**
 * 获取实时行情数据
 * @param {string} symbol - 标的代码
 * @returns {Promise} 实时行情数据
 */
export function getRealtimeData(symbol) {
  return request({
    url: '/comprehensive-data/realtime',
    method: 'get',
    params: { symbol }
  })
}

/**
 * 获取标的列表
 * @param {string} market - 市场类型 (stock, index, etf)
 * @returns {Promise} 标的列表
 */
export function getInstrumentList(market) {
  return request({
    url: '/comprehensive-data/instruments',
    method: 'get',
    params: { market }
  })
}

/**
 * 获取市场行情列表 (AData优先策略)
 * @param {number} limit - 返回数量限制
 * @returns {Promise} 市场行情列表
 */
export async function getMarketQuotes(limit = 20) {
  // 1. 优先尝试从AData获取数据
  try {
    console.log('🔍 尝试从AData获取行情数据...')
    const adataResponse = await request({
      url: '/comprehensive-data/test-source/adata',
      method: 'get',
      params: { limit },
      timeout: 5000
    })
    
    if (adataResponse && adataResponse.samples && adataResponse.samples.length > 0) {
      console.log(`✅ 使用AData实时数据: ${adataResponse.samples.length} 条`)
      return adataResponse.samples.map(item => ({
        ...item,
        dataSource: 'AData实时数据'
      }))
    }
  } catch (error) {
    console.warn('⚠️ AData获取失败:', error.message)
  }
  
  // 2. 降级到通用市场行情API
  try {
    console.log('🔍 尝试从通用API获取行情数据...')
    const response = await request({
      url: '/comprehensive-data/market-quotes',
      method: 'get',
      params: { limit },
      timeout: 5000
    })
    
    if (response && response.length > 0) {
      console.log(`✅ 使用通用API数据: ${response.length} 条`)
      return response.map(item => ({
        ...item,
        dataSource: '实时数据'
      }))
    }
  } catch (error) {
    console.warn('⚠️ 通用API获取失败:', error.message)
  }
  
  // 3. 如果都失败,返回空数组
  console.warn('❌ 所有数据源都失败')
  return []
}
