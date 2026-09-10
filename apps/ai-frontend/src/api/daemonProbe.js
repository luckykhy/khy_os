// Daemon-namespace availability probe (DESIGN-ARCH-080 §6.2, decision D1 = 方案 Y).
//
// Three namespaces — /api/workflow, /api/marketplace, /api/plugins (32 endpoints
// in total) — exist only in the ai-backend daemon. A monolith-only install serves
// the same SPA from `dist/` but has none of those routes, so those pages used to
// 404 with no explanation. 32 endpoints is well past the ≤10 threshold at which
// 方案 X (mounting them on the monolith) was ruled worthwhile, so instead the UI
// probes once per session and hides the entries it cannot serve.
//
// The frontend has exactly one backend base (request.js reads a single
// VITE_AI_API_BASE_URL), so there is no per-namespace routing: the namespaces are
// uniformly mounted or uniformly absent. Probing one root per namespace is
// therefore sufficient, and the results are cached in sessionStorage so a page
// reload does not re-probe.
//
// Scope note: /api/proxy-subscriptions (the /proxies subscriptions half) IS in
// the monolith, and its /api/proxy-egress half already self-degrades in
// useProxies.js — so /proxies is deliberately not hidden.
import request from '@/api/request';

const PROBE_PATHS = {
  workflow: '/api/workflow',
  marketplace: '/api/marketplace',
};

// The cache key is deliberately session-scoped: the backend base is a
// build-time env var, so a stale probe cannot outlive the session in which the
// base was actually configured.
const SESSION_KEY = 'khy_ai_daemon_probe';
let cached = null;

// Probe one namespace root. Only a definite 404/405 means "this namespace is not
// mounted"; a network failure, 5xx or a static index.html fallback keeps the
// entry visible (fail open), because hiding a working feature would be the worse
// mistake. The call is silent so the probe itself never raises a toast.
async function probeOne(path) {
  try {
    await request.get(path, { silent: true });
    return true;
  } catch (err) {
    const status = err && err.response ? err.response.status : null;
    return status !== 404 && status !== 405;
  }
}

function readSessionCache() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Resolves to a record of namespace name -> availability, e.g.
// { workflow: false, marketplace: false }. Never rejects: a probe transport
// failure is indistinguishable from "available" and must not take the sidebar
// down with it.
export async function probeDaemonNamespaces() {
  if (cached) return cached;

  const remembered = readSessionCache();
  if (remembered) {
    cached = remembered;
    return cached;
  }

  const result = {};
  await Promise.all(
    Object.entries(PROBE_PATHS).map(async ([name, path]) => {
      result[name] = await probeOne(path);
    })
  );

  cached = result;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(result));
  } catch {
    // Non-fatal: the in-memory cache still serves this session.
  }
  return cached;
}
