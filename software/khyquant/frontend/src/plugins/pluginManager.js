/**
 * Frontend Plugin Manager — discovers and installs khy-* frontend plugins.
 *
 * Plugins register routes, menu items, and stores dynamically at startup.
 * The host frontend has zero hardcoded references to any plugin's components.
 *
 * Discovery: Uses Vite's import.meta.glob to find packages/khy-*\/frontend/index.{js,ts}
 */
import { reactive } from 'vue'
import request from '@/api/request'
import websocketService from '@/services/websocketService'

// ─── Reactive plugin state (consumed by Layout.vue and other host components) ──

export const pluginState = reactive({
  /** Menu items registered by plugins (sorted by order) */
  menuItems: [],
  /** Admin tabs registered by plugins */
  adminTabs: [],
  /** Loaded plugin metadata */
  plugins: [],
})

// ─── Host base menu items (always present regardless of plugins) ──

export const HOST_MENU_ITEMS = [
  { path: '/dashboard', label: '主页', icon: 'Odometer', order: 1 },
  { path: '/announcements', label: '通知公告', icon: 'Bell', order: 80 },
  { path: '/feedback', label: '意见反馈', icon: 'ChatDotRound', order: 85 },
  { path: '/profile', label: '个人中心', icon: 'User', order: 90 },
  { path: '/api-keys', label: 'API Key', icon: 'Key', order: 95 },
  { path: '/dependencies', label: '依赖管理', icon: 'Box', order: 96 },
  { path: '/system-management', label: '统一管理', icon: 'Operation', order: 97 },
]

/**
 * Create a FrontendPluginContext for a plugin to interact with the host.
 */
function createPluginContext(app, router, pinia) {
  return {
    router,
    pinia,

    addMenuItems(items) {
      for (const item of items) {
        // Prevent duplicates
        if (!pluginState.menuItems.find(m => m.path === item.path)) {
          pluginState.menuItems.push(item)
        }
      }
      pluginState.menuItems.sort((a, b) => (a.order || 99) - (b.order || 99))
    },

    addAdminTabs(tabs) {
      pluginState.adminTabs.push(...tabs)
    },

    host: {
      apiBaseUrl: import.meta.env.VITE_API_BASE_URL || '',
      websocket: websocketService,
      get user() {
        const userStore = pinia._s?.get('user')
        return userStore || { token: null, userInfo: null }
      },
      request,
    },

    provide(key, value) {
      app.provide(key, value)
    },
  }
}

/**
 * Discover and install all frontend plugins from the monorepo workspace.
 *
 * Call this in main.js after app, router, and pinia are created.
 *
 * @param {import('vue').App} app - Vue app instance
 * @param {import('vue-router').Router} router - Router instance
 * @param {import('pinia').Pinia} pinia - Pinia instance
 */
export function installPlugins(app, router, pinia) {
  const ctx = createPluginContext(app, router, pinia)

  // Auto-discover plugins via Vite glob import
  // This pattern matches: packages/khy-*/frontend/index.{js,ts}
  const pluginModules = import.meta.glob(
    '../../packages/khy-*/frontend/index.{js,ts}',
    { eager: true }
  )

  for (const [modulePath, mod] of Object.entries(pluginModules)) {
    const plugin = mod.default || mod
    if (!plugin || !plugin.namespace || !plugin.install) {
      console.warn(`[PluginManager] Invalid plugin at ${modulePath}: missing namespace or install`)
      continue
    }

    try {
      plugin.install(ctx)
      pluginState.plugins.push({
        namespace: plugin.namespace,
        displayName: plugin.displayName || plugin.namespace,
        icon: plugin.icon,
      })
    } catch (err) {
      console.warn(`[PluginManager] Plugin "${plugin.namespace}" install failed:`, err.message)
    }
  }

  if (pluginState.plugins.length > 0) {
    console.log(
      `[PluginManager] ${pluginState.plugins.length} plugin(s) loaded:`,
      pluginState.plugins.map(p => p.displayName).join(', ')
    )
  }
}

/**
 * Get all menu items: host base + plugin-registered.
 * Used by Layout.vue to render the navigation.
 */
export function getAllMenuItems() {
  return [...HOST_MENU_ITEMS, ...pluginState.menuItems]
}
