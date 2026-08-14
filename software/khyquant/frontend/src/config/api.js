// API配置 - 统一管理API基础URL
import {
  getApiBaseUrl as getRuntimeApiBaseUrl,
  getBackendUrl,
  isCapacitorNative
} from '@/utils/connectionMode'

/**
 * 获取API基础URL
 * 开发环境: 使用相对路径 /api，由Vite代理转发到后端3000端口
 * 生产环境: 使用相对路径 /api
 */
export function getApiBaseUrl() {
  return getRuntimeApiBaseUrl()
}

function toWsUrl(protocol, host) {
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${host}/ws`
}

/**
 * 获取WebSocket URL
 * Web/Electron: current origin
 * Capacitor: use configured backend URL (supports cloud/LAN targets)
 */
export function getWsUrl() {
  if (typeof window === 'undefined') {
    const host = import.meta.env.VITE_BACKEND_HOST || '127.0.0.1'
    const port = import.meta.env.VITE_BACKEND_PORT || '3000'
    return `ws://${host}:${port}/ws`
  }

  if (isCapacitorNative()) {
    try {
      const backend = new URL(getBackendUrl())
      return toWsUrl(backend.protocol, backend.host)
    } catch {
      // Fall back to current origin below
    }
  }

  const { protocol, host } = window.location
  return toWsUrl(protocol, host)
}

// 默认导出 - 只导出函数，不导出常量（避免构建时内联）
export default {
  getApiBaseUrl,
  getWsUrl
}
