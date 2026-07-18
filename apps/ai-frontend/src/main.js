import { createApp } from 'vue'
import { createPinia } from 'pinia'
// Element Plus is loaded on demand via unplugin-vue-components (see vite.config.js):
// each page pulls only the <el-*> components + styles it actually uses. The two
// imperative APIs below are called from <script> (not templates) so the resolver
// can't see them — import their styles explicitly. Dark-theme CSS vars are kept.
import 'element-plus/theme-chalk/dark/css-vars.css'
import 'element-plus/theme-chalk/el-message.css'
import 'element-plus/theme-chalk/el-message-box.css'
import 'element-plus/theme-chalk/el-overlay.css'
import './styles/newapi-theme.css'
import App from './App.vue'
import router from './router'
// Side-effect import: initializes the theme singleton and applies the
// persisted (or system-preferred) theme to <html> before the app mounts.
import './composables/useTheme'
import { notifyError, deriveErrorMessage } from '@/api/notify'

const USER_STORAGE_KEY = 'khy_ai_user'
const WORKSPACE_STORAGE_KEY = 'khy_ai_workspace'

function clearLocalAuthState() {
  try {
    localStorage.removeItem('token')
    localStorage.removeItem(USER_STORAGE_KEY)
    localStorage.removeItem(WORKSPACE_STORAGE_KEY)
  } catch {
    // ignore
  }
}

async function syncAuthFromManageControl(controlBase, token) {
  const endpoint = `${controlBase}/auth/bootstrap?token=${encodeURIComponent(token)}`
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3500)
    const res = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) {
      clearLocalAuthState()
      return false
    }
    const payload = await res.json().catch(() => ({}))
    const bootstrap = payload && payload.data && typeof payload.data === 'object' ? payload.data : null
    const bootstrapToken = String(bootstrap?.token || '').trim()
    if (!bootstrapToken) {
      clearLocalAuthState()
      return false
    }
    localStorage.setItem('token', bootstrapToken)
    // Force user/profile refresh from /api/auth/me to avoid stale role/workspace.
    localStorage.removeItem(USER_STORAGE_KEY)
    localStorage.removeItem(WORKSPACE_STORAGE_KEY)
    return true
  } catch {
    clearLocalAuthState()
    return false
  }
}

async function initManageLifecycleBridge() {
  if (typeof window === 'undefined') return

  const params = new URLSearchParams(window.location.search || '')
  const controlBase = String(params.get('khy_manage_ctl') || '').trim().replace(/\/+$/, '')
  const token = String(params.get('khy_manage_token') || '').trim()
  if (!controlBase || !token) return

  // Only keepalive against local control endpoints from local pages.
  // This avoids browser cross-origin/private-network policy errors when
  // the page is opened from a non-local origin.
  const isLoopbackHost = (host = '') => /^(localhost|127(?:\.\d+){0,3}|\[::1\]|::1)$/i.test(String(host || '').trim())
  try {
    const page = new URL(window.location.href)
    const ctl = new URL(controlBase)
    const isSameOrigin = page.origin === ctl.origin
    const bothLoopback = isLoopbackHost(page.hostname) && isLoopbackHost(ctl.hostname)
    if (!isSameOrigin && !bothLoopback) return
  } catch {
    return
  }

  await syncAuthFromManageControl(controlBase, token)

  const sid = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const endpointWithToken = (path) => {
    const joiner = path.includes('?') ? '&' : '?'
    return `${controlBase}${path}${joiner}token=${encodeURIComponent(token)}`
  }

  let heartbeatTimer = null
  let bridgeEnabled = true
  let failureCount = 0
  let closed = false
  const maxFailures = 3

  const disableBridge = () => {
    if (!bridgeEnabled) return
    bridgeEnabled = false
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    window.removeEventListener('beforeunload', close)
    window.removeEventListener('pagehide', close)
  }

  const markFailure = () => {
    failureCount += 1
    if (failureCount >= maxFailures) {
      // Stop retry loop when control endpoint is consistently unreachable.
      disableBridge()
    }
  }

  const post = (path, payload = {}, keepalive = false) => {
    if (!bridgeEnabled) return Promise.resolve(false)
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 2500)
      return fetch(endpointWithToken(path), {
        method: 'POST',
        // Keep it a simple request (no custom headers / no preflight).
        body: JSON.stringify({ sid, ...payload }),
        keepalive,
        signal: controller.signal,
      })
        .then((res) => {
          clearTimeout(timeout)
          if (!res.ok) {
            markFailure()
            return false
          }
          failureCount = 0
          return true
        })
        .catch(() => {
          clearTimeout(timeout)
          markFailure()
          return false
        })
    } catch {
      markFailure()
      return Promise.resolve(false)
    }
  }

  const close = () => {
    if (closed) return
    closed = true
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (!bridgeEnabled) return

    if (navigator.sendBeacon) {
      try {
        const blob = new Blob([JSON.stringify({ sid })], { type: 'application/json' })
        const closeUrl = endpointWithToken('/close')
        navigator.sendBeacon(closeUrl, blob)
        return
      } catch {
        // fallback to fetch below
      }
    }

    post('/close', {}, true)
  }

  post('/open')
  heartbeatTimer = setInterval(() => {
    post('/ping')
  }, 10000)

  window.addEventListener('beforeunload', close)
  window.addEventListener('pagehide', close)

  try {
    const cleanUrl = `${window.location.pathname}${window.location.hash || ''}`
    window.history.replaceState({}, document.title, cleanUrl)
  } catch {
    // ignore URL cleanup errors
  }
}

// 全局错误兜底。此前渲染期抛错 / 未捕获的 Promise rejection 只进控制台，
// 用户面对一个"卡住但无反馈"的界面。这里挂两道网，复用 notify 去重层给出
// 一句人话，并把细节留给 console 供排查。两道网都 fail-soft：兜底本身绝不
// 再抛，也不阻断启动。noisy 场景由 notify 的 3s 去重窗口自然收敛。
function installGlobalErrorHandlers(app) {
  try {
    app.config.errorHandler = (err, _instance, info) => {
      // 渲染 / 生命周期 / watcher 期间的同步错误。
      try { console.error('[vue:error]', info, err) } catch { /* noop */ }
      // axios 错误已在拦截器弹过；避免二次提示（拦截器写入 userMessage/message）。
      const isHandledHttp = err && (err.userMessage || err.isAxiosError || err.response)
      if (!isHandledHttp) {
        notifyError(deriveErrorMessage(err, { fallback: '页面渲染出现问题，部分内容可能未正常显示。' }))
      }
    }
  } catch { /* noop */ }

  if (typeof window !== 'undefined') {
    try {
      window.addEventListener('unhandledrejection', (event) => {
        const reason = event?.reason
        try { console.error('[unhandledrejection]', reason) } catch { /* noop */ }
        // 已被拦截器处理过的 HTTP 错误不再重复弹（调用方 .catch 缺失才走到这里）。
        const isHandledHttp = reason && (reason.userMessage || reason.isAxiosError || reason.response)
        // 取消类（AbortController 主动中止）静默：这是预期行为不是故障。
        const isAbort = reason && (reason.name === 'AbortError' || reason.code === 'ABORT_ERR')
        if (!isHandledHttp && !isAbort) {
          notifyError(deriveErrorMessage(reason, { fallback: '出现了一个未预期的问题，请重试；若反复出现请刷新页面。' }))
        }
      })
    } catch { /* noop */ }
  }
}

function mountApp() {
  const app = createApp(App)
  installGlobalErrorHandlers(app)
  app.use(createPinia())
  app.use(router)
  app.mount('#app')
}

async function bootstrapAndMount() {
  try {
    await initManageLifecycleBridge()
  } finally {
    mountApp()
  }
}

bootstrapAndMount()
