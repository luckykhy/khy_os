import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { routeStart, routeDone } from '@/composables/useGlobalLoading'
import { viewLoaders } from '@/composables/useRoutePrefetch'

function detectRouterBase() {
  if (typeof window === 'undefined') return '/'
  const pathname = String(window.location.pathname || '/')
  const envBase = String(import.meta.env.VITE_AI_ROUTER_BASE || '').trim().replace(/\/+$/, '')
  if (envBase && (pathname === envBase || pathname.startsWith(`${envBase}/`))) {
    return envBase.startsWith('/') ? envBase : `/${envBase}`
  }
  const adminPrefix = pathname.match(/^\/admin\/[^/]+/i)
  if (adminPrefix && adminPrefix[0]) {
    return adminPrefix[0]
  }
  return '/'
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
        path: 'dashboard',
        name: 'AIDashboard',
        component: viewLoaders['/dashboard'],
        meta: { requiresAdmin: true },
      },
      {
        path: 'gateway',
        name: 'AIGateway',
        component: viewLoaders['/gateway'],
        meta: { requiresAdmin: true },
      },
      {
        path: 'bridge-channels',
        name: 'BridgeChannels',
        component: viewLoaders['/bridge-channels'],
        meta: { requiresAdmin: true },
      },
      {
        path: 'accounts',
        name: 'AccountPool',
        component: viewLoaders['/accounts'],
        meta: { requiresAdmin: true },
      },
      {
        path: 'assets-customers',
        name: 'AIAssetsCustomers',
        component: viewLoaders['/assets-customers'],
        meta: { requiresAdmin: true },
      },
      {
        path: 'usage',
        name: 'AIUsageLogs',
        component: viewLoaders['/usage'],
        meta: { requiresAdmin: true },
      },
      {
        path: 'pricing',
        name: 'AIPricing',
        component: viewLoaders['/pricing'],
        meta: { requiresAdmin: true },
      },
      {
        path: 'monitor',
        name: 'AIMonitor',
        component: viewLoaders['/monitor'],
        meta: { requiresAdmin: true },
      },
      {
        path: 'settings',
        name: 'AISettings',
        component: viewLoaders['/settings'],
        meta: { requiresAdmin: true },
      },
      {
        path: 'agents',
        name: 'AgentDashboard',
        component: viewLoaders['/agents'],
        meta: { requiresAdmin: true },
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
        // Per-user (multi-tenant) gateway — auth only, NO requiresAdmin.
        path: 'my-gateway',
        name: 'MyGateway',
        component: viewLoaders['/my-gateway'],
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
        // Proxy management (代理管理) — paste a subscription URL, import node groups.
        // Auth only, NO requiresAdmin.
        path: 'proxies',
        name: 'ProxyManagement',
        component: viewLoaders['/proxies'],
      },
    ],
  },
  {
    // Markdown 工作台 — 独立顶层挂载 Layout 外壳，meta.requiresAuth:false 使其
    // 在未登录时也可经外壳访问（不分割的关键）。守卫用 to.matched.some(...) 判定，
    // 故该链上无 requiresAuth:true 记录 → 匿名访问不会 401 跳 login。已登录用户点
    // 同一菜单项同样命中此路由，两类用户 UI 统一。浏览器内编辑零后端；服务器文件
    // 目录（Phase B）在组件内经 authenticateToken 的 API 二次门控，匿名永不触发。
    path: '/markdown',
    component: viewLoaders['/'],
    meta: { requiresAuth: false },
    children: [
      { path: '', name: 'Markdown', component: viewLoaders['/markdown'] },
    ],
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
]

const router = createRouter({
  history: createWebHistory(detectRouterBase()),
  routes,
})

router.beforeEach(async (to, from, next) => {
  // Show the global progress bar across the guard's async work (ensureSession)
  // and the lazy route chunk download, so navigation never looks frozen.
  routeStart()
  const userStore = useUserStore()
  const requiresAuth = to.matched.some(record => record.meta.requiresAuth)
  if (requiresAuth) {
    if (!userStore.isAuthenticated()) return next('/login')
    const ok = await userStore.ensureSession()
    if (!ok) return next('/login')
  }

  if (to.path === '/login' && userStore.isAuthenticated()) {
    return next(userStore.preferredHome)
  }

  const requiresAdmin = to.matched.some(record => record.meta.requiresAdmin)
  if (requiresAdmin && !userStore.isAdmin) {
    return next('/home')
  }

  return next()
})

// Clear the bar once navigation settles (success or error). afterEach fires
// after the matched component's lazy chunk has resolved, so the bar spans the
// full download too. routeLoading is a boolean, so redirect chains can't leak it.
router.afterEach(() => { routeDone() })
router.onError(() => { routeDone() })

export default router
