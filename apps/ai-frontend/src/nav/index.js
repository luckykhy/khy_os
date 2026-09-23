// Single source of truth for the sidebar. Declared once, consumed three ways:
// sidebar rendering, the router's auth metadata, and the header title lookup.
// Add a page here and it shows up in both places; the wiring test fails if the
// router table and this list drift apart.
//
// Two shells, two path namespaces: the user group (bare paths) renders inside
// views/Layout.vue, the admin group (/admin/*) inside views/AdminLayout.vue.
// visibleNavGroups({ scope }) keeps each shell from rendering the other half;
// the router stamps requiresAdmin over the whole /admin subtree.
import {
  Aim,
  ChatDotRound,
  ChatDotSquare,
  Collection,
  Connection,
  Cpu,
  DataAnalysis,
  DataLine,
  Document,
  Folder,
  Grid,
  Guide,
  HomeFilled,
  Key,
  Link,
  Lock,
  Monitor,
  Money,
  PriceTag,
  Share,
  Setting,
  Shop,
  Tickets,
  User,
  Wallet,
} from '@element-plus/icons-vue';
import { ROLE } from '@/auth/roles';
import { hasRole } from '@/auth/permissions';

// requiredRole is a floor on the whole group: every item in it needs at least
// that tier. Entries used to carry a `daemon` namespace flag that auto-hid them
// when that namespace returned 404 — that made 工作流/插件市场 vanish from the
// sidebar whenever the ai-backend daemon was down, which read as "the feature
// was deleted". The flag is gone: every declared page is always visible, and a
// page whose backend is unavailable reports that itself (its own error state)
// instead of the sidebar silently hiding the entry.
export const NAV = [
  {
    label: '用户中心',
    requiredRole: ROLE.USER,
    items: [
      { path: '/home', label: '用户首页', icon: HomeFilled, desc: '工作台总览与快速开始' },
      { path: '/chat', label: 'AI 对话', icon: ChatDotSquare, desc: '与小K对话：写代码、读图、查资料' },
      { path: '/features', label: '功能索引', icon: Guide, desc: '按类别浏览 khy 的全部能力' },
      { path: '/prompts', label: '提示词库', icon: Collection, desc: '保存与复用常用提示词' },
      { path: '/khyos', label: 'KHY OS 内核', icon: Cpu, desc: '内核终端与系统级操作' },
      { path: '/keys', label: '我的网关', icon: Connection, desc: '查看我的模型接入与密钥' },
      {
        path: '/workflows',
        label: '工作流',
        icon: Share,
        desc: '可视化编排多步自动化流程',
      },
      {
        path: '/projects',
        label: '项目工作区',
        icon: Folder,
        desc: '命名的多文件夹编码工作区（对齐 Hermes coding projects）',
      },
      {
        path: '/marketplace',
        label: '插件市场',
        icon: Shop,
        desc: '导入 OpenAPI 插件扩展能力',
      },
      { path: '/proxies', label: '代理管理', icon: Link, desc: '粘贴订阅链接，导入代理节点订阅组' },
      {
        path: '/security',
        label: '账户安全',
        icon: Lock,
        desc: '改密、密保问题、生物识别与登录会话审计',
      },
      {
        path: '/markdown',
        label: 'Markdown',
        icon: Document,
        desc: '所见即所得 Markdown 编辑（无需登录）',
      },
    ],
  },
  {
    label: '管理控制台',
    requiredRole: ROLE.ADMIN,
    items: [
      { path: '/admin/overview', label: '总览', icon: DataAnalysis, desc: '系统全局指标与健康状态' },
      {
        path: '/admin/gui-eval',
        label: 'GUI 评测',
        icon: Aim,
        desc: 'GUI Agent 任务定义、执行与自动评分',
      },
      {
        path: '/admin/web-frontend-eval',
        label: '前端标注',
        icon: DataLine,
        desc: '2D/3D Web 前端轨迹数据标注与 QC',
      },
      { path: '/admin/models', label: '网关管理', icon: Connection, desc: '模型编排、密钥池与供应商' },
      {
        path: '/admin/channels',
        label: '渠道 API',
        icon: Key,
        desc: '各 AI 渠道端点、加密 Key 与 Agent 配置指南',
      },
      { path: '/admin/bridge', label: '桥接渠道', icon: Link, desc: '桥接 Token 与 OAuth 渠道' },
      {
        path: '/admin/settings/wx',
        label: '微信绑定',
        icon: ChatDotRound,
        desc: '微信个人号扫码绑定与账号→工作空间/Agent 路由',
      },
      { path: '/admin/accounts', label: '账号池', icon: User, desc: '统一调度的账号与负载均衡' },
      {
        path: '/admin/assets-customers',
        label: '资产与客户',
        icon: Wallet,
        desc: '客户、令牌与资产管理',
      },
      { path: '/admin/payments', label: '支付订单', icon: Money, desc: '额度充值下单、扫码支付与到账' },
      { path: '/admin/usage', label: '用量日志', icon: Tickets, desc: '调用明细与用量审计' },
      { path: '/admin/pricing', label: '计费定价', icon: PriceTag, desc: '模型计费与定价策略' },
      { path: '/admin/monitor', label: '监控中心', icon: Monitor, desc: '实时监控与归因追溯' },
      {
        path: '/admin/tasks',
        label: '任务看板',
        icon: Grid,
        desc: '大型任务按「执行体泳道 × 状态列」编排，支持暂停/恢复/取消',
      },
      { path: '/admin/settings', label: '统一设置', icon: Setting, desc: '平台级配置与开关' },
    ],
  },
];

// Sidebar filter. Role gates are re-checked by the router guard on navigation,
// so a hand-typed hidden path lands on /403 instead of a blank page. Daemon
// availability is deliberately NOT re-checked there: a deep link to a hidden
// daemon page still loads, and that page reports its own 404 rather than being
// bounced.
//
// `daemon` is a record of namespace -> availability. An item with `daemon` set
// is hidden only when its namespace is explicitly false; anything unknown stays
// visible, so a probe hiccup can never hide the whole sidebar.
export function visibleNavGroups(user, daemon = {}, { scope } = {}) {
  return NAV.filter((group) => {
    const floor = group.requiredRole ?? ROLE.USER;
    // scope splits the two shells: the user shell renders only groups below the
    // admin tier, the admin shell only the admin-tier groups. Unset = old
    // behaviour (both halves), kept for callers that genuinely want everything.
    if (scope === 'user' && floor >= ROLE.ADMIN) return false;
    if (scope === 'admin' && floor < ROLE.ADMIN) return false;
    return hasRole(user, floor);
  })
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.daemon || daemon[item.daemon] !== false),
    }))
    .filter((group) => group.items.length > 0);
}

export const NAV_PATHS = NAV.flatMap((group) => group.items.map((item) => item.path));

// Header title lookup. Detail routes are not declared here, so this returns null
// and the caller falls back to the brand text.
export function navLabelFor(path) {
  for (const group of NAV) {
    const hit = group.items.find((item) => item.path === path);
    if (hit) return hit.label;
  }
  return null;
}
