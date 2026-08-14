import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/admin-login',
    name: 'AdminLogin',
    component: () => import('@/views/AdminLogin.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/register',
    name: 'Register',
    component: () => import('@/views/Register.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/forgot-password',
    name: 'ForgotPassword',
    component: () => import('@/views/ForgotPassword.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/',
    component: () => import('@/views/Layout.vue'),
    name: 'Layout',
    redirect: '/dashboard',
    meta: { requiresAuth: true },
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/Dashboard.vue')
      },
      // Quant routes — static fallbacks if khy-quant plugin is not loaded.
      // The plugin may override these with richer components via pluginManager.
      {
        path: 'trading',
        name: 'Trading',
        component: () => import('@/views/Trading.vue')
      },
      {
        path: 'market-quotes',
        name: 'MarketQuotes',
        component: () => import('@/views/Trading.vue'),
        meta: { tab: 'quotes' }
      },
      {
        path: 'strategies',
        name: 'Strategies',
        component: () => import('@/views/Trading.vue'),
        meta: { tab: 'strategies' }
      },
      {
        path: 'backtest',
        name: 'Backtest',
        component: () => import('@/views/Trading.vue'),
        meta: { tab: 'backtest' }
      },
      {
        path: 'announcements',
        name: 'Announcements',
        component: () => import('@/views/Announcements.vue')
      },
      {
        path: 'feedback',
        name: 'Feedback',
        component: () => import('@/views/Feedback.vue')
      },
      {
        path: 'profile',
        name: 'Profile',
        component: () => import('@/views/Profile.vue')
      },
      {
        path: 'api-keys',
        name: 'ApiKeyManage',
        component: () => import('@/views/ApiKeyManage.vue')
      },
      {
        path: 'dependencies',
        name: 'DependencyManagement',
        component: () => import('@/views/DependencyManagement.vue')
      },
      {
        path: 'system-management',
        name: 'SystemManagement',
        component: () => import('@/views/SystemManagement.vue')
      },
      {
        path: 'debug',
        name: 'Debug',
        component: () => import('@/views/Debug.vue')
      }
    ]
  },
  {
    path: '/admin',
    component: () => import('@/views/AdminLayout.vue'),
    redirect: '/admin/dashboard',
    meta: { requiresAuth: true, requiresAdmin: true },
    children: [
      {
        path: 'dashboard',
        name: 'AdminDashboard',
        component: () => import('@/views/admin/Dashboard.vue'),
        meta: { adminTab: 'overview' }
      },
      {
        path: 'users',
        name: 'AdminUsers',
        component: () => import('@/views/admin/Dashboard.vue'),
        meta: { adminTab: 'users' }
      },
      {
        path: 'announcements',
        name: 'AdminAnnouncements',
        component: () => import('@/views/admin/Dashboard.vue'),
        meta: { adminTab: 'announcements' }
      },
      {
        path: 'feedback',
        name: 'AdminFeedback',
        component: () => import('@/views/admin/Dashboard.vue'),
        meta: { adminTab: 'feedback' }
      },
      {
        path: 'system',
        name: 'AdminSystem',
        component: () => import('@/views/admin/Dashboard.vue'),
        meta: { adminTab: 'system' }
      },
      {
        path: 'logs',
        name: 'AdminLogs',
        component: () => import('@/views/admin/Dashboard.vue'),
        meta: { adminTab: 'logs' }
      },
      {
        path: 'funds',
        name: 'AdminFunds',
        component: () => import('@/views/admin/Dashboard.vue'),
        meta: { adminTab: 'funds' }
      },
      {
        path: 'trades',
        name: 'AdminTrades',
        component: () => import('@/views/admin/Dashboard.vue'),
        meta: { adminTab: 'trades' }
      },
      {
        path: 'ai-gateway',
        name: 'AdminAIGateway',
        component: () => import('@/views/admin/Dashboard.vue'),
        meta: { adminTab: 'ai-gateway' }
      },
      { path: 'ai', redirect: '/admin/ai-gateway' },
      { path: 'ai-management', redirect: '/admin/ai-gateway' }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
}) 
router.beforeEach(async (to, from, next) => {
  const userStore = useUserStore()
  
  if (userStore.token && !userStore.user) {
    try {
      await userStore.fetchUserInfo()
    } catch (error) {
      console.error('获取用户信息失败:', error)
      await userStore.logout({ skipRemote: true })
      if (to.meta.requiresAuth) {
        next('/login')
        return
      }
    }
  }
  
  if (to.meta.requiresAuth && !userStore.isAuthenticated()) {
    next('/login')
  } else if (to.meta.requiresAdmin && userStore.user?.role !== 'admin') {
    next('/dashboard')
  } else if ((to.path === '/login' || to.path === '/register' || to.path === '/admin-login') && userStore.isAuthenticated()) {
    if (userStore.user?.role === 'admin') {
      next('/admin/dashboard')
    } else {
      next('/dashboard')
    }
  } else {
    next()
  }
})

export default router
