// useRoutePrefetch — chunk warming so a sidebar click switches instantly.
//
// Every route view is a lazy `() => import('@/views/X.vue')`. On the FIRST
// visit to a page the browser must download that page's chunk (some are large:
// AIGateway / AIChat) before the view can render — that download is the "I have
// to wait for the page to load before I can click the next one" lag.
//
// We warm chunks two ways, both fire-and-forget and idempotent:
//   - prefetchView(path): warm a single view immediately (call on menu hover/focus).
//   - prefetchViewsIdle(paths): warm a batch during browser idle time, after the
//     first paint, so every sidebar destination is ready before it is clicked.
//
// `viewLoaders` is the SINGLE SOURCE OF TRUTH for view importers — the router
// (router/index.js) consumes the same map, so a prefetched chunk is byte-identical
// to the one the router resolves on navigation (Vite dedupes by module path).

// path -> dynamic importer. Keep keys aligned with the router's full paths.
export const viewLoaders = {
  '/': () => import('@/views/Layout.vue'),
  '/login': () => import('@/views/Login.vue'),
  '/home': () => import('@/views/UserHome.vue'),
  '/dashboard': () => import('@/views/AIDashboard.vue'),
  '/gateway': () => import('@/views/AIGateway.vue'),
  '/bridge-channels': () => import('@/views/BridgeChannels.vue'),
  '/accounts': () => import('@/views/AccountPool.vue'),
  '/assets-customers': () => import('@/views/AIAssetsCustomers.vue'),
  '/usage': () => import('@/views/UsageLogs.vue'),
  '/pricing': () => import('@/views/Pricing.vue'),
  '/monitor': () => import('@/views/AIMonitor.vue'),
  '/settings': () => import('@/views/Settings.vue'),
  '/agents': () => import('@/views/AgentDashboard.vue'),
  '/chat': () => import('@/views/AIChat.vue'),
  '/prompts': () => import('@/views/PromptLibrary.vue'),
  '/features': () => import('@/views/FeatureCatalog.vue'),
  '/khyos': () => import('@/views/KhyOsTerminal.vue'),
  '/khyos/desktop': () => import('@/views/KhyOsDesktop.vue'),
  '/my-gateway': () => import('@/views/MyGateway.vue'),
  '/workflows': () => import('@/views/Workflows.vue'),
  '/workflows/:id': () => import('@/views/WorkflowEditor.vue'),
  '/projects': () => import('@/views/Projects.vue'),
  '/marketplace': () => import('@/views/Marketplace.vue'),
  '/proxies': () => import('@/views/ProxyManagement.vue'),
  '/markdown': () => import('@/views/Markdown.vue'),
  '/not-found': () => import('@/views/NotFound.vue'),
}

// Chunks already requested — guards against re-importing on every hover.
const warmed = new Set()

// Warm one view's chunk now. Safe to call repeatedly; no-op once warmed.
export function prefetchView(path) {
  if (!path || warmed.has(path)) return
  const loader = viewLoaders[path]
  if (typeof loader !== 'function') return
  warmed.add(path)
  // Fire-and-forget. On failure (offline, chunk error) drop it from the set so a
  // later real navigation can retry; the router owns user-visible error handling.
  Promise.resolve()
    .then(loader)
    .catch(() => { warmed.delete(path) })
}

// Warm a batch of views during idle time, after first paint. Used to pre-warm
// every sidebar destination so switching never stalls on a first-visit download.
export function prefetchViewsIdle(paths) {
  if (typeof window === 'undefined' || !Array.isArray(paths)) return
  const run = () => { for (const p of paths) prefetchView(p) }
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 2000 })
  } else {
    // Fallback: defer past first paint without blocking it.
    setTimeout(run, 200)
  }
}
