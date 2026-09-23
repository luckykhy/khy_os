import { createRouter, createWebHistory, isNavigationFailure } from 'vue-router';
import { resolveAuthGuard } from '@khy/ui-shared/auth/guard';
import { useUserStore } from '@/stores/user';
import { routeStart, routeDone } from '@/composables/useGlobalLoading';
import { viewLoaders } from '@/composables/useRoutePrefetch';
import { collectAdminRouteSegments, resolveRouterBase } from '@/router/adminBase';
import { safeRedirectPath } from '@/utils/safeRedirect';
import { NAV, navLabelFor } from '@/nav';
import { ROLE } from '@/auth/roles';

function detectRouterBase() {
  if (typeof window === 'undefined') return '/';
  return resolveRouterBase({
    pathname: window.location.pathname,
    envBase: import.meta.env.VITE_AI_ROUTER_BASE,
    adminSegments: collectAdminRouteSegments(routes),
  });
}

// Lazy view importers come from a shared registry (useRoutePrefetch) so the
// prefetcher warms the exact same chunks the router resolves on navigation.
const routes = [
  {
    path: '/login',
    name: 'Login',
    component: viewLoaders['/login'],
    meta: { requiresAuth: false },
  },
  {
    // Security-question password reset, both phases in one page. The flow is
    // client-driven against /api/password-reset/{get-question,reset} and the
    // backend issues no token, so splitting it into two routes would mean
    // carrying the security question in the URL — a leak into browser history,
    // proxy logs and Referer headers. Kept as one page instead.
    // requiresAuth stays false on purpose.
    path: '/forgot-password',
    name: 'ForgotPassword',
    component: viewLoaders['/forgot-password'],
    meta: { requiresAuth: false },
  },
  {
    // DESIGN-ARCH-080 §5.2 names this as a separate route; it forwards here so
    // the documented path resolves instead of 404ing. Same reason as above.
    path: '/reset-password',
    redirect: '/forgot-password',
  },
  {
    // Legacy redirects. Two generations of them:
    //   - pre P2.5 bare admin paths (/dashboard, /gateway, ...);
    //   - pre shell-split bare admin paths (/payments, /gui-eval, ...), moved
    //     under the /admin parent when the user/admin shells were separated
    //     (2026-09). Bookmarks, docs and copy-pasted URLs keep working; each
    //     target re-checks the role at the destination, so a redirect cannot be
    //     used to reach an admin page without the 403 gate.
    path: '/dashboard',
    redirect: '/admin/overview',
  },
  {
    path: '/gateway',
    redirect: '/admin/models',
  },
  {
    path: '/accounts',
    redirect: '/admin/accounts',
  },
  {
    path: '/settings',
    redirect: '/admin/settings',
  },
  {
    path: '/wx-binding',
    redirect: '/admin/settings/wx',
  },
  {
    path: '/my-gateway',
    redirect: '/keys',
  },
  {
    path: '/assets-customers',
    redirect: '/admin/assets-customers',
  },
  {
    path: '/payments',
    redirect: '/admin/payments',
  },
  {
    path: '/usage',
    redirect: '/admin/usage',
  },
  {
    path: '/pricing',
    redirect: '/admin/pricing',
  },
  {
    path: '/monitor',
    redirect: '/admin/monitor',
  },
  {
    path: '/traffic',
    redirect: '/admin/traffic',
  },
  {
    path: '/agents',
    redirect: '/admin/agents',
  },
  {
    path: '/gui-eval',
    redirect: '/admin/gui-eval',
  },
  {
    path: '/gui-eval/tasks',
    redirect: '/admin/gui-eval/tasks',
  },
  {
    path: '/gui-eval/tasks/:id',
    redirect: (to) => `/admin/gui-eval/tasks/${to.params.id}`,
  },
  {
    path: '/gui-eval/runs',
    redirect: '/admin/gui-eval/runs',
  },
  {
    path: '/gui-eval/runs/:id',
    redirect: (to) => `/admin/gui-eval/runs/${to.params.id}`,
  },
  {
    // The 复核 button in GuiEvalRuns pushes /gui-eval/review/:id (now
    // /admin/gui-eval/review/:id). The review UI lives inside GuiEvalRunDetail
    // (人工复核 dialog), so the path redirects there and ?review=1 auto-opens
    // the dialog — without this entry the button lands on the catch-all 404.
    path: '/gui-eval/review/:id',
    redirect: (to) => ({
      path: `/admin/gui-eval/runs/${to.params.id}`,
      query: { review: '1' },
    }),
  },
  {
    path: '/web-frontend-eval',
    redirect: '/admin/web-frontend-eval',
  },
  {
    path: '/web-frontend-eval/tasks',
    redirect: '/admin/web-frontend-eval/tasks',
  },
  {
    path: '/web-frontend-eval/tasks/:id',
    redirect: (to) => `/admin/web-frontend-eval/tasks/${to.params.id}`,
  },
  {
    path: '/web-frontend-eval/runs',
    redirect: '/admin/web-frontend-eval/runs',
  },
  {
    path: '/web-frontend-eval/runs/:id',
    redirect: (to) => `/admin/web-frontend-eval/runs/${to.params.id}`,
  },
  {
    // Declared before the /admin/channels route so exact '/admin/channel-apis'
    // is caught here rather than being read as a detail path with id = 'new'.
    path: '/admin/channel-apis',
    redirect: '/admin/channels',
  },
  {
    path: '/admin/channel-apis/:id',
    redirect: (to) => `/admin/channels/${to.params.id}`,
  },
  {
    path: '/bridge-channels',
    redirect: '/admin/bridge',
  },
  {
    // 用户中心外壳 — NAV 的「用户中心」组在这里渲染。
    path: '/',
    component: viewLoaders['/'],
    redirect: '/home',
    meta: { requiresAuth: true },
    children: [
      {
        path: 'home',
        name: 'UserHome',
        component: viewLoaders['/home'],
      },
      {
        path: 'chat',
        name: 'AIChat',
        component: viewLoaders['/chat'],
      },
      {
        // Per-user prompt library — auth only, NO requiresAdmin.
        path: 'prompts',
        name: 'PromptLibrary',
        component: viewLoaders['/prompts'],
      },
      {
        // Feature index / command catalog — auth only, NO requiresAdmin.
        // Read-only capability reference consuming GET /api/commands.
        path: 'features',
        name: 'FeatureCatalog',
        component: viewLoaders['/features'],
      },
      {
        // KHY OS bare-metal kernel terminal — auth only, NO requiresAdmin.
        path: 'khyos',
        name: 'KhyOsTerminal',
        component: viewLoaders['/khyos'],
      },
      {
        // KHY OS graphical desktop viewer (read-only framebuffer stream) —
        // auth only, NO requiresAdmin. Reached from the terminal's 进入桌面 button.
        path: 'khyos/desktop',
        name: 'KhyOsDesktop',
        component: viewLoaders['/khyos/desktop'],
      },
      {
        // Per-user (multi-tenant) gateway — auth only, NO requiresAdmin. Lives
        // at the bare /keys: it is the user's own keys, the /admin/models twin.
        path: 'keys',
        name: 'MyGateway',
        component: viewLoaders['/keys'],
      },
      {
        // Account security (DESIGN-ARCH-080 P3.2) — change password, security
        // question, WebAuthn binding, and the user's own session audit.
        // Auth only, NO requiresAdmin: it manages the logged-in user's own
        // account. Each sub-capability is gated client-side by the
        // /api/auth/capabilities bits, and the full cross-user audit log stays
        // on /api/admin/user-logs (requireAdmin only).
        path: 'security',
        name: 'Security',
        component: viewLoaders['/security'],
      },
      {
        // Per-user visual workflows — auth only, NO requiresAdmin.
        path: 'workflows',
        name: 'Workflows',
        component: viewLoaders['/workflows'],
      },
      {
        path: 'workflows/:id',
        name: 'WorkflowEditor',
        component: viewLoaders['/workflows/:id'],
      },
      {
        // Per-user coding projects (命名工作区) — auth only, NO requiresAdmin.
        path: 'projects',
        name: 'Projects',
        component: viewLoaders['/projects'],
      },
      {
        // Per-user plugin marketplace — auth only, NO requiresAdmin.
        path: 'marketplace',
        name: 'Marketplace',
        component: viewLoaders['/marketplace'],
      },
      {
        // 代理管理. The sidebar has had a /proxies entry all along while the
        // route was never registered, so the menu item resolved to NotFound.
        // Both halves have a backend — subscriptions on the Express app,
        // egress on the ai-management daemon — so the fix is the missing route,
        // not deleting the page.
        path: 'proxies',
        name: 'Proxies',
        component: viewLoaders['/proxies'],
      },
    ],
  },
  {
    // 管理控制台外壳 — NAV 的「管理控制台」组在这里渲染，与用户中心是两个独立
    // 外壳（views/AdminLayout.vue vs views/Layout.vue）。整个 /admin 子树由
    // isAdminPath() 盖 requiresAdmin，普通用户在路由守卫处被弹到 /403。
    path: '/admin',
    component: viewLoaders['/admin'],
    redirect: '/admin/overview',
    meta: { requiresAuth: true },
    children: [
      {
        path: 'overview',
        name: 'AIDashboard',
        component: viewLoaders['/admin/overview'],
      },
      {
        path: 'models',
        name: 'AIGateway',
        component: viewLoaders['/admin/models'],
      },
      {
        // Bridge Token pool for Claude/Codex/Kiro relays. Kept as its own page
        // rather than folded into /admin/channels: it talks to
        // /api/ai-gateway/* (proxied to ai-backend) while ChannelApis talks to
        // /api/channel-apis/* (local Express registry) — different backends and
        // different domains, so one merged file would be two unrelated services
        // in a single component.
        path: 'bridge',
        name: 'BridgeChannels',
        component: viewLoaders['/admin/bridge'],
      },
      {
        // Nested under /admin/settings but declared as its own sibling route:
        // Settings.vue renders six tabs and owns no <router-view>, so a child
        // route would render into a hole. detectRouterBase() only inspects the
        // first /admin/<seg> segment, so 'settings' here and in /admin/settings
        // dedupe to one excluded segment.
        path: 'settings/wx',
        name: 'WxBinding',
        component: viewLoaders['/admin/settings/wx'],
      },
      {
        path: 'settings',
        name: 'AISettings',
        component: viewLoaders['/admin/settings'],
      },
      {
        path: 'accounts',
        name: 'AccountPool',
        component: viewLoaders['/admin/accounts'],
      },
      {
        path: 'assets-customers',
        name: 'AIAssetsCustomers',
        component: viewLoaders['/admin/assets-customers'],
      },
      {
        path: 'payments',
        name: 'AIPayments',
        component: viewLoaders['/admin/payments'],
      },
      {
        path: 'usage',
        name: 'AIUsageLogs',
        component: viewLoaders['/admin/usage'],
      },
      {
        path: 'pricing',
        name: 'AIPricing',
        component: viewLoaders['/admin/pricing'],
      },
      {
        path: 'monitor',
        name: 'AIMonitor',
        component: viewLoaders['/admin/monitor'],
      },
      {
        // 大型任务看板：只读聚合 + 暂停/恢复/取消。放在 admin 组是因为
        // 数据源 largeTaskRuntimeStore 是全局的（含平台后台任务），不属于单个用户。
        path: 'tasks',
        name: 'AdminTaskBoard',
        component: viewLoaders['/admin/tasks'],
      },
      {
        path: 'traffic',
        name: 'TrafficMonitor',
        component: viewLoaders['/admin/traffic'],
      },
      {
        path: 'agents',
        name: 'AgentDashboard',
        component: viewLoaders['/admin/agents'],
      },
      {
        // GUI Agent 评测平台 + 它的任务/运行下钻页（admin only）。
        path: 'gui-eval',
        name: 'GuiEvalDashboard',
        component: viewLoaders['/admin/gui-eval'],
      },
      {
        path: 'gui-eval/tasks',
        name: 'GuiEvalTasks',
        component: viewLoaders['/admin/gui-eval/tasks'],
      },
      {
        path: 'gui-eval/tasks/:id',
        name: 'GuiEvalTaskEditor',
        component: viewLoaders['/admin/gui-eval/tasks/:id'],
      },
      {
        path: 'gui-eval/runs',
        name: 'GuiEvalRuns',
        component: viewLoaders['/admin/gui-eval/runs'],
      },
      {
        path: 'gui-eval/runs/:id',
        name: 'GuiEvalRunDetail',
        component: viewLoaders['/admin/gui-eval/runs/:id'],
      },
      {
        // The 复核 button in GuiEvalRuns pushes /admin/gui-eval/review/:id. The
        // review UI lives inside GuiEvalRunDetail (人工复核 dialog), so the path
        // redirects there and ?review=1 auto-opens the dialog — without this
        // entry the button lands on the catch-all NotFound page.
        path: 'gui-eval/review/:id',
        redirect: (to) => ({
          path: `/admin/gui-eval/runs/${to.params.id}`,
          query: { review: '1' },
        }),
      },
      {
        // 2D/3D Web 前端轨迹数据标注平台 + 任务/运行下钻页（admin only）。
        path: 'web-frontend-eval',
        name: 'WebFrontendEvalDashboard',
        component: viewLoaders['/admin/web-frontend-eval'],
      },
      {
        path: 'web-frontend-eval/tasks',
        name: 'WebFrontendEvalTasks',
        component: viewLoaders['/admin/web-frontend-eval/tasks'],
      },
      {
        path: 'web-frontend-eval/tasks/:id',
        name: 'WebFrontendEvalTaskEditor',
        component: viewLoaders['/admin/web-frontend-eval/tasks/:id'],
      },
      {
        path: 'web-frontend-eval/runs',
        name: 'WebFrontendEvalRuns',
        component: viewLoaders['/admin/web-frontend-eval/runs'],
      },
      {
        path: 'web-frontend-eval/runs/:id',
        name: 'WebFrontendEvalRunDetail',
        component: viewLoaders['/admin/web-frontend-eval/runs/:id'],
      },
      {
        // 渠道 API 文档：各 AI 渠道端点 + 加密 Key + Agent 配置指南（admin only）。
        // /admin/* 前缀与 detectRouterBase() 的 /admin/<seg> 部署基址启发式共存：
        // 该函数从本路由表派生需排除的段，新增 /admin/xxx 路由无需额外登记。
        // /admin/channels/:id 同时承接 /admin/channels/new（id === 'new'）。
        path: 'channels',
        name: 'ChannelApis',
        component: viewLoaders['/admin/channels'],
      },
      {
        path: 'channels/:id',
        name: 'ChannelApiEditor',
        component: viewLoaders['/admin/channels/:id'],
      },
    ],
  },
  {
    // Markdown 工作台 — 独立顶层挂载用户外壳，meta.requiresAuth:false 使其
    // 在未登录时也可经外壳访问（不分割的关键）。守卫用 to.matched.some(...) 判定，
    // 故该链上无 requiresAuth:true 记录 → 匿名访问不会 401 跳 login。已登录用户点
    // 同一菜单项同样命中此路由，两类用户 UI 统一。浏览器内编辑零后端；服务器文件
    // 目录（Phase B）在组件内经 authenticateToken 的 API 二次门控，匿名永不触发。
    path: '/markdown',
    component: viewLoaders['/'],
    meta: { requiresAuth: false },
    children: [{ path: '', name: 'Markdown', component: viewLoaders['/markdown'] }],
  },
  {
    // 401 — an authenticated session is required but absent. Carries the
    // originally-requested path in ?redirect so the /401 → /login handoff can
    // bring the user back to where they were going.
    path: '/401',
    name: 'NotAuthenticated',
    component: viewLoaders['/401'],
    meta: { requiresAuth: false },
  },
  {
    // 403 — non-admin reached an admin route. requiresAuth:false so the guard's
    // own redirect target is always renderable and never re-enters the admin check.
    path: '/403',
    name: 'Forbidden',
    component: viewLoaders['/403'],
    meta: { requiresAuth: false },
  },
  {
    // 500 — an unexpected navigation failure (router.onError) lands here instead
    // of leaving the progress bar spinning over a blank route.
    path: '/500',
    name: 'ServerError',
    component: viewLoaders['/500'],
    meta: { requiresAuth: false },
  },
  {
    // Catch-all 404 fallback — declared LAST so it only matches when nothing else
    // did. requiresAuth:false so a mistyped URL (even unauthenticated) lands on the
    // friendly NotFound page instead of a blank <router-view> or a login bounce.
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: viewLoaders['/not-found'],
    meta: { requiresAuth: false },
  },
];

// Admin access is declared in NAV, not repeated in this table. Since the shell
// split, every admin page also physically lives under the /admin parent route,
// so the namespace itself is the gate — anything under /admin/ is admin, and
// ADMIN_NAV_PATHS stays as a drift check in case a future NAV entry ever grows
// outside the namespace.
const ADMIN_NAV_PATHS = NAV.filter(
  (group) => (group.requiredRole ?? ROLE.USER) >= ROLE.ADMIN
).flatMap((group) => group.items.map((item) => item.path));

const ADMIN_NAMESPACE = '/admin';

function isAdminPath(absPath) {
  if (absPath === ADMIN_NAMESPACE || absPath.startsWith(`${ADMIN_NAMESPACE}/`)) {
    return true;
  }
  return ADMIN_NAV_PATHS.some(
    (p) => absPath === p || absPath.startsWith(`${p}/`)
  );
}

function joinPath(parent, child) {
  return `${(parent || '/').replace(/\/+$/, '')}/${child}`.replace(/\/+/g, '/');
}

function resolveAbs(routePath, prefix) {
  if (!routePath) return prefix;
  if (routePath.startsWith('/')) return routePath;
  return joinPath(prefix || '/', routePath);
}

// Stamp requiresAdmin onto the route records. Children resolve against their
// parent so nested drill-downs are caught too; the catch-all is skipped.
function stampAdminMeta(route, prefix) {
  const abs = resolveAbs(route.path, prefix);
  if (abs && !abs.startsWith('/:') && isAdminPath(abs)) {
    route.meta = { ...(route.meta || {}), requiresAdmin: true };
  }
  (route.children || []).forEach((child) => stampAdminMeta(child, abs));
}

routes.forEach((route) => stampAdminMeta(route, '/'));

const router = createRouter({
  history: createWebHistory(detectRouterBase()),
  routes,
});

router.beforeEach(async (to, from, next) => {
  // Show the global progress bar across the guard's async work (ensureSession)
  // and the lazy route chunk download, so navigation never looks frozen.
  routeStart();
  const userStore = useUserStore();
  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth);
  const authenticated = userStore.isAuthenticated();
  if (requiresAuth) {
    if (!authenticated) return next(unauthTarget(to));
    const ok = await userStore.ensureSession();
    if (!ok) return next(unauthTarget(to));
  }

  const requiresAdmin = to.matched.some((record) => record.meta.requiresAdmin);
  if (requiresAdmin && !userStore.isAdmin) return next('/403');

  const redirect = resolveAuthGuard({
    requiresAdmin,
    isAuthenticated: authenticated,
    isAdmin: userStore.isAdmin,
    // /401 is included because an already-authenticated visitor who types it has
    // nothing to do there. /403 and /500 are deliberately NOT included: both are
    // redirect targets of this guard, so treating them as guest routes would
    // bounce a non-admin from /403 straight to home and hide the error page.
    isGuestRoute: to.path === '/login' || to.path === '/401',
    authenticatedRedirect: userStore.preferredHome,
    adminRedirect: '/home',
    order: ['guest', 'admin'],
  });
  return redirect ? next(redirect) : next();
});

// Unauthenticated redirect with the destination preserved, so /401 → /login can
// bring the user back to the page they asked for instead of dropping them at home.
function unauthTarget(to) {
  const path = safeRedirectPath(to.fullPath, '/');
  return path === '/' ? '/401' : `/401?redirect=${encodeURIComponent(path)}`;
}

// Clear the bar once navigation settles (success or error). afterEach fires
// after the matched component's lazy chunk has resolved, so the bar spans the
// full download too. routeLoading is a boolean, so redirect chains can't leak it.
//
// Document titles are set here, once: NAV supplies the label for pages that are
// in the sidebar, and the few routes that are not NAV entries (login, password
// reset, status pages) fall back to this map. index.html owns <title> — a view
// rendering its own <head> would never reach the browser tab.
const DOCUMENT_TITLES = {
  '/login': '登录',
  '/forgot-password': '忘记密码',
  '/reset-password': '重置密码',
  '/401': '401 · 请先登录',
  '/403': '403 · 没有访问权限',
  '/500': '500 · 出了点问题',
};

const BRAND_TITLE = 'KHY AI 管理平台';

function documentTitleFor(to) {
  const navLabel = navLabelFor(to.path);
  if (navLabel) return `${navLabel} · ${BRAND_TITLE}`;
  const byPath = DOCUMENT_TITLES[to.path];
  if (byPath) return `${byPath} · ${BRAND_TITLE}`;
  return to.name === 'NotFound' ? `404 · 页面不存在 · ${BRAND_TITLE}` : BRAND_TITLE;
}

router.afterEach((to) => {
  routeDone();
  document.title = documentTitleFor(to);
});
router.onError((error, to) => {
  routeDone();
  // A failed navigation used to leave the progress bar spinning over a blank
  // route. Abort/cancel/duplicate are user-driven supersessions, not failures —
  // filtering them out keeps a fast double-click from landing on the 500 page.
  if (isNavigationFailure(error)) return;
  if (!to || to.fullPath === '/500') return;
  router.replace('/500');
});

export default router;
