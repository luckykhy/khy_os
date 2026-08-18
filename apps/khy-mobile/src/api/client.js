import { clearSession, getSession, setSession } from './secureSession';
import { loadRuntime } from './runtime';

let refreshPromise = null;
let onSessionExpired = null;

export function setSessionExpiredHandler(handler) {
  onSessionExpired = handler;
}

function authData(payload) {
  const data = payload?.data || payload || {};
  return {
    accessToken: data.accessToken || data.access_token || data.token || '',
    refreshToken: data.refreshToken || data.refresh_token || '',
    user: data.user || null,
  };
}

async function endpoint(path) {
  const runtime = await loadRuntime();
  if (!runtime?.apiBaseUrl) throw new Error('尚未配置后端地址');
  return `${runtime.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

async function refreshSession() {
  const session = await getSession();
  if (!session?.refreshToken) throw new Error('登录会话已失效');
  const response = await fetch(await endpoint('/api/auth/refresh'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || '登录会话续期失败');
  const next = authData(payload);
  if (!next.accessToken) throw new Error('续期响应缺少访问令牌');
  const merged = { ...session, ...next, refreshToken: next.refreshToken || session.refreshToken };
  await setSession(merged);
  return merged;
}

async function expireSession() {
  await clearSession();
  if (onSessionExpired) await onSessionExpired();
}

export async function apiFetch(path, options = {}) {
  const { auth = true, retryAuth = true, headers, ...init } = options;
  const session = auth ? await getSession() : null;
  const requestHeaders = new Headers(headers || {});
  if (init.body && !requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
  if (session?.accessToken) requestHeaders.set('Authorization', `Bearer ${session.accessToken}`);
  let response = await fetch(await endpoint(path), { ...init, headers: requestHeaders });
  if (response.status !== 401 || !auth || !retryAuth) return response;
  try {
    refreshPromise ||= refreshSession().finally(() => { refreshPromise = null; });
    const refreshed = await refreshPromise;
    requestHeaders.set('Authorization', `Bearer ${refreshed.accessToken}`);
    response = await fetch(await endpoint(path), { ...init, headers: requestHeaders });
    if (response.status === 401) await expireSession();
    return response;
  } catch (error) {
    await expireSession();
    throw error;
  }
}

export async function apiJson(path, options = {}) {
  const response = await apiFetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `请求失败（HTTP ${response.status}）`);
  }
  return payload.data ?? payload;
}

export async function login(username, password) {
  const payload = await apiJson('/api/auth/login', {
    method: 'POST',
    auth: false,
    retryAuth: false,
    body: JSON.stringify({ username, password }),
  });
  const session = authData(payload);
  if (!session.accessToken) throw new Error('登录响应缺少访问令牌');
  await setSession(session);
  return session;
}

export async function checkHealth(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/health`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`健康检查失败（HTTP ${response.status}）`);
  return response.json().catch(() => ({}));
}
