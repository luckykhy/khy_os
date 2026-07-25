// 开发环境专用配置
// 这个文件只在开发环境使用,不会被打包到生产构建中

/**
 * 获取API基础URL - 开发环境版本
 */
export function getApiBaseUrl() {
  const host = import.meta.env.VITE_BACKEND_HOST || (typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1')
  const port = import.meta.env.VITE_BACKEND_PORT || '3000'
  return `http://${host}:${port}`
}

/**
 * 获取WebSocket URL - 开发环境版本
 */
export function getWsUrl() {
  const host = import.meta.env.VITE_BACKEND_HOST || (typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1')
  const port = import.meta.env.VITE_BACKEND_PORT || '3000'
  const wsProtocol = (typeof window !== 'undefined' && window.location.protocol === 'https:') ? 'wss:' : 'ws:'
  return `${wsProtocol}//${host}:${port}/ws`
}

export default {
  getApiBaseUrl,
  getWsUrl
}
