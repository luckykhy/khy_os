<template>
  <el-container class="layout-shell">
    <el-aside :width="collapsed ? '64px' : '224px'" class="layout-aside">
      <div class="aside-brand" :class="{ 'is-collapsed': collapsed }">
        <span class="khy-brand-logo khy-brand-logo--sm aside-logo">K</span>
        <span v-show="!collapsed" class="aside-brand-text">{{ brandText }}</span>
      </div>

      <el-scrollbar class="aside-scroll">
        <el-menu
          :default-active="route.path"
          :collapse="collapsed"
          :collapse-transition="false"
          unique-opened
          router
          class="aside-menu"
        >
          <el-menu-item-group>
            <template #title v-if="!collapsed">
              <span class="aside-group-title">{{ menuGroupTitle }}</span>
            </template>
            <el-tooltip
              v-for="item in visibleMenuItems"
              :key="item.path"
              :content="item.desc || item.label"
              placement="right"
              :disabled="collapsed || !item.desc"
              :show-after="360"
              :offset="8"
            >
              <el-menu-item
                :index="item.path"
                @mouseenter="prefetchView(item.path)"
                @focus="prefetchView(item.path)"
              >
                <el-icon><component :is="item.icon" /></el-icon>
                <template #title>{{ item.label }}</template>
              </el-menu-item>
            </el-tooltip>
          </el-menu-item-group>
        </el-menu>
      </el-scrollbar>

      <div class="aside-footer" :class="{ 'is-collapsed': collapsed }">
        <div class="aside-user">
          <el-avatar :size="30" class="aside-avatar">{{ userInitial }}</el-avatar>
          <div v-show="!collapsed" class="aside-user-meta">
            <span class="aside-user-name">{{ userStore.user?.username || 'user' }}</span>
            <span class="aside-user-role">{{ userStore.isAdmin ? 'admin' : 'user' }}</span>
          </div>
        </div>
      </div>
    </el-aside>

    <el-container class="layout-body">
      <el-header class="layout-header">
        <div class="header-left">
          <el-button
            text
            class="header-collapse"
            :title="collapsed ? '展开侧边栏' : '收起侧边栏'"
            @click="toggleCollapse"
          >
            <el-icon :size="18">
              <component :is="collapsed ? Expand : Fold" />
            </el-icon>
          </el-button>
          <h1 class="header-title">{{ currentPageTitle }}</h1>
        </div>

        <div class="layout-actions">
          <el-button
            text
            class="header-icon-btn"
            :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'"
            @click="toggleTheme"
          >
            <el-icon :size="18">
              <component :is="theme === 'dark' ? Sunny : Moon" />
            </el-icon>
          </el-button>

          <el-switch
            v-if="userStore.isAdmin"
            :model-value="userStore.workspace === 'admin'"
            inline-prompt
            active-text="管理"
            inactive-text="用户"
            @change="handleWorkspaceChange"
          />

          <el-dropdown trigger="click" @command="handleUserCommand">
            <span class="header-user-trigger">
              <el-avatar :size="28" class="aside-avatar">{{ userInitial }}</el-avatar>
              <span class="header-user-name">{{ userStore.user?.username || 'user' }}</span>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>
                  {{ userStore.isAdmin ? '管理员' : '普通用户' }}
                </el-dropdown-item>
                <el-dropdown-item divided command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <el-main class="layout-main">
        <router-view v-slot="{ Component }">
          <keep-alive :include="CACHED_VIEWS">
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  HomeFilled, ChatDotSquare, DataAnalysis, Connection, Link,
  User, Wallet, Monitor, Fold, Expand, Sunny, Moon, ArrowDown,
  Tickets, PriceTag, Setting, Share, Cpu, Shop, Collection, Guide, Document, Folder,
} from '@element-plus/icons-vue'
import { useUserStore } from '@/stores/user'
import { useTheme } from '@/composables/useTheme'
import { prefetchView, prefetchViewsIdle } from '@/composables/useRoutePrefetch'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const { theme, toggleTheme } = useTheme()

// Heavy, static, leak-free views are kept alive so switching back to them is
// instant instead of re-paying a full mount render (the tab-switch freeze).
// keep-alive matches on each component's `name` (set via defineOptions in those
// files) — NOT the route name. Views holding live resources (chat WS / terminal /
// SSE monitors / polling dashboards / workflow runs) are deliberately EXCLUDED so
// their onUnmounted/onBeforeUnmount teardown still fires and nothing leaks.
const CACHED_VIEWS = [
  'AIGateway', 'AIAssetsCustomers', 'AccountPool', 'BridgeChannels',
  'Pricing', 'Settings', 'UserHome',
]

const SIDEBAR_STORAGE_KEY = 'khy_ai_sidebar_collapsed'

const USER_MENU = [
  { path: '/home', label: '用户首页', icon: HomeFilled, desc: '工作台总览与快速开始' },
  { path: '/chat', label: 'AI 对话', icon: ChatDotSquare, desc: '与小K对话：写代码、读图、查资料' },
  { path: '/features', label: '功能索引', icon: Guide, desc: '按类别浏览 khy 的全部能力' },
  { path: '/prompts', label: '提示词库', icon: Collection, desc: '保存与复用常用提示词' },
  { path: '/khyos', label: 'KHY OS 内核', icon: Cpu, desc: '内核终端与系统级操作' },
  { path: '/my-gateway', label: '我的网关', icon: Connection, desc: '查看我的模型接入与密钥' },
  { path: '/workflows', label: '工作流', icon: Share, desc: '可视化编排多步自动化流程' },
  { path: '/projects', label: '项目工作区', icon: Folder, desc: '命名的多文件夹编码工作区（对齐 Hermes coding projects）' },
  { path: '/marketplace', label: '插件市场', icon: Shop, desc: '导入 OpenAPI 插件扩展能力' },
  { path: '/proxies', label: '代理管理', icon: Link, desc: '粘贴订阅链接，导入代理节点订阅组' },
  { path: '/markdown', label: 'Markdown', icon: Document, desc: '所见即所得 Markdown 编辑（无需登录）' },
]

const ADMIN_MENU = [
  { path: '/dashboard', label: '总览', icon: DataAnalysis, desc: '系统全局指标与健康状态' },
  { path: '/gateway', label: '网关管理', icon: Connection, desc: '模型编排、密钥池与供应商' },
  { path: '/bridge-channels', label: '桥接渠道', icon: Link, desc: '桥接 Token 与 OAuth 渠道' },
  { path: '/accounts', label: '账号池', icon: User, desc: '统一调度的账号与负载均衡' },
  { path: '/assets-customers', label: '资产与客户', icon: Wallet, desc: '客户、令牌与资产管理' },
  { path: '/usage', label: '用量日志', icon: Tickets, desc: '调用明细与用量审计' },
  { path: '/pricing', label: '计费定价', icon: PriceTag, desc: '模型计费与定价策略' },
  { path: '/monitor', label: '监控中心', icon: Monitor, desc: '实时监控与归因追溯' },
  { path: '/settings', label: '统一设置', icon: Setting, desc: '平台级配置与开关' },
  { path: '/chat', label: 'AI 对话', icon: ChatDotSquare, desc: '与小K对话' },
]

function readCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const collapsed = ref(readCollapsed())

const isAdminWorkspace = computed(() => userStore.isAdmin && userStore.workspace === 'admin')
const brandText = computed(() => (isAdminWorkspace.value ? 'KHY 管理平台' : 'KHY 用户中心'))
const menuGroupTitle = computed(() => (isAdminWorkspace.value ? '管理控制台' : '用户中心'))
const visibleMenuItems = computed(() => (isAdminWorkspace.value ? ADMIN_MENU : USER_MENU))
const userInitial = computed(() => (userStore.user?.username || 'U').charAt(0).toUpperCase())

const currentPageTitle = computed(() => {
  const match = visibleMenuItems.value.find((item) => item.path === route.path)
  return match?.label || brandText.value
})

// Warm every sidebar destination during idle time after first paint, so a click
// switches instantly instead of waiting on a first-visit chunk download. Re-runs
// when the menu set changes (admin/user workspace toggle exposes new routes).
function warmVisibleRoutes() {
  prefetchViewsIdle(visibleMenuItems.value.map((item) => item.path))
}
onMounted(warmVisibleRoutes)
watch(visibleMenuItems, warmVisibleRoutes)

function toggleCollapse() {
  collapsed.value = !collapsed.value
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed.value ? '1' : '0')
  } catch {
    // ignore storage errors
  }
}

function handleWorkspaceChange(enabled) {
  const target = enabled ? 'admin' : 'user'
  userStore.setWorkspace(target)
  router.push(target === 'admin' ? '/dashboard' : '/home')
}

function handleUserCommand(command) {
  if (command === 'logout') handleLogout()
}

function handleLogout() {
  userStore.logout()
  router.push('/login')
}
</script>

<style scoped>
.layout-shell {
  min-height: 100vh;
}

/* ── Sidebar ── */
.layout-aside {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--khy-border);
  background: var(--khy-bg-elevated);
  transition: width 0.24s ease;
  overflow: hidden;
}

.aside-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 60px;
  padding: 0 18px;
  border-bottom: 1px solid var(--khy-border-light);
  flex-shrink: 0;
}

.aside-brand.is-collapsed {
  justify-content: center;
  padding: 0;
}

.aside-brand-text {
  color: var(--khy-text-strong);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.2px;
  white-space: nowrap;
}

.aside-scroll {
  flex: 1;
  min-height: 0;
}

.aside-menu {
  border-right: none;
  padding: 8px;
}

.aside-menu:not(.el-menu--collapse) .el-menu-item {
  height: 42px;
  border-radius: var(--khy-radius-sm);
  margin-bottom: 2px;
  transition: background-color 0.18s ease, color 0.18s ease, transform 0.18s ease;
}

/* Hover: gentle slide + brand tint, so the menu feels responsive. */
.aside-menu:not(.el-menu--collapse) .el-menu-item:not(.is-active):hover {
  background: var(--khy-bg-soft);
  transform: translateX(2px);
}

.aside-menu .el-menu-item.is-active {
  position: relative;
  background: var(--khy-primary-soft);
  color: var(--khy-primary-strong);
  font-weight: 600;
}

/* Active accent bar — a gradient pill on the leading edge marks the current
   route at a glance (works expanded; centered icon stays clean collapsed). */
.aside-menu .el-menu-item.is-active::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 3px;
  background: linear-gradient(180deg, var(--khy-primary), var(--khy-primary-strong));
}

.aside-menu .el-menu-item.is-active .el-icon {
  color: var(--khy-primary-strong);
}

.aside-group-title {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--khy-text-muted);
}

.aside-footer {
  border-top: 1px solid var(--khy-border-light);
  padding: 12px;
  flex-shrink: 0;
}

.aside-footer.is-collapsed {
  display: flex;
  justify-content: center;
}

.aside-user {
  display: flex;
  align-items: center;
  gap: 10px;
}

.aside-avatar {
  background: linear-gradient(135deg, var(--khy-primary), var(--khy-primary-strong));
  color: #fff;
  font-weight: 700;
  flex-shrink: 0;
}

.aside-user-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}

.aside-user-name {
  color: var(--khy-text-strong);
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aside-user-role {
  color: var(--khy-text-muted);
  font-size: 11px;
}

/* ── Body / header ── */
.layout-body {
  min-width: 0;
}

.layout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 60px;
  padding: 0 18px;
  border-bottom: 1px solid var(--khy-border);
  background: var(--khy-bg-elevated);
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.04);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.header-collapse,
.header-icon-btn {
  color: var(--khy-text-secondary);
  padding: 8px;
}

.header-collapse:hover,
.header-icon-btn:hover {
  color: var(--khy-primary-strong);
  background: var(--khy-bg-soft);
}

.header-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--khy-text-strong);
  white-space: nowrap;
}

.layout-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.header-user-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 999px;
  color: var(--khy-text-main);
  outline: none;
}

.header-user-trigger:hover {
  background: var(--khy-bg-soft);
}

.header-user-name {
  font-weight: 600;
  font-size: 13px;
}

.layout-main {
  padding: 20px;
}

@media (max-width: 768px) {
  .header-user-name {
    display: none;
  }

  .header-title {
    font-size: 15px;
  }

  .layout-main {
    padding: 12px;
  }
}
</style>
