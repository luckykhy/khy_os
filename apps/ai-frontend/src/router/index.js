import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/Login.vue'),
    meta: { public: true }
  },
  {
    path: '/',
    component: () => import('@/views/Layout.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: { title: '工作台' }
      },
      {
        path: 'ai-gateway',
        name: 'AIGateway',
        component: () => import('@/views/AIGateway.vue'),
        meta: { title: 'AI 网关' }
      },
      {
        path: 'ai-chat',
        name: 'AIChat',
        component: () => import('@/views/AIChat.vue'),
        meta: { title: 'AI 对话' }
      },
      {
        path: 'agent-dashboard',
        name: 'AgentDashboard',
        component: () => import('@/views/AgentDashboard.vue'),
        meta: { title: '智能体控制台' }
      },
      {
        path: 'ai-monitor',
        name: 'AIMonitor',
        component: () => import('@/views/AIMonitor.vue'),
        meta: { title: 'AI 监控' }
      },
      {
        path: 'account-pool',
        name: 'AccountPool',
        component: () => import('@/views/AccountPool.vue'),
        meta: { title: '账号池管理' }
      },
      {
        path: 'ai-assets',
        name: 'AIAssets',
        component: () => import('@/views/AIAssets.vue'),
        meta: { title: 'AI 资产管理' }
      },
      {
        path: 'ai-payments',
        name: 'AIPayments',
        component: () => import('@/views/AIPayments.vue'),
        meta: { title: '支付管理' }
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/Settings.vue'),
        meta: { title: '系统设置' }
      }
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/dashboard'
  }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

// Navigation guard for authentication
router.beforeEach((to, from, next) => {
  const authStore = useAuthStore();

  if (!to.meta.public && !authStore.isAuthenticated) {
    next({ name: 'Login', query: { redirect: to.fullPath } });
  } else if (to.name === 'Login' && authStore.isAuthenticated) {
    next({ name: 'Dashboard' });
  } else {
    next();
  }
});

export default router;
