import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAdminRouteSegments, resolveRouterBase } from '../src/router/adminBase.js';

// 与 src/router/index.js 里真实的 admin 路由条目同形（嵌套在 '/' 的 children
// 下）。P2.5 之后 /admin/* 从两条扩到八条，排除段也随之从一段变成五段 ——
// 这正是本文件要证明的：排除集不是手工清单，而是路由表的派生物。
const ADMIN_ROUTES = [
  { path: '/login', component: {} },
  {
    path: '/',
    component: {},
    children: [
      { path: 'home', component: {} },
      { path: 'admin/overview', component: {} },
      { path: 'admin/models', component: {} },
      { path: 'bridge-channels', component: {} },
      { path: 'admin/settings/wx', component: {} },
      { path: 'admin/accounts', component: {} },
      { path: 'admin/settings', component: {} },
      { path: 'admin/channels', component: {} },
      { path: 'admin/channels/:id', component: {} },
    ],
  },
  // 旧路径重定向条目（component 缺失）同样会被纳入排除段，所以
  // /admin/channel-apis 这一旧部署基址在 P2.5 之后不再被识别为基址 ——
  // 需要自定义子路径部署的实例请用 VITE_AI_ROUTER_BASE 显式声明。
  { path: '/admin/channel-apis', redirect: '/admin/channels' },
  { path: '/admin/channel-apis/:id', redirect: '/admin/channels/1' },
];

test('collectAdminRouteSegments 从嵌套 children 派生 /admin/ 首段', () => {
  assert.deepEqual(
    collectAdminRouteSegments(ADMIN_ROUTES),
    new Set(['overview', 'models', 'settings', 'accounts', 'channels', 'channel-apis']),
  );
});

test('collectAdminRouteSegments 忽略非 admin 路由', () => {
  assert.deepEqual(collectAdminRouteSegments([{ path: '/login' }, { path: 'home' }]), new Set());
});

test('collectAdminRouteSegments 大小写归一化为小写', () => {
  assert.deepEqual(
    collectAdminRouteSegments([{ path: '/', children: [{ path: 'Admin/Things' }] }]),
    new Set(['things']),
  );
});

test('collectAdminRouteSegments 支持绝对路径的 admin 路由', () => {
  assert.deepEqual(collectAdminRouteSegments([{ path: '/admin/deep' }]), new Set(['deep']));
});

test('collectAdminRouteSegments 容忍空/非数组输入', () => {
  assert.deepEqual(collectAdminRouteSegments(null), new Set());
  assert.deepEqual(collectAdminRouteSegments([]), new Set());
});

test('已注册的站内 /admin/ 段不会被误判为部署基址（防 404）', () => {
  const segs = collectAdminRouteSegments(ADMIN_ROUTES);
  assert.equal(resolveRouterBase({ pathname: '/admin/channel-apis', adminSegments: segs }), '/');
  assert.equal(
    resolveRouterBase({ pathname: '/admin/channel-apis/7', adminSegments: segs }),
    '/',
  );
});

test('未注册的 /admin/<seg> 识别为部署基址', () => {
  assert.equal(
    resolveRouterBase({ pathname: '/admin/khy/dashboard', adminSegments: new Set() }),
    '/admin/khy',
  );
});

test('部署基址匹配大小写不敏感，但返回原样路径', () => {
  assert.equal(
    resolveRouterBase({ pathname: '/Admin/Khy/x', adminSegments: new Set() }),
    '/admin/Khy',
  );
});

test('VITE_AI_ROUTER_BASE 显式指定时优先级最高', () => {
  assert.equal(
    resolveRouterBase({ pathname: '/ai-console/settings', envBase: '/ai-console' }),
    '/ai-console',
  );
  assert.equal(
    resolveRouterBase({ pathname: '/ai-console', envBase: '/ai-console' }),
    '/ai-console',
  );
  // 无尾斜杠也接受，并归一化
  assert.equal(
    resolveRouterBase({ pathname: '/sub/app/page', envBase: 'sub/app/' }),
    '/sub/app',
  );
});

test('envBase 与当前路径不匹配时回落到 admin 启发式', () => {
  assert.equal(
    resolveRouterBase({ pathname: '/admin/khy/x', envBase: '/other' }),
    '/admin/khy',
  );
});

test('都不是时兜底 /', () => {
  assert.equal(resolveRouterBase({ pathname: '/' }), '/');
  assert.equal(resolveRouterBase({ pathname: '/settings' }), '/');
  assert.equal(resolveRouterBase({}), '/');
});
