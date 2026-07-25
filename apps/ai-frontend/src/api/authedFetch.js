// authedFetch — 裸 fetch 的统一带认证入口。
//
// 项目里流式聊天 / 文件上传 / 追溯 / 工作流 SSE 都直接用 fetch(),各自手抄一遍
// `Authorization: Bearer ${token}`,且:
//   - 非流式请求没有超时 → 后端挂死时前端无限等待(axios 侧已有 30s 上限,fetch 侧没有)。
//   - 401 不会触发登出跳转(只有 axios 拦截器做了),token 过期后这些请求静默失败。
// 这里收敛成一个薄封装,与 api/request.js 的拦截器行为对齐(token 注入 + 401 登出),
// 同时保留 fetch 的流式能力:
//   - 默认 30s 超时;流式场景传 { stream: true } 关闭超时(长时间生成不受影响)。
//   - 调用方可传入自己的 signal(如"停止生成"按钮的 AbortController),内部超时与
//     外部 signal 二者任一触发都会中止请求。
//   - 返回原始 Response,解析/错误展示交给调用方(与既有代码习惯一致,不改语义)。
//
// 设计为 fail-soft:token 读取失败不阻断请求;登出跳转包 try/catch。
import { useUserStore } from '@/stores/user'

const DEFAULT_TIMEOUT = Number(import.meta.env.VITE_AI_HTTP_TIMEOUT_MS) || 30000

function readToken() {
  try {
    return useUserStore().token || ''
  } catch {
    return ''
  }
}

function handleUnauthorized() {
  try {
    const store = useUserStore()
    store.logout()
  } catch { /* noop */ }
  try {
    if (typeof window !== 'undefined' && !String(window.location?.pathname || '').startsWith('/login')) {
      window.location.href = '/login'
    }
  } catch { /* noop */ }
}

/**
 * 带认证的 fetch。注入 Bearer token、可选超时、401 自动登出。
 * @param {string} url
 * @param {RequestInit & { stream?: boolean, timeout?: number, silent?: boolean }} [options]
 *   - stream: true 时关闭内部超时(供 SSE / 流式响应长连接使用)。
 *   - timeout: 覆盖默认超时(毫秒);0 或负数等同关闭。
 *   - silent: 401 时不触发登出跳转(调用方自行处理),默认 false。
 * @returns {Promise<Response>}
 */
export async function authedFetch(url, options = {}) {
  const { stream = false, timeout, silent = false, headers, signal: externalSignal, ...rest } = options

  const token = readToken()
  const mergedHeaders = { ...(headers || {}) }
  if (token && !mergedHeaders.Authorization && !mergedHeaders.authorization) {
    mergedHeaders.Authorization = `Bearer ${token}`
  }

  // 组合内部超时与外部 signal:任一触发都中止。流式关闭超时。
  const controller = new AbortController()
  const effectiveTimeout = stream ? 0 : (Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT)
  let timer = null
  if (effectiveTimeout > 0) {
    timer = setTimeout(() => {
      try { controller.abort(new DOMException('timeout', 'AbortError')) } catch { controller.abort() }
    }, effectiveTimeout)
  }
  if (externalSignal) {
    if (externalSignal.aborted) {
      try { controller.abort(externalSignal.reason) } catch { controller.abort() }
    } else {
      externalSignal.addEventListener('abort', () => {
        try { controller.abort(externalSignal.reason) } catch { controller.abort() }
      }, { once: true })
    }
  }

  try {
    const res = await fetch(url, { ...rest, headers: mergedHeaders, signal: controller.signal })
    if (res.status === 401 && !silent) {
      handleUnauthorized()
    }
    return res
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export default authedFetch
