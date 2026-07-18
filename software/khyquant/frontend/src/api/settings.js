import request from './request'

export const settingsAPI = {
  // 获取公开设置
  getPublicSettings(category) {
    return request({
      url: '/settings/public',
      method: 'get',
      params: category ? { category } : {}
    })
  },

  // 获取单个公开设置
  getPublicSetting(key) {
    return request({
      url: `/settings/public/${key}`,
      method: 'get'
    })
  }
}