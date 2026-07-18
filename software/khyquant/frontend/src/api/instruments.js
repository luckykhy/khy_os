/**
 * 金融工具 API
 * 统一的金融工具数据接口
 */
import request from '@/utils/request'

/**
 * 获取金融工具列表
 * @param {Object} params - 查询参数
 * @param {string} params.market - 市场类型 (stock, index, futures)
 * @param {number} params.limit - 返回数量限制
 * @returns {Promise} 金融工具列表
 */
export function getInstruments(params = {}) {
  return request({
    url: '/comprehensive-data/instruments',
    method: 'get',
    params
  })
}

/**
 * 搜索金融工具
 * @param {Object} params - 查询参数
 * @param {string} params.query - 搜索关键词
 * @param {string} params.type - 类型过滤
 * @param {string} params.market - 市场过滤
 * @param {number} params.limit - 返回数量限制
 * @returns {Promise} 搜索结果
 */
export function searchInstruments(params) {
  return request({
    url: '/comprehensive-data/instruments/search',
    method: 'get',
    params
  })
}

/**
 * 获取市场行情列表(使用与交易界面相同的数据源)
 * @param {number} limit - 返回数量限制
 * @returns {Promise} 市场行情列表
 */
export function getMarketQuotesUnified(limit = 20) {
  return request({
    url: '/comprehensive-data/instruments',
    method: 'get',
    params: { limit }
  })
}
