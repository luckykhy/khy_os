import request from '@/api/request';

/**
 * GUI Eval — frontend API client.
 * Convention: every method returns { data } or throws; callers use try/catch + ElMessage.
 */
export const guiEvalApi = {
  // ── Tasks ────────────────────────────────────────────────────────
  listTasks(params = {}) {
    return request.get('/gui-eval/tasks', { params }).then((r) => r.data);
  },
  getTask(id) {
    return request.get(`/gui-eval/tasks/${id}`).then((r) => r.data);
  },
  createTask(payload) {
    return request.post('/gui-eval/tasks', payload).then((r) => r.data);
  },
  updateTask(id, payload) {
    return request.put(`/gui-eval/tasks/${id}`, payload).then((r) => r.data);
  },
  deleteTask(id) {
    return request.delete(`/gui-eval/tasks/${id}`).then((r) => r.data);
  },

  // ── Runs ─────────────────────────────────────────────────────────
  executeTask(id, opts = {}) {
    return request.post(`/gui-eval/tasks/${id}/run`, opts).then((r) => r.data);
  },
  listRuns(params = {}) {
    return request.get('/gui-eval/runs', { params }).then((r) => r.data);
  },
  getRun(id) {
    return request.get(`/gui-eval/runs/${id}`).then((r) => r.data);
  },
  evaluateRun(id) {
    return request.post(`/gui-eval/runs/${id}/evaluate`).then((r) => r.data);
  },
  submitReview(id, review) {
    return request.post(`/gui-eval/runs/${id}/review`, review).then((r) => r.data);
  },

  // ── Stats / Leaderboard ──────────────────────────────────────────
  getStats() {
    return request.get('/gui-eval/stats').then((r) => r.data);
  },
  getLeaderboard() {
    return request.get('/gui-eval/leaderboard').then((r) => r.data);
  },
};
