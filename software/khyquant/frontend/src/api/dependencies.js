import request from '@/utils/request'

// 依赖管理 API：清单 + 按需安装（运行时/工具链 + 应用依赖）。
export const dependenciesAPI = {
  // 获取依赖清单（runtime + packages）
  getInventory() {
    return request({
      url: '/dependencies',
      method: 'get'
    })
  },

  // 安装指定依赖（仅低风险/项目级可由后端直装；高危返回 manualOnly）
  install(id) {
    return request({
      url: `/dependencies/${id}/install`,
      method: 'post'
    })
  }
}
