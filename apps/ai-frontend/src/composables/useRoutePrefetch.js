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
// Admin pages live in src/views/admin/ and mount under the /admin parent route
// (views/AdminLayout.vue); user pages stay flat under views/ (views/Layout.vue).
export const viewLoaders = {
  // Shells
  '/': () => import('@/views/Layout.vue'),
  '/admin': () => import('@/views/AdminLayout.vue'),
  // Public / status pages
  '/login': () => import('@/views/Login.vue'),
  '/forgot-password': () => import('@/views/ForgotPassword.vue'),
  '/not-found': () => import('@/views/NotFound.vue'),
  '/401': () => import('@/views/NotAuthenticated.vue'),
  '/403': () => import('@/views/Forbidden.vue'),
  '/500': () => import('@/views/ServerError.vue'),
  // 用户中心
  '/home': () => import('@/views/UserHome.vue'),
  '/chat': () => import('@/views/AIChat.vue'),
  '/prompts': () => import('@/views/PromptLibrary.vue'),
  '/features': () => import('@/views/FeatureCatalog.vue'),
  '/khyos': () => import('@/views/KhyOsTerminal.vue'),
  '/khyos/desktop': () => import('@/views/KhyOsDesktop.vue'),
  '/keys': () => import('@/views/MyGateway.vue'),
  '/workflows': () => import('@/views/Workflows.vue'),
  '/workflows/:id': () => import('@/views/WorkflowEditor.vue'),
  '/projects': () => import('@/views/Projects.vue'),
  '/marketplace': () => import('@/views/Marketplace.vue'),
  '/proxies': () => import('@/views/ProxyManagement.vue'),
  '/security': () => import('@/views/Security.vue'),
  '/markdown': () => import('@/views/Markdown.vue'),
  // 管理控制台
  '/admin/overview': () => import('@/views/admin/AIDashboard.vue'),
  '/admin/models': () => import('@/views/admin/AIGateway.vue'),
  '/admin/bridge': () => import('@/views/admin/BridgeChannels.vue'),
  '/admin/settings/wx': () => import('@/views/admin/WxBinding.vue'),
  '/admin/settings': () => import('@/views/admin/Settings.vue'),
  '/admin/accounts': () => import('@/views/admin/AccountPool.vue'),
  '/admin/assets-customers': () => import('@/views/admin/AIAssetsCustomers.vue'),
  '/admin/payments': () => import('@/views/admin/AIPayments.vue'),
  '/admin/usage': () => import('@/views/admin/UsageLogs.vue'),
  '/admin/pricing': () => import('@/views/admin/Pricing.vue'),
  '/admin/monitor': () => import('@/views/admin/AIMonitor.vue'),
  '/admin/tasks': () => import('@/views/admin/TaskBoard.vue'),
  '/admin/traffic': () => import('@/views/admin/TrafficMonitor/index.vue'),
  '/admin/agents': () => import('@/views/admin/AgentDashboard.vue'),
  '/admin/gui-eval': () => import('@/views/admin/GuiEvalDashboard.vue'),
  '/admin/gui-eval/tasks': () => import('@/views/admin/GuiEvalTasks.vue'),
  '/admin/gui-eval/tasks/:id': () => import('@/views/admin/GuiEvalTaskEditor.vue'),
  '/admin/gui-eval/runs': () => import('@/views/admin/GuiEvalRuns.vue'),
  '/admin/gui-eval/runs/:id': () => import('@/views/admin/GuiEvalRunDetail.vue'),
  '/admin/web-frontend-eval': () => import('@/views/admin/WebFrontendEvalDashboard.vue'),
  '/admin/web-frontend-eval/tasks': () => import('@/views/admin/WebFrontendEvalTasks.vue'),
  '/admin/web-frontend-eval/tasks/:id': () => import('@/views/admin/WebFrontendEvalTaskEditor.vue'),
  '/admin/web-frontend-eval/runs': () => import('@/views/admin/WebFrontendEvalRuns.vue'),
  '/admin/web-frontend-eval/runs/:id': () => import('@/views/admin/WebFrontendEvalRunDetail.vue'),
  '/admin/channels': () => import('@/views/admin/ChannelApis.vue'),
  '/admin/channels/:id': () => import('@/views/admin/ChannelApiEditor.vue'),
};

// Chunks already requested — guards against re-importing on every hover.
const warmed = new Set();

// Warm one view's chunk now. Safe to call repeatedly; no-op once warmed.
export function prefetchView(path) {
  if (!path || warmed.has(path)) return;
  const loader = viewLoaders[path];
  if (typeof loader !== 'function') return;
  warmed.add(path);
  // Fire-and-forget. On failure (offline, chunk error) drop it from the set so a
  // later real navigation can retry; the router owns user-visible error handling.
  Promise.resolve()
    .then(loader)
    .catch(() => {
      warmed.delete(path);
    });
}

// Warm a batch of views during idle time, after first paint. Used to pre-warm
// every sidebar destination so switching never stalls on a first-visit download.
export function prefetchViewsIdle(paths) {
  if (typeof window === 'undefined' || !Array.isArray(paths)) return;
  // Warm the heaviest / most visited views first ('/chat', '/admin/models'),
  // then the rest in their original order — idle time may be short, so
  // priority targets must be requested before the budget runs out.
  const priority = ['/chat', '/admin/models'];
  const ordered = [
    ...priority.filter((p) => paths.includes(p)),
    ...paths.filter((p) => !priority.includes(p)),
  ];
  const run = () => {
    for (const p of ordered) prefetchView(p);
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 2000 });
  } else {
    // Fallback: defer past first paint without blocking it.
    setTimeout(run, 200);
  }
}
