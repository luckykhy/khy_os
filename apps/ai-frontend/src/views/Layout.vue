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
          <template v-for="group in navGroups" :key="group.label">
            <el-menu-item-group>
              <template #title v-if="!collapsed">
                <span class="aside-group-title">{{ group.label }}</span>
              </template>
              <el-tooltip
                v-for="item in group.items"
                :key="group.label + item.path"
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
          </template>
        </el-menu>
      </el-scrollbar>

      <div class="aside-footer" :class="{ 'is-collapsed': collapsed }">
        <div class="aside-user">
          <el-avatar :size="30" class="aside-avatar">{{ userInitial }}</el-avatar>
          <div v-show="!collapsed" class="aside-user-meta">
            <span class="aside-user-name">{{ userStore.user?.username || 'user' }}</span>
            <span class="aside-user-role">{{ userStore.roleLabel }}</span>
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

          <el-dropdown trigger="click" @command="handleUserCommand">
            <span class="header-user-trigger">
              <el-avatar :size="28" class="aside-avatar">{{ userInitial }}</el-avatar>
              <span class="header-user-name">{{ userStore.user?.username || 'user' }}</span>
              <el-icon><ArrowDown /></el-icon>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item disabled>{{ userStore.roleLabel }}</el-dropdown-item>
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
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Fold, Expand, Sunny, Moon, ArrowDown } from '@element-plus/icons-vue';
import { useUserStore } from '@/stores/user';
import { visibleNavGroups, navLabelFor } from '@/nav';
import { safeSet } from '@/utils/safeStorage';
import { probeDaemonNamespaces } from '@/api/daemonProbe';
import { useTheme } from '@/composables/useTheme';
import { prefetchView, prefetchViewsIdle } from '@/composables/useRoutePrefetch';

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();
const { theme, toggleTheme } = useTheme();

// Heavy, static, leak-free views are kept alive so switching back to them is
// instant instead of re-paying a full mount render (the tab-switch freeze).
// keep-alive matches on each component's `name` (set via defineOptions in those
// files) — NOT the route name. Views holding live resources (chat WS / terminal /
// SSE monitors / polling dashboards / workflow runs) are deliberately EXCLUDED so
// their onUnmounted/onBeforeUnmount teardown still fires and nothing leaks.
const CACHED_VIEWS = [
  'AIGateway',
  'AIAssetsCustomers',
  'AccountPool',
  'BridgeChannels',
  'Pricing',
  'Settings',
  'UserHome',
];

const SIDEBAR_STORAGE_KEY = 'khy_ai_sidebar_collapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

const collapsed = ref(readCollapsed());

// Sidebar shape comes from NAV and depends only on the role — there is no
// user/admin view switch, so an admin simply gets the console group appended.
const brandText = computed(() => 'KHY 管理平台');

// Daemon-only namespaces (DESIGN-ARCH-080 §6.2, 方案 Y). Empty until the probe
// settles, which keeps the sidebar fail-open: nothing is hidden on the first
// paint, and only a definite 404 removes an entry.
const daemonCaps = reactive({});

const navGroups = computed(() => visibleNavGroups(userStore.user, daemonCaps));
const visibleMenuItems = computed(() =>
  navGroups.value.flatMap((group) => group.items)
);

const userInitial = computed(() => (userStore.user?.username || 'U').charAt(0).toUpperCase());

const currentPageTitle = computed(() => navLabelFor(route.path) || brandText.value);

// Warm every sidebar destination during idle time after first paint, so a click
// switches instantly instead of waiting on a first-visit chunk download. Re-runs
// when the visible set changes (an admin gains the console group).
function warmVisibleRoutes() {
  prefetchViewsIdle(visibleMenuItems.value.map((item) => item.path));
}
onMounted(async () => {
  warmVisibleRoutes();
  // Resolving this changes visibleMenuItems, which re-triggers the warm-up
  // through the watcher below — the probe itself never touches the sidebar.
  Object.assign(daemonCaps, await probeDaemonNamespaces());
});
watch(visibleMenuItems, warmVisibleRoutes);

function toggleCollapse() {
  collapsed.value = !collapsed.value;
  safeSet(SIDEBAR_STORAGE_KEY, collapsed.value ? '1' : '0');
}

function handleUserCommand(command) {
  if (command === 'logout') handleLogout();
}

function handleLogout() {
  userStore.logout();
  router.push('/login');
}
</script>

<style scoped>
.layout-shell {
  height: 100vh;
  overflow: hidden;
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
  transition:
    background-color 0.18s ease,
    color 0.18s ease,
    transform 0.18s ease;
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
  color: var(--khy-white);
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
  /* Let the routed content scroll inside the main area instead of the page.
     min-height:0 lets this flex child shrink so overflow can take effect. */
  overflow-y: auto;
  min-height: 0;
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
