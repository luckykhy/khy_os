import request from '@/api/request';

/**
 * Channel APIs — frontend API client.
 *
 * Convention: every method resolves to the backend envelope `{ success, data,
 * metadata }`; callers read `res.data.<field>`. The axios interceptor already
 * toasts errors, so views keep a narrow try/catch and no central error UI.
 *
 * SECURITY: `reveal(id)` is the ONLY place a plaintext key is produced, and it
 * is audited on the server. Never store the result in localStorage / sessionStorage.
 */
export const channelApisApi = {
  list(params = {}) {
    return request.get('/api/channel-apis', { params }).then((r) => r.data);
  },
  get(id) {
    return request.get(`/api/channel-apis/${id}`).then((r) => r.data);
  },
  create(payload) {
    return request.post('/api/channel-apis', payload).then((r) => r.data);
  },
  update(id, payload) {
    return request.put(`/api/channel-apis/${id}`, payload).then((r) => r.data);
  },
  remove(id) {
    return request.delete(`/api/channel-apis/${id}`).then((r) => r.data);
  },
  // One-shot plaintext reveal + key-substituted config blocks (server-audited).
  reveal(id) {
    return request.post(`/api/channel-apis/${id}/reveal`).then((r) => r.data);
  },
  // Config guide with placeholder keys (no plaintext round-trip).
  config(id) {
    return request.get(`/api/channel-apis/${id}/config`).then((r) => r.data);
  },
  // Built-in per-agent config docs (independent of stored rows).
  agentGuides() {
    return request.get('/api/channel-apis/guide').then((r) => r.data);
  },
};
