import axios from 'axios'
import { useUserStore } from '@/stores/user'
import { ElLoading, ElMessage } from 'element-plus'
import router from '@/router'
import { getFriendlyErrorMessage } from '@/utils/errorMessage'
import { getApiBaseUrl, getRequestTimeoutMs, isMobileViewport, getConnectionMode } from '@/utils/connectionMode'
import { isLocalToken } from '@/services/localAuthService'

const request = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: getRequestTimeoutMs()
})

let pendingCount = 0
let loadingInstance = null
let handlingAuthExpired = false

function isLogoutRequest(config) {
  const url = String(config?.url || '')
  return url.includes('/auth/logout')
}

function shouldSkipAuthErrorHandling(config) {
  return Boolean(config?.__skipAuthErrorHandling) || isLogoutRequest(config)
}

function startGlobalLoading(config) {
  if (config?.silentLoading) return
  // 移动端请求频繁时不展示全屏loading，提升体感流畅度
  if (isMobileViewport()) return
  pendingCount += 1
  if (pendingCount === 1) {
    loadingInstance = ElLoading.service({
      lock: true,
      text: '加载中...',
      background: 'rgba(255, 255, 255, 0.45)'
    })
  }
}

function stopGlobalLoading(config) {
  if (config?.silentLoading) return
  pendingCount = Math.max(0, pendingCount - 1)
  if (pendingCount === 0 && loadingInstance) {
    loadingInstance.close()
    loadingInstance = null
  }
}

// 请求拦截器
request.interceptors.request.use(
  (config) => {
    startGlobalLoading(config)
    // 运行时动态更新，支持移动端切换服务器地址
    config.baseURL = getApiBaseUrl()
    config.timeout = getRequestTimeoutMs()

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
    return Promise.reject(error)
  }
)

// 响应拦截器
request.interceptors.response.use(
  (response) => {
    stopGlobalLoading(response?.config)
    return response.data
  },
  (error) => {
    stopGlobalLoading(error?.config)
    if (error.response) {
      const { status, data } = error.response
      
      if (status === 401) {
        if (shouldSkipAuthErrorHandling(error?.config)) {
          return Promise.reject(error)
        }
        if (handlingAuthExpired) {
          return Promise.reject(error)
        }

        const userStore = useUserStore()
        if (!isLocalToken(userStore.token)) {
          handlingAuthExpired = true
          userStore.logout({ skipRemote: true }).finally(() => {
            handlingAuthExpired = false
          })
          ElMessage.error('登录已过期，请重新登录')
          if (router.currentRoute.value.path !== '/login') {
            router.push('/login')
          }
        }
      } else {
        ElMessage.error(data?.message || getFriendlyErrorMessage(error, '请求失败'))
      }
    } else {
      if (getConnectionMode() === 'local') {
        ElMessage.warning('当前处于单机模式，云端接口不可用')
      } else {
        ElMessage.error(getFriendlyErrorMessage(error, '网络错误，请检查网络连接'))
      }
    }
    
    return Promise.reject(error)
  }
)

export default request
