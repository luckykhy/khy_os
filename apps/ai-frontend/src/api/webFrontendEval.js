import request from '@/api/request';

/**
 * Web Frontend Eval API — 2D/3D Web 前端轨迹标注平台
 */
export const webFrontendEvalApi = {
  // ── Reference Data ───────────────────────────────────────────
  getLevels: () => request.get('/api/web-frontend-eval/reference/levels'),
  getCategories: () => request.get('/api/web-frontend-eval/reference/categories'),

  // ── Tasks ─────────────────────────────────────────────────────
  listTasks: (params = {}) => request.get('/api/web-frontend-eval/tasks', { params }),
  getTask: (id) => request.get(`/api/web-frontend-eval/tasks/${id}`),
  createTask: (data) => request.post('/api/web-frontend-eval/tasks', data),
  updateTask: (id, data) => request.put(`/api/web-frontend-eval/tasks/${id}`, data),
  deleteTask: (id) => request.delete(`/api/web-frontend-eval/tasks/${id}`),

  // ── Runs ──────────────────────────────────────────────────────
  listRuns: (params = {}) => request.get('/api/web-frontend-eval/runs', { params }),
  getRun: (id) => request.get(`/api/web-frontend-eval/runs/${id}`),
  createRun: (taskId, data = {}) =>
    request.post(`/api/web-frontend-eval/tasks/${taskId}/runs`, data),
  updateRun: (id, data) => request.put(`/api/web-frontend-eval/runs/${id}`, data),

  // ── Package & QC ─────────────────────────────────────────────
  assemblePackage: (runId) => request.post(`/api/web-frontend-eval/runs/${runId}/assemble`),
  completeRun: (runId, data = {}) =>
    request.post(`/api/web-frontend-eval/runs/${runId}/complete`, data),
  rejectRun: (runId, reason) =>
    request.post(`/api/web-frontend-eval/runs/${runId}/reject`, { reason }),
  submitSelfCheck: (runId, selfCheck) =>
    request.post(`/api/web-frontend-eval/runs/${runId}/self-check`, { selfCheck }),

  // ── Stats ─────────────────────────────────────────────────────
  getStats: () => request.get('/api/web-frontend-eval/stats'),
};
