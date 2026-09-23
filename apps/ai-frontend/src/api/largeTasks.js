import request from '@/api/request';

/**
 * 大型任务看板 API 客户端。
 *
 * 后端挂载点：`/api/large-tasks`（`services/backend/server.js` 处挂了 `authMiddleware`）。
 * 约定与其他 api 模块一致：每个方法 resolve 出后端信封 `{ success, data, metadata }`，
 * 调用方读 `res.data.<字段>`；错误已由 axios 拦截器统一提示。
 *
 * 动作门控的**真源在后端**（卡片 `actions` 字段），本模块不做任何「这个状态能不能暂停」
 * 的判断 —— 前端再判一次就会出现两套规则，迟早漂移。
 */

const BASE = '/api/large-tasks';

/** 允许的动作名 → 后端端点段。新增动作只需改这里。 */
export const LARGE_TASK_ACTION_SEGMENTS = Object.freeze({
  pause: 'pause',
  resume: 'resume',
  cancel: 'cancel',
});

function encodeId(taskId) {
  const id = String(taskId == null ? '' : taskId).trim();
  if (!id) throw new Error('taskId 不能为空');
  return encodeURIComponent(id);
}

export const largeTasksApi = {
  /**
   * 只读聚合看板。
   * @param {{status?: string, type?: string, source?: string, limit?: number}} params
   */
  board(params = {}) {
    return request.get(`${BASE}/board`, { params }).then((r) => r.data);
  },

  pause(taskId) {
    return request.post(`${BASE}/${encodeId(taskId)}/pause`).then((r) => r.data);
  },

  resume(taskId) {
    return request.post(`${BASE}/${encodeId(taskId)}/resume`).then((r) => r.data);
  },

  /** `reason` 只在非空时下发，避免用空串覆盖后端的默认原因。 */
  cancel(taskId, reason = '') {
    const body = String(reason || '').trim() ? { reason: String(reason).trim() } : {};
    return request.post(`${BASE}/${encodeId(taskId)}/cancel`, body).then((r) => r.data);
  },

  /**
   * 按动作名派发（视图只保留一个调用点，避免 switch 散落）。
   * 未登记的动作名直接抛 —— 静默忽略会让「点了没反应」变成难查的 bug。
   */
  act(taskId, action, options = {}) {
    switch (action) {
      case 'pause':
        return this.pause(taskId);
      case 'resume':
        return this.resume(taskId);
      case 'cancel':
        return this.cancel(taskId, options.reason);
      default:
        return Promise.reject(new Error(`未知的任务动作：${action}`));
    }
  },
};

export default largeTasksApi;
