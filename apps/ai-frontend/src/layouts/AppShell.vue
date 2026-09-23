<template>
  <el-container class="layout-shell">
    <el-aside :width="collapsed ? '64px' : '224px'" class="layout-aside">
      <div class="aside-brand" :class="{ 'is-collapsed': collapsed }">
        <span class="khy-brand-logo khy-brand-logo--sm aside-logo">K</span>
        <span v-show="!collapsed" class="aside-brand-text">
          <span class="aside-brand-name">KHY</span>
          <span class="aside-brand-tier">{{ brandTier }}</span>
        </span>
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
          <span class="header-scope-chip">{{ brandTier }}</span>
        </div>

        <div class="layout-actions">
          <!-- Admin is also a user: the two consoles are separate shells, and this
               button is the bridge between them. In the user shell it is rendered
               ONLY for admins — a plain user clicking it would just be bounced to
               /403 by the router guard, so the bridge must not exist for them.
               In the admin shell it is always shown: an admin account is the only
               way to reach that shell, so the target always exists. -->
          <el-button v-if="showConsoleLink" text class="header-console-link" @click="goToOtherShell">
            <el-icon :size="16"><component :is="scope === 'user' ? Setting : HomeFilled" /></el-icon>
            <span>{{ scope === 'user' ? '管理控制台' : '用户中心' }}</span>
          </el-button>

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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Fold,
  Expand,
  Sunny,
  Moon,
  ArrowDown,
  Setting,
  HomeFilled,
} from '@element-plus/icons-vue';
import { useUserStore } from '@/stores/user';
import { visibleNavGroups, navLabelFor } from '@/nav';
import { safeSet } from '@/utils/safeStorage';
import { useTheme } from '@/composables/useTheme';
import { prefetchView, prefetchViewsIdle } from '@/composables/useRoutePrefetch';

// scope picks which NAV half this shell renders: 'user' renders the 用户中心
// group only; 'admin' renders the 管理控制台 group only. The user/admin view
// split is expressed here — an admin keeps both shells and hops between them
// via the header link, a plain user never mounts the admin shell.
const props = defineProps({
  scope: {
    type: String,
    default: 'user',
    validator: (v) => v === 'user' || v === 'admin',
  },
});

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
// One shared list: each shell keeps its own keep-alive instance, so a name only
// actually caches inside the shell that renders it.
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

// Narrow viewports auto-collapse the rail to icons. Measured on a phone (375px):
// a 224px rail eats 60% of the screen and starves the content column. The 64px
// icon rail leaves ~300px for content, and labels come back through el-tooltip
// on hover/focus. A manual toggle on a narrow screen wins until the viewport
// leaves the narrow band again (manualOverride), so the rail never fights the
// user.
//
// The width signal is a ResizeObserver on <html>, NOT window resize /
// matchMedia-change: embedded panes and devtools docking resize the layout
// viewport without firing those events on time (observed: the state lagged a
// full viewport change behind). RO fires on the actual width change, so the
// rail is always in sync with what the user sees.
const NARROW_MAX = 768;

function readCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function isNarrow() {
  const w = document.documentElement.clientWidth || window.innerWidth || 0;
  return w > 0 && w <= NARROW_MAX;
}

const collapsed = ref(readCollapsed());
let autoCollapsed = false;
let manualOverride = false;

function applyViewportCollapse() {
  if (!isNarrow()) {
    // Leaving the narrow band restores the stored preference (not the auto
    // state), and re-arms auto-collapse for the next narrow visit.
    manualOverride = false;
    if (autoCollapsed) {
      autoCollapsed = false;
      collapsed.value = readCollapsed();
    }
    return;
  }
  if (!manualOverride && !collapsed.value) {
    collapsed.value = true;
    autoCollapsed = true;
  }
}

// Two-tier brand mark: fixed "KHY" + the shell's tier name, so an admin hopping
// between the two identical-looking shells always knows which one they are in
// (brand block and header chip both read from this).
const brandTier = computed(() =>
  props.scope === 'admin' ? '管理控制台' : '用户中心'
);

// The sidebar is a pure function of NAV + role. There is deliberately no
// capability probe: entries used to auto-hide when a backend namespace was
// unreachable, which made 工作流/插件市场 look deleted whenever the ai-backend
// daemon was down. A page whose backend is unavailable says so on the page
// itself — the navigation never lies about what exists.
const navGroups = computed(() => visibleNavGroups(userStore.user, {}, { scope: props.scope }));
const visibleMenuItems = computed(() =>
  navGroups.value.flatMap((group) => group.items)
);

const userInitial = computed(() => (userStore.user?.username || 'U').charAt(0).toUpperCase());

// The console bridge exists only where its target does: admins in the user
// shell (they may hop to /admin), and everyone in the admin shell (hop home).
// A plain user never sees it — the button would be a guaranteed /403.
const showConsoleLink = computed(() => props.scope === 'admin' || userStore.isAdmin);

const currentPageTitle = computed(() => navLabelFor(route.path) || brandTier.value);

// Warm every sidebar destination during idle time after first paint, so a click
// switches instantly instead of waiting on a first-visit chunk download. Re-runs
// when the visible set changes (role re-resolution, shell switch).
function warmVisibleRoutes() {
  prefetchViewsIdle(visibleMenuItems.value.map((item) => item.path));
}
onMounted(() => {
  warmVisibleRoutes();
});
watch(visibleMenuItems, warmVisibleRoutes);

function toggleCollapse() {
  collapsed.value = !collapsed.value;
  // A manual toggle on a narrow screen opts out of auto-collapse for this band.
  if (isNarrow()) manualOverride = true;
  safeSet(SIDEBAR_STORAGE_KEY, collapsed.value ? '1' : '0');
}

let widthObserver = null;
onMounted(() => {
  applyViewportCollapse();
  if (typeof ResizeObserver !== 'undefined') {
    widthObserver = new ResizeObserver(applyViewportCollapse);
    widthObserver.observe(document.documentElement);
  }
  // Belt and braces: some panes resize without a RO-visible change on <html>.
  window.addEventListener('resize', applyViewportCollapse);
});
onBeforeUnmount(() => {
  if (widthObserver) widthObserver.disconnect();
  window.removeEventListener('resize', applyViewportCollapse);
});

// The other shell's home. user → admin console; admin → user center.
function goToOtherShell() {
  router.push(props.scope === 'user' ? '/admin/overview' : '/home');
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
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  color: var(--khy-text-strong);
}

/* Tier name reads as a quiet qualifier under/next to the wordmark, not a second
   heading — muted and smaller keeps the logo the anchor of the block. */
.aside-brand-name {
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.4px;
}

.aside-brand-tier {
  font-size: var(--khy-text-xs);
  font-weight: 600;
  color: var(--khy-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.aside-brand.is-collapsed .aside-brand-text {
  display: none;
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

.header-console-link {
  color: var(--khy-text-secondary);
  padding: 8px 12px;
}

.header-console-link:hover {
  color: var(--khy-primary-strong);
  background: var(--khy-bg-soft);
}

.header-title {
  margin: 0;
  font-size: var(--khy-text-lg);
  font-weight: 700;
  color: var(--khy-text-strong);
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Scope chip: which console am I in. Micro-label in a soft brand pill — the
   only place the shell identity is spelled out next to the page title, so an
   admin switching consoles never has to guess from the sidebar alone. */
.header-scope-chip {
  flex-shrink: 0;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--khy-primary-soft);
  color: var(--khy-primary-strong);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.5px;
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
  .header-user-name,
  .header-console-link span,
  .header-scope-chip {
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
