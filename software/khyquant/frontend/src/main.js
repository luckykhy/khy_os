/**
 * KHY-Quant 量化交易系统 - 前端应用入口
 * Copyright (c) 2026 孔浩原 (Kong Haoyuan). All Rights Reserved.
 *
 * 架构角色：Vue3 应用的启动文件，负责初始化整个前端交互层
 *
 * 初始化顺序：
 *   1. 创建 Vue 应用实例
 *   2. 注册 Pinia 状态管理（对应论文第2.1节，表2 Vue3 特性）
 *   3. 注册 Vue Router 路由（对应论文图5 路由树）
 *   4. 注册 Element Plus UI 组件库（中文语言包）
 *   5. 注册全局图标组件
 *   6. 配置全局错误处理器（兜底异常捕获）
 *   7. 挂载 WebSocket 实时通信服务（对应论文第2.4节）
 *   8. 挂载应用到 DOM
 *
 * 对应论文：第2.1节（前端技术栈）、第5.5节（前端实现与部署）
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'

import App from './App.vue'
import router from './router'
import websocketService from './services/websocketService'
import { ElMessage } from 'element-plus'
import { getFriendlyErrorMessage } from './utils/errorMessage'
import { Capacitor } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'

// 生产环境移除调试日志，保留错误日志
if (import.meta.env.PROD) {
  console.log = () => {}
  console.info = () => {}
  console.debug = () => {}
}

// 屏蔽浏览器扩展和框架内部的噪声日志
// 这些错误不影响系统功能，但会干扰开发和答辩演示时的控制台输出
const originalError = console.error
const NOISY_ERROR_PATTERNS = [
  'runtime.lastError',
  'can not use with devtools',
  'ERR_CONNECTION_REFUSED',
  'WebSocket',
  'ResizeObserver loop completed with undelivered notifications',
  'ResizeObserver loop limit exceeded'
]

const isIgnorableNoise = (input) => {
  const text = typeof input === 'string'
    ? input
    : (input?.message || input?.toString?.() || '')
  return NOISY_ERROR_PATTERNS.some(p => text.includes(p))
}

console.error = (...args) => {
  if (args.some(a => isIgnorableNoise(a))) return
  originalError.apply(console, args)
}

// 引入全局主题样式
import './styles/theme.css'
// 引入移动端响应式样式
import './styles/mobile.css'
// 引入移动端滚动优化样式
import './styles/mobile-scroll.css'
// Responsive breakpoint overrides
import './styles/responsive.css'

// 🔧 引入网络监控和请求拦截器 (暂时禁用,可能导致加载问题)
// import networkMonitor from './utils/networkMonitor'
// import { setupRequestInterceptor } from './utils/requestInterceptor'

const app = createApp(App)
const pinia = createPinia()

// 注册所有图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(pinia)
app.use(router)
app.use(ElementPlus, { locale: zhCn })

// Install frontend plugins (dynamic route/menu registration from khy-* packages)
import { installPlugins } from './plugins/pluginManager'
installPlugins(app, router, pinia)

// Global error handler
app.config.errorHandler = (err, instance, info) => {
  if (isIgnorableNoise(err)) return

  if (err && err.message && err.message.includes('getBoundingClientRect is not a function')) {
    return
  }

  if (import.meta.env.PROD) {
    // Production: minimal logging, no component names or stacks
    console.error('[Error]', err?.message || 'Unknown error')
  } else {
    // Development: full verbose logging
    console.error('[Dev Error]', err?.message, 'in', instance?.$options?.name, info)
    console.error(err?.stack)
  }

  ElMessage.error(getFriendlyErrorMessage(err, '页面发生异常，请稍后重试'))
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason
  if (isIgnorableNoise(reason)) {
    event.preventDefault()
    return
  }
  console.error('未处理的Promise异常:', reason)
  ElMessage.error(getFriendlyErrorMessage(reason, '请求异常，请稍后重试'))
})

window.addEventListener('error', (event) => {
  if (isIgnorableNoise(event?.error || event?.message)) {
    event.preventDefault()
    return
  }
  const err = event?.error || new Error(event?.message || '未知错误')
  console.error('全局运行时错误:', err)
})

// 🔥 添加全局警告处理器（开发模式）
if (import.meta.env.DEV) {
  app.config.warnHandler = (msg, instance, trace) => {
    if (msg.includes('slice') || msg.includes('array')) {
      console.warn('⚠️ [Global Warn Handler] Array-related warning:', {
        message: msg,
        componentName: instance?.$options?.name || 'Unknown',
        trace: trace
      })
    }
  }
}

// 全局提供WebSocket服务
app.provide('websocketService', websocketService)

// 🔧 设置请求拦截器(统一处理网络错误) - 暂时禁用
// setupRequestInterceptor()

// 🔧 启动网络监控(定期检查后端连接状态) - 暂时禁用
// 延迟5秒启动,避免应用初始化时的误报
// setTimeout(() => {
//   networkMonitor.startMonitoring()
//   console.log('✅ 网络监控已启动')
// }, 5000)

// 路由后置守卫：登录后自动连接 WebSocket
// WebSocket 用于实时推送行情变化和分析状态（对应论文第2.4节实时通信机制）
// 遵循"先认证后推送"原则：只有已登录用户才建立 WebSocket 连接
router.afterEach((to, from) => {
  // 检查用户是否已登录
  const userStore = pinia._s.get('user')
  if (userStore && userStore.token && !websocketService.isConnected) {
    console.log('用户已登录，连接WebSocket...')
    websocketService.connect().catch(error => {
      console.error('WebSocket连接失败:', error)
    })
  }
})

app.mount('#app')

if (Capacitor.isNativePlatform()) {
  const hideNativeSplash = () => {
    SplashScreen.hide().catch(() => {})
  }

  window.addEventListener('khy-app-ready', hideNativeSplash, { once: true })
  // 兜底：避免异常导致原生启动页不消失
  setTimeout(hideNativeSplash, 8000)
}
