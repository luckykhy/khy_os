import request from './request'

export const tradeAPI = {
  // 获取交易记录列表
  getTrades(params) {
    return request({
      url: '/trading',
      method: 'get',
      params
    })
  },

  // 创建交易订单
  createTrade(data) {
    return request({
      url: '/trading',
      method: 'post',
      data
    })
  },

  // 提交交易订单
  submitOrder(data) {
    return request({
      url: '/trading/order',
      method: 'post',
      data
    })
  },

  // 获取账户信息
  getAccount() {
    return request({
      url: '/trading/account',
      method: 'get'
    })
  },

  // 获取持仓信息
  getPositions() {
    return request({
      url: '/trading/positions',
      method: 'get'
    })
  },

  // 获取交易统计
  getTradeStats(params) {
    return request({
      url: '/trading/stats',
      method: 'get',
      params
    })
  },

  // 取消订单
  cancelOrder(orderId) {
    return request({
      url: `/trading/order/${orderId}/cancel`,
      method: 'post'
    })
  },

  // 平仓
  closePosition(tradeId, data) {
    return request({
      url: `/trading/${tradeId}/close`,
      method: 'post',
      data
    })
  },

  // 获取订单详情
  getOrderDetail(orderId) {
    return request({
      url: `/trading/order/${orderId}`,
      method: 'get'
    })
  }
}