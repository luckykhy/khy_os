import request from '@/api/request';

/**
 * Single source for WebSocket endpoint derivation.
 *
 * The frontend has five WebSocket consumers (AI chat, file sync, the KHY OS
 * terminal, the desktop capture view, and the float ball) and each used to
 * re-implement this exact origin/baseURL derivation by copy-paste. A change to
 * the deployment shape — same-origin instead of a proxied base, HTTPS instead of
 * plain — would silently desync any copy that was not updated in step.
 *
 * The endpoint is derived rather than hardcoded (repo rule 1):
 *   base = request.defaults.baseURL (i.e. VITE_AI_API_BASE_URL) when set,
 *          otherwise the page origin (same-origin deployment).
 * https: becomes wss:, everything else ws:.
 */
export function resolveWsUrl(path = '/ws') {
  const normalizedPath = `/${String(path || '/ws').replace(/^\/+/, '')}`;
  if (typeof window === 'undefined') return normalizedPath;

  const origin = String(window.location.origin || '').trim();
  const base = String(request.defaults.baseURL || '').trim();
  const url = base ? new URL(base, origin) : new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // The WS route is a bare path; any query or fragment on the page URL must not
  // leak into the socket target (and a trailing slash would break the route).
  url.pathname = normalizedPath;
  url.search = '';
  url.hash = '';
  return url.toString();
}
