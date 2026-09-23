import request from '@/api/request'

/**
 * 获取跨设备交接快照
 * @param {Object} params - 查询参数
 * @returns {Promise<Object>}
 */
export function getHandoverSnapshot(params = {}) {
  return request({
    url: '/large-tasks/handover/snapshot',
    method: 'get',
    params,
    silentLoading: true
  })
}

/**
 * 获取移动端紧凑快照
 * @param {Object} params - 查询参数
 * @returns {Promise<Object>}
 */
export function getHandoverSnapshotMobile(params = {}) {
  return getHandoverSnapshot({
    ...params,
    mobile: true
  })
}

// ─── 大型任务看板（跨端 AI 编程任务泳道编排）────────────────────────────────
// 后端挂载点 /api/large-tasks（见 services/backend/server.js）。
// 注意：本模块的 request 已带 baseURL '/api'，故 url 一律**不带** /api 前缀。
//
// 动作门控的真源在后端（卡片 actions 字段），前端不再复判 —— 复判就是第二套规则。

/** 允许的动作名 → 端点段。 */
export const LARGE_TASK_ACTION_SEGMENTS = Object.freeze({
  pause: 'pause',
  resume: 'resume',
  cancel: 'cancel'
})

function _encodeId(taskId) {
  const id = String(taskId == null ? '' : taskId).trim()
  if (!id) throw new Error('taskId 不能为空')
  return encodeURIComponent(id)
}

/**
 * 只读聚合看板：泳道（执行体）× 列（状态）二维矩阵 + 计数。
 * @param {{status?: string, type?: string, source?: string, limit?: number}} params
 * @returns {Promise<{success: boolean, data: Object}>}
 */
export function getTaskBoard(params = {}) {
  return request({
    url: '/large-tasks/board',
    method: 'get',
    params,
    silentLoading: true
  })
}

export function pauseLargeTask(taskId) {
  return request({
    url: `/large-tasks/${_encodeId(taskId)}/pause`,
    method: 'post'
  })
}

export function resumeLargeTask(taskId) {
  return request({
    url: `/large-tasks/${_encodeId(taskId)}/resume`,
    method: 'post'
  })
}

/** reason 只在非空时下发，避免用空串覆盖后端默认原因。 */
export function cancelLargeTask(taskId, reason = '') {
  const body = String(reason || '').trim() ? { reason: String(reason).trim() } : {}
  return request({
    url: `/large-tasks/${_encodeId(taskId)}/cancel`,
    method: 'post',
    data: body
  })
}

/**
 * 按动作名派发（视图只保留一个调用点）。
 * 未登记的动作名直接 reject —— 静默忽略会让「点了没反应」变成难查的 bug。
 */
export function actOnLargeTask(taskId, action, options = {}) {
  switch (action) {
    case 'pause':
      return pauseLargeTask(taskId)
    case 'resume':
      return resumeLargeTask(taskId)
    case 'cancel':
      return cancelLargeTask(taskId, options.reason)
    default:
      return Promise.reject(new Error(`未知的任务动作：${action}`))
  }
}
