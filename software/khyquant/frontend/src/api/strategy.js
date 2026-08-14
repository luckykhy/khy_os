import request from './request'

// 获取策略列表
export const getStrategies = (params) => {
  return request({
    url: '/strategies',
    method: 'get',
    params
  })
}

// 获取策略详情
export const getStrategy = (id) => {
  return request({
    url: `/strategies/${id}`,
    method: 'get'
  })
}

// 创建策略
export const createStrategy = (data) => {
  return request({
    url: '/strategies',
    method: 'post',
    data
  })
}

// 更新策略
export const updateStrategy = (id, data) => {
  return request({
    url: `/strategies/${id}`,
    method: 'put',
    data
  })
}

// 删除策略
export const deleteStrategy = (id) => {
  return request({
    url: `/strategies/${id}`,
    method: 'delete'
  })
}

// 获取策略模板
export const getStrategyTemplates = () => {
  return request({
    url: '/strategies/templates',
    method: 'get'
  })
}

// 回测策略
export const backtestStrategy = (id, data) => {
  return request({
    url: `/strategies/${id}/backtest`,
    method: 'post',
    data
  })
}

// 执行策略
export const executeStrategy = (id, data) => {
  return request({
    url: `/strategies/${id}/execute`,
    method: 'post',
    data
  })
}
