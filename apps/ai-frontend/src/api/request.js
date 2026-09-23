import axios from 'axios';
import { isNetworkLikeError } from '@khy/ui-shared/http/errors';
import { useUserStore } from '@/stores/user';
import { httpStart, httpDone } from '@/composables/useGlobalLoading';
import { notifyError, deriveErrorMessage } from '@/api/notify';

// Cap how long a normal API call may hang before failing. Streaming chat uses
// fetch() (not this client), so long generations are unaffected. A dead backend
// now fails in ~30s instead of the old 120s (× retry ≈ 4 min) freeze. Tunable.
const DEFAULT_TIMEOUT = Number(import.meta.env.VITE_AI_HTTP_TIMEOUT_MS) || 30000;

const request = axios.create({
  baseURL: import.meta.env.VITE_AI_API_BASE_URL || '',
  timeout: DEFAULT_TIMEOUT,
});

const RETRYABLE_METHODS = new Set(['get', 'head', 'options']);
// Single source of truth for "which auth endpoints must NOT run the
// 401 → refresh / logout flow on themselves" — a 401 on these is the *result*
// of a login/refresh attempt, not a stale token. Both the refresh gate
// (L81) and the logout-redirect gate (L116) use this predicate so a new
// sub-route under /api/auth/login can't slip past one but trip the other.
const AUTH_RETRY_URLS = new Set(['/api/auth/login', '/api/auth/refresh', '/api/auth/qr-confirm']);

function getRequestUrl(error) {
  return String(error?.config?.url || '').trim();
}

let isRefreshing = false;
let refreshSubscribers = [];

function onRefreshed(newToken) {
  refreshSubscribers.forEach((cb) => cb(newToken));
  refreshSubscribers = [];
}

/**
 * Shared 401 recovery: try to refresh the access token (de-duping concurrent
 * callers) and hand back a new Bearer token, or false when the session is
 * genuinely dead. Exported so the bare-fetch path (authedFetch.js) reuses the
 * exact same refresh-before-logout policy instead of hard-redirecting on a
 * transient 401 mid-stream.
 * @returns {Promise<string|false>} new access token on success, false when the
 *   caller should fall through to logout.
 */
export async function tryRefreshAndRotate() {
  const userStore = useUserStore();
  if (isRefreshing) {
    // Another refresh is in flight — piggyback on its result.
    return new Promise((resolve) => {
      refreshSubscribers.push((newToken) => resolve(newToken || false));
    });
  }
  isRefreshing = true;
  let refreshed = false;
  try {
    refreshed = await userStore.refreshAccessToken();
    if (refreshed) {
      onRefreshed(userStore.token);
      return userStore.token;
    }
    return false;
  } finally {
    isRefreshing = false;
  }
}

function finalizeUnauthorized() {
  const userStore = useUserStore();
  userStore.logout();
  try {
    if (!String(window.location?.pathname || '').startsWith('/login')) {
      window.location.href = '/login';
    }
  } catch {
    /* noop */
  }
}

request.interceptors.request.use(
  (config) => {
    httpStart();
    const userStore = useUserStore();
    if (userStore.token) {
      config.headers.Authorization = `Bearer ${userStore.token}`;
    }
    return config;
  },
  (error) => {
    // Request never left the building — balance the counter so the bar can clear.
    httpDone();
    return Promise.reject(error);
  }
);

request.interceptors.response.use(
  (response) => {
    httpDone();
    // 四端统一错误格式透传: apiErrorFormatter 返回的 code/reason/suggestions 挂在 response.data 上
    return response;
  },
  async (error) => {
    // Settle this attempt's counter first; a retry below opens a fresh request
    // (and thus a fresh httpStart), keeping the in-flight count balanced.
    // Skip httpDone here when a retry is pending — the retry request's own
    // response interceptor will call httpDone exactly once, leaving the counter
    // balanced. Without this guard, both the original error's httpDone AND the
    // retry's response httpDone fire, leaving httpPending stuck at +1 and the
    // progress bar frozen.
    const cfg = error?.config || {};
    const method = String(cfg?.method || '').toLowerCase();
    const requestUrl = getRequestUrl(error);
    const isRetryPending = cfg.__networkRetryDone || cfg.__authRetryDone;
    if (!isRetryPending) httpDone();

    if (isNetworkLikeError(error) && !cfg.__networkRetryDone && RETRYABLE_METHODS.has(method)) {
      cfg.__networkRetryDone = true;
      await new Promise((resolve) => setTimeout(resolve, 350));
      return request(cfg);
    }

    if (isNetworkLikeError(error)) {
      error.userMessage = `网络连接异常：无法访问 ${requestUrl || '/api'}。请确认 ai-backend 服务可用后重试。`;
    }

    // Token refresh: on 401, try to refresh the access token before logging out.
    // Skip refresh for auth endpoints themselves (login, refresh, qr-confirm).
    const isAuthEndpoint = AUTH_RETRY_URLS.has(requestUrl);
    if (error.response?.status === 401 && !isAuthEndpoint && !cfg.__authRetryDone) {
      const newToken = await tryRefreshAndRotate();
      if (newToken) {
        cfg.headers.Authorization = `Bearer ${newToken}`;
        cfg.__authRetryDone = true;
        httpStart();
        return request(cfg);
      }
      // Refresh failed → session is genuinely dead.
      finalizeUnauthorized();
    }

    // Logout gate: a 401 that is NOT on a known auth endpoint and did not go
    // through the refresh path above (fresh 401, or refresh already attempted)
    // means the session is dead → log out + redirect. Use the same Set for the
    // predicate so a 401 on /api/auth/refresh (refresh-token rejected) falls
    // into this branch and logs out, while /api/auth/login (wrong credentials)
    // is handled by the login page itself and never triggers a redirect loop.
    if (error.response?.status === 401 && !isAuthEndpoint) {
      finalizeUnauthorized();
    }
    if (error.response?.status === 403) {
      const msg = String(
        error?.response?.data?.message || error?.response?.data?.error || ''
      ).toLowerCase();
      if (msg.includes('admin') || msg.includes('管理员')) {
        error.userMessage = '当前账号没有管理员权限，请改用管理员账号登录。';
      }
    }
    if (error.userMessage) {
      error.message = error.userMessage;
    }

    // 集中式错误反馈（闭合"userMessage 无人消费"缺口）。默认对失败请求弹一条去重
    // 提示，覆盖网络异常 / 5xx / 4xx。两类情形不弹，避免噪声与重复：
    //   - 401 已跳登录页（弹了也随即被卸载）；登录请求由页面自行处理。
    //   - config.silent === true：调用方自带可见降级 UI（如 FeatureCatalog 错误态、
    //     AgentDashboard 轮询退避），不需要再叠一条 toast。
    const status = error.response?.status;
    const silent = cfg.silent === true;
    // 401 已触发登出/跳登录（finalizeUnauthorized），登录请求由页面自行处理，
    // 两者都不再叠 toast。isAuthEndpoint 与上面登出门是同一个谓词。
    if (!silent && status !== 401 && !isAuthEndpoint) {
      notifyError(deriveErrorMessage(error));
    }
    return Promise.reject(error);
  }
);

export default request;
