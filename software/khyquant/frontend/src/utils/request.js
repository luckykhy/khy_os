/**
 * 全局 Axios HTTP 客户端 —— 所有前端 API 请求的统一出口
 *
 * 架构角色：属于前端交互层的基础设施
 *   所有 Vue 组件和 Service 发出的 HTTP 请求都通过这个单例 Axios 实例，
 *   确保认证、加载动画和错误处理的一致性。
 *
 * 功能说明：
 *   1. 请求拦截器：自动注入 JWT Bearer Token（从 Pinia store 读取）
 *   2. 响应拦截器：统一处理 401/403/404/500 等错误码
 *   3. 全局加载动画：300ms 防抖延迟显示（避免快速请求的闪烁）
 *   4. 连接模式感知：根据 local/cloud/lan 模式自动切换 baseURL
 *   5. 移动端适配：手机端跳过全局 loading 遮罩
 *
 * 对应论文：第5.5节（前端实现与部署），第5.1节（认证与中间件实现）
 *   前端的 JWT Token 注入与后端的 authMiddleware 配合，
 *   形成完整的"先认证后推送"安全链路（论文第3.3节接口约束）
 */
import axios from 'axios'
import { ElLoading, ElMessage } from 'element-plus'
import { useUserStore } from '@/stores/user'
import { getFriendlyErrorMessage } from './errorMessage'
import { getApiBaseUrl, getRequestTimeoutMs, isMobileViewport, getConnectionMode } from './connectionMode'
import { isLocalToken } from '@/services/localAuthService'

// 创建 Axios 单例，所有请求共享同一个实例
const request = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: getRequestTimeoutMs(),
  headers: {
    'Content-Type': 'application/json'
  }
})

// ==================== 全局加载动画管理 ====================
// 通过引用计数（pendingCount）跟踪并发请求数量，
// 只有所有请求完成后才关闭 loading 遮罩
let pendingCount = 0        // 当前正在进行的请求数量
let loadingInstance = null   // Element Plus Loading 实例
let loadingTimer = null      // 300ms 延迟定时器（防抖）
let handlingAuthExpired = false  // 防止 401 重复处理的标志

function isLogoutRequest(config) {
  const url = String(config?.url || '')
  return url.includes('/auth/logout')
}

function shouldSkipAuthErrorHandling(config) {
  return Boolean(config?.__skipAuthErrorHandling) || isLogoutRequest(config)
}

/**
 * 开始全局加载动画（300ms 防抖）
 * 快速请求（<300ms）不会显示 loading，避免视觉闪烁
 */
function startGlobalLoading(config) {
  if (config?.silentLoading) return
  if (isMobileViewport()) return
  pendingCount += 1
  if (pendingCount === 1 && !loadingTimer) {
    // Delay showing loading by 300ms to avoid flash for fast requests
    loadingTimer = setTimeout(() => {
      if (pendingCount > 0 && !loadingInstance) {
        loadingInstance = ElLoading.service({
          lock: true,
          text: '加载中...',
          background: 'rgba(255, 255, 255, 0.45)'
        })
      }
      loadingTimer = null
    }, 300)
  }
}

function stopGlobalLoading(config) {
  if (config?.silentLoading) return
  pendingCount = Math.max(0, pendingCount - 1)
  if (pendingCount === 0) {
    if (loadingTimer) {
      clearTimeout(loadingTimer)
      loadingTimer = null
    }
    if (loadingInstance) {
      loadingInstance.close()
      loadingInstance = null
    }
  }
}

// ==================== 请求拦截器 ====================
// 每个请求发出前自动注入 JWT Token，实现无感知认证
request.interceptors.request.use(
  (config) => {
    startGlobalLoading(config)
    config.baseURL = getApiBaseUrl()
    config.timeout = getRequestTimeoutMs()
    // 从pinia store获取token
    const userStore = useUserStore()
    const token = typeof userStore.token === 'string' ? userStore.token.replace(/^Bearer\s+/i, '').trim() : ''

    if (token && !isLocalToken(token)) {
      config.headers.Authorization = `Bearer ${token}`
    } else if (config.headers?.Authorization) {
      delete config.headers.Authorization
    }
    
    return config
  },
  (error) => {
    stopGlobalLoading(error?.config)
    console.error('请求拦截器错误:', error)
    return Promise.reject(error)
  }
)

// ==================== 响应拦截器 ====================
// 统一处理后端返回的错误状态码，对应论文表10（接口约束规范）
// 后端所有错误都归一化为 { success: false, error: { code, message } } 格式
request.interceptors.response.use(
  (response) => {
    stopGlobalLoading(response?.config)
    // 直接返回响应数据
    return response.data
  },
  (error) => {
    stopGlobalLoading(error?.config)

    // silentError: skip all error toasts — caller handles the error itself
    if (error?.config?.silentError) {
      return Promise.reject(error)
    }

    console.error('响应拦截器错误:', error)

    // 处理不同的错误状态码
    if (error.response) {
      const { status, data } = error.response
      
      switch (status) {
        case 401:
          if (shouldSkipAuthErrorHandling(error?.config)) {
            break
          }
          if (handlingAuthExpired) {
            break
          }
          // 未授权，清除token并跳转到登录页
          const userStore = useUserStore()
          if (!isLocalToken(userStore.token)) {
            handlingAuthExpired = true
            userStore.logout({ skipRemote: true }).finally(() => {
              handlingAuthExpired = false
            })
            ElMessage.error('登录已过期，请重新登录')
            // 如果不在登录页面，则跳转到登录页面
            if (window.location.pathname !== '/login') {
              window.location.href = '/login'
            }
          }
          break
        case 403:
          ElMessage.error('权限不足')
          break
        case 404:
          ElMessage.error('请求的资源不存在')
          break
        case 500:
          ElMessage.error(data?.message || data?.error || '服务器内部错误，请稍后重试')
          break
        default:
          ElMessage.error(data?.message || getFriendlyErrorMessage(error, '请求失败'))
      }
    } else if (error.request) {
      // 网络错误
      if (getConnectionMode() === 'local') {
        ElMessage.warning('当前处于单机模式，云端接口不可用')
      } else {
        ElMessage.error(getFriendlyErrorMessage(error, '网络连接失败，请检查网络'))
      }
    } else {
      // 其他错误
      ElMessage.error(getFriendlyErrorMessage(error, '请求配置错误'))
    }
    
    return Promise.reject(error)
  }
)

export default request
