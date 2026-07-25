import axios from 'axios'
import { useUserStore } from '@/stores/user'
import { httpStart, httpDone } from '@/composables/useGlobalLoading'
import { notifyError, deriveErrorMessage } from '@/api/notify'

// Cap how long a normal API call may hang before failing. Streaming chat uses
// fetch() (not this client), so long generations are unaffected. A dead backend
// now fails in ~30s instead of the old 120s (× retry ≈ 4 min) freeze. Tunable.
const DEFAULT_TIMEOUT = Number(import.meta.env.VITE_AI_HTTP_TIMEOUT_MS) || 30000

const request = axios.create({
  baseURL: import.meta.env.VITE_AI_API_BASE_URL || '',
  timeout: DEFAULT_TIMEOUT,
})

const RETRYABLE_METHODS = new Set(['get', 'head', 'options'])

function isNetworkLikeError(error) {
  const lower = String(error?.message || '').toLowerCase()
  return (
    !error?.response &&
    (
      lower.includes('network error') ||
      lower.includes('failed to fetch') ||
      lower.includes('timeout') ||
      lower.includes('econnrefused') ||
      error?.code === 'ECONNABORTED'
    )
  )
}

function getRequestUrl(error) {
  return String(error?.config?.url || '').trim()
}

request.interceptors.request.use(config => {
  httpStart()
  const userStore = useUserStore()
  if (userStore.token) {
    config.headers.Authorization = `Bearer ${userStore.token}`
  }
  return config
}, error => {
  // Request never left the building — balance the counter so the bar can clear.
  httpDone()
  return Promise.reject(error)
})

request.interceptors.response.use(
  response => {
    httpDone()
    return response
  },
  async error => {
    // Settle this attempt's counter first; a retry below opens a fresh request
    // (and thus a fresh httpStart), keeping the in-flight count balanced.
    httpDone()
    const cfg = error?.config || {}
    const method = String(cfg?.method || '').toLowerCase()
    const requestUrl = getRequestUrl(error)

    if (isNetworkLikeError(error) && !cfg.__networkRetryDone && RETRYABLE_METHODS.has(method)) {
      cfg.__networkRetryDone = true
      await new Promise(resolve => setTimeout(resolve, 350))
      return request(cfg)
    }

    if (isNetworkLikeError(error)) {
      error.userMessage = `网络连接异常：无法访问 ${requestUrl || '/api'}。请确认 ai-backend 服务可用后重试。`
    }

    const isLoginRequest = requestUrl.includes('/api/auth/login')
    if (error.response?.status === 401 && !isLoginRequest) {
      const userStore = useUserStore()
      userStore.logout()
      window.location.href = '/login'
    }
    if (error.response?.status === 403) {
      const msg = String(error?.response?.data?.message || error?.response?.data?.error || '').toLowerCase()
      if (msg.includes('admin') || msg.includes('管理员')) {
        error.userMessage = '当前账号没有管理员权限，请切换到用户视图或使用管理员账号登录。'
      }
    }
    if (error.userMessage) {
      error.message = error.userMessage
    }

    // 集中式错误反馈（闭合"userMessage 无人消费"缺口）。默认对失败请求弹一条去重
    // 提示，覆盖网络异常 / 5xx / 4xx。两类情形不弹，避免噪声与重复：
    //   - 401 已跳登录页（弹了也随即被卸载）；登录请求由页面自行处理。
    //   - config.silent === true：调用方自带可见降级 UI（如 FeatureCatalog 错误态、
    //     AgentDashboard 轮询退避），不需要再叠一条 toast。
    const status = error.response?.status
    const silent = cfg.silent === true
    if (!silent && !(status === 401 && !isLoginRequest) && !isLoginRequest) {
      notifyError(deriveErrorMessage(error))
    }
    return Promise.reject(error)
  }
)

export default request
