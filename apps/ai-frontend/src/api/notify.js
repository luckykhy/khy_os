// notify — 集中式错误提示层(薄封装,复用 Element Plus 的 ElMessage)。
//
// 项目里 ElMessage 被直接调用 279 处,但没有统一的错误通知层——响应拦截器精心
// 生成的 error.userMessage 此前无人消费,用户看不到网络/服务端异常反馈。这里提供
// 一个**去重**的错误提示入口,供三处复用:axios 响应拦截器、全局 errorHandler、
// 以及裸 fetch 的 authedFetch 工具。不新造 toast 体系,只在 ElMessage 之上加:
//   - 去重:同一文案在短窗口内只弹一次,避免批量请求失败时刷屏。
//   - 静默开关:调用方可显式抑制(自带可见降级 UI 的页面无需再弹)。
//
// 设计为 fail-soft:ElMessage 不可用(极端环境)时降级为 console,绝不抛。
import { ElMessage } from 'element-plus'

// 同一文案的最近弹出时间戳。窗口内重复文案被抑制。
const recent = new Map()
const DEDUPE_WINDOW_MS = 3000

function shouldSuppress(key) {
  const now = Date.now()
  const last = recent.get(key)
  // 顺带清理过期项,避免 Map 无限增长。
  for (const [k, t] of recent) {
    if (now - t > DEDUPE_WINDOW_MS) recent.delete(k)
  }
  if (last && now - last < DEDUPE_WINDOW_MS) return true
  recent.set(key, now)
  return false
}

/**
 * 弹出一条错误提示(去重、fail-soft)。
 * @param {string} message 用户可读文案
 * @param {{ dedupe?: boolean, duration?: number }} [opts]
 */
export function notifyError(message, opts = {}) {
  const text = String(message || '').trim()
  if (!text) return
  const { dedupe = true, duration = 4000 } = opts
  if (dedupe && shouldSuppress(text)) return
  try {
    ElMessage({ message: text, type: 'error', duration, showClose: true })
  } catch {
    // Element Plus 不可用时不至于让调用链崩溃。
    try { console.error('[notify]', text) } catch { /* noop */ }
  }
}

/**
 * 从任意 error/HTTP 响应里推导一句人话文案(供拦截器/兜底/fetch 共用)。
 * @param {*} error
 * @param {{ fallback?: string }} [opts]
 * @returns {string}
 */
export function deriveErrorMessage(error, opts = {}) {
  const fallback = opts.fallback || '操作失败,请稍后重试。'
  if (!error) return fallback
  // 拦截器已备好的文案优先。
  if (error.userMessage) return String(error.userMessage)
  const status = error?.response?.status
  const serverMsg = error?.response?.data?.message || error?.response?.data?.error
  if (serverMsg) return String(serverMsg)
  if (status >= 500) return `服务端暂时开小差(${status}),我们已记录,请稍后再试。`
  if (status === 404) return '没找到这条内容,可能已被移动或删除。'
  if (status === 429) return '操作太频繁了,请稍等片刻再试。'
  if (status >= 400) return `请求未被接受(${status})。`
  if (error.message) return String(error.message)
  return fallback
}
