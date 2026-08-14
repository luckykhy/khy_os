import { DEFAULT_BACKEND_URL } from '@/constants/serviceDefaults'
const CONNECTION_MODE_KEY = 'khy_connection_mode' // auto | cloud | local
const BACKEND_URL_KEY = 'khy_backend_url'

/**
 * Determine default connection mode based on deployment environment:
 * - Web (khyquant.top): ALWAYS cloud (no local option)
 * - Local (localhost / pip): default local, optional cloud login
 * - Capacitor (mobile app): default cloud
 */
function getDefaultConnectionMode() {
  if (!isBrowserEnv()) return 'local'

  const host = window.location?.hostname || ''

  // Deployed web version = cloud only
  if (host.includes('khyquant.top') || host.includes('khyquant.com')) {
    return 'cloud'
  }

  // Mobile app = cloud default
  if (isCapacitorNative()) {
    return 'cloud'
  }

  // Local development / pip install = local default (can switch to cloud)
  return 'local'
}

const DEFAULT_CONNECTION_MODE = getDefaultConnectionMode()

export function isBrowserEnv() {
  return typeof window !== 'undefined'
}

export function isCapacitorNative() {
  return isBrowserEnv() && !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
}

export function isMobileViewport() {
  if (!isBrowserEnv()) return false
  return window.innerWidth <= 768
}

export function getConnectionMode() {
  if (!isBrowserEnv()) return DEFAULT_CONNECTION_MODE
  const mode = localStorage.getItem(CONNECTION_MODE_KEY)
  if (mode === 'auto' || mode === 'cloud' || mode === 'local') return mode
  return DEFAULT_CONNECTION_MODE
}

export function setConnectionMode(mode) {
  if (!isBrowserEnv()) return
  const safeMode = mode === 'local' || mode === 'cloud' || mode === 'auto' ? mode : DEFAULT_CONNECTION_MODE
  localStorage.setItem(CONNECTION_MODE_KEY, safeMode)
}

export function getBackendUrl() {
  if (!isBrowserEnv()) return DEFAULT_BACKEND_URL
  const raw = (localStorage.getItem(BACKEND_URL_KEY) || DEFAULT_BACKEND_URL).trim()
  return raw.replace(/\/$/, '')
}

export function setBackendUrl(url) {
  if (!isBrowserEnv()) return
  const safe = (url || '').trim().replace(/\/$/, '')
  if (!safe) {
    localStorage.setItem(BACKEND_URL_KEY, DEFAULT_BACKEND_URL)
    return
  }
  localStorage.setItem(BACKEND_URL_KEY, safe)
}

export function getApiBaseUrl() {
  // Web/Electron: use reverse proxy path
  if (!isCapacitorNative()) return '/api'

  // Capacitor native: direct connect to configured backend URL
  return `${getBackendUrl()}/api`
}

export function getRequestTimeoutMs() {
  // Mobile should fail fast to improve responsiveness
  return isCapacitorNative() ? 15000 : 120000
}

export function isNetworkLikeError(error) {
  if (!error) return false
  if (!error.response) return true
  const code = error.code || ''
  return ['ECONNABORTED', 'ERR_NETWORK', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)
}

export function shouldUseLocalAuthFallback(error) {
  const mode = getConnectionMode()
  if (mode === 'local') return true
  if (mode === 'cloud') return false

  // auto mode: fallback on network failures only
  return isNetworkLikeError(error)
}

export function getConnectionProfile() {
  return {
    mode: getConnectionMode(),
    backendUrl: getBackendUrl(),
    apiBaseUrl: getApiBaseUrl(),
    native: isCapacitorNative()
  }
}

export const connectionModeKeys = {
  CONNECTION_MODE_KEY,
  BACKEND_URL_KEY,
  DEFAULT_BACKEND_URL,
  DEFAULT_CONNECTION_MODE
}
