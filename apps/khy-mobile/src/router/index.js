import { createRouter, createWebHistory } from 'vue-router';
import ConnectionView from '@/views/ConnectionView.vue';
import LoginView from '@/views/LoginView.vue';
import MobileShell from '@/layouts/MobileShell.vue';
import { loadRuntime } from '@/api/runtime';
import { getSession } from '@/api/secureSession';

const routes = [
  { path: '/', redirect: '/home' },
  { path: '/connect', component: ConnectionView, meta: { public: true, title: '连接后端' } },
  { path: '/login', component: LoginView, meta: { public: true, requiresRuntime: true, title: '登录' } },
  {
    path: '/', component: MobileShell, children: [
      { path: 'home', component: () => import('@/views/HomeView.vue'), meta: { title: '移动工作台' } },
      { path: 'chat', component: () => import('@/views/ChatView.vue'), meta: { title: 'AI 对话' } },
      { path: 'tasks', component: () => import('@/views/TasksView.vue'), meta: { title: '任务' } },
      { path: 'approvals', component: () => import('@/views/ApprovalsView.vue'), meta: { title: '待审批' } },
      { path: 'market', component: () => import('@/views/MarketView.vue'), meta: { title: '行情' } },
      // 交易域：入口页 + 五个子页面。子页面不占底部导航位，从 /trading 二级进入。
      { path: 'trading', component: () => import('@/views/TradingHubView.vue'), meta: { title: '交易' } },
      { path: 'portfolio', component: () => import('@/views/PortfolioView.vue'), meta: { title: '持仓' } },
      { path: 'order', component: () => import('@/views/OrderView.vue'), meta: { title: '下单' } },
      { path: 'trades', component: () => import('@/views/TradesView.vue'), meta: { title: '流水' } },
      { path: 'strategies', component: () => import('@/views/StrategiesView.vue'), meta: { title: '策略' } },
      { path: 'backtests', component: () => import('@/views/BacktestsView.vue'), meta: { title: '回测' } },
      { path: 'settings', component: () => import('@/views/SettingsView.vue'), meta: { title: '设置' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/home' },
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  const runtime = await loadRuntime();
  if (!runtime?.apiBaseUrl && to.path !== '/connect') return { path: '/connect', query: { next: to.fullPath } };
  if (to.path === '/connect' || to.path === '/login') return true;
  const session = await getSession();
  if (!session?.accessToken) return { path: '/login', query: { next: to.fullPath } };
  return true;
});

export default router;
