import request from '@/api/request'

export const adminAPI = {
  // 获取用户日志列表
  getUserLogs(params) {
    return request({
      url: '/admin/user-logs',
      method: 'get',
      params
    })
  },

  // 获取用户活动统计
  getUserActivityStats(days = 30) {
    return request({
      url: '/admin/user-activity-stats',
      method: 'get',
      params: { days }
    })
  },

  // 清理旧日志
  cleanOldLogs(daysToKeep = 90) {
    return request({
      url: '/admin/user-logs/cleanup',
      method: 'delete',
      data: { daysToKeep }
    })
  },

  // 导出用户日志
  async exportUserLogs(params) {
    const response = await request({
      url: '/admin/user-logs/export',
      method: 'get',
      params,
      responseType: 'blob'
    })

    // 创建下载链接
    const blob = new Blob([response], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `user-logs-${new Date().toISOString().split('T')[0]}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)

    return response
  },

  // 获取用户列表
  getUsers() {
    return request({
      url: '/users',
      method: 'get'
    })
  },

  // 创建用户
  createUser(userData) {
    return request({
      url: '/admin/users',
      method: 'post',
      data: userData
    })
  },

  // 更新用户信息
  updateUser(userId, userData) {
    return request({
      url: `/admin/users/${userId}`,
      method: 'put',
      data: userData
    })
  },

  // 删除用户
  deleteUser(userId) {
    return request({
      url: `/admin/users/${userId}`,
      method: 'delete'
    })
  },

  // 重置用户密码
  resetUserPassword(userId, newPassword) {
    return request({
      url: `/admin/users/${userId}/reset-password`,
      method: 'post',
      data: { newPassword }
    })
  },

  // 获取用户详情
  getUserDetail(userId) {
    return request({
      url: `/users/${userId}`,
      method: 'get'
    })
  },

  // 获取系统设置
  getSystemSettings(category) {
    return request({
      url: '/admin/system/settings',
      method: 'get',
      params: category ? { category } : {}
    })
  },

  // 更新系统设置
  updateSystemSettings(settings) {
    return request({
      url: '/admin/system/settings',
      method: 'put',
      data: { settings }
    })
  },

  // 获取系统信息
  getSystemInfo() {
    return request({
      url: '/admin/system/info',
      method: 'get'
    })
  },

  // 重置设置为默认值
  resetSystemSetting(key) {
    return request({
      url: '/admin/system/settings/reset',
      method: 'post',
      data: { key }
    })
  },

  // 初始化默认设置
  initializeSystemSettings() {
    return request({
      url: '/admin/system/settings/initialize',
      method: 'post'
    })
  }
}