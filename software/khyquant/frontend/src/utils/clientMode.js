/**
 * Client mode resolver
 * - preference: auto | mobile | desktop
 * - resolved:   mobile | desktop
 */

const STORAGE_KEY = 'khy_client_mode'
const VALID = new Set(['auto', 'mobile', 'desktop'])

function hasWindow() {
  return typeof window !== 'undefined'
}

export function getClientModePreference() {
  if (!hasWindow()) return 'auto'
  const raw = String(window.localStorage.getItem(STORAGE_KEY) || '').trim().toLowerCase()
  return VALID.has(raw) ? raw : 'auto'
}

export function setClientModePreference(mode) {
  if (!hasWindow()) return
  const next = String(mode || '').trim().toLowerCase()
  if (!VALID.has(next)) return
  window.localStorage.setItem(STORAGE_KEY, next)
}

export function getModeFromQuery() {
  if (!hasWindow()) return null
  try {
    const params = new URLSearchParams(window.location.search || '')
    const q = String(params.get('view') || params.get('mode') || '').trim().toLowerCase()
    if (q === 'mobile' || q === 'desktop' || q === 'auto') return q
    return null
  } catch {
    return null
  }
}

export function detectAutoClientMode() {
  if (!hasWindow()) return 'desktop'

  const width = Number(window.innerWidth || 0)
  const ua = String(navigator.userAgent || navigator.vendor || '')
  const hasTouch =
    ('ontouchstart' in window) ||
    (navigator.maxTouchPoints || 0) > 0

  const isPhoneUA = /Android.*Mobile|iPhone|iPod|IEMobile|Opera Mini|Windows Phone/i.test(ua)
  const isTabletUA = /iPad|Android(?!.*Mobile)|Tablet|PlayBook|Silk|Kindle/i.test(ua)

  // Phone-first detection
  if (isPhoneUA) return 'mobile'

  // Small viewport always mobile
  if (width > 0 && width <= 768) return 'mobile'

  // Tablet: portrait-touch tablets can use mobile layout better
  if (isTabletUA && hasTouch && width <= 900) return 'mobile'

  return 'desktop'
}

export function resolveClientMode() {
  const queryMode = getModeFromQuery()
  const preference = queryMode || getClientModePreference()
  const resolved = preference === 'auto' ? detectAutoClientMode() : preference
  return { preference, resolved }
}

export function notifyClientModeChanged() {
  if (!hasWindow()) return
  window.dispatchEvent(new Event('khy-client-mode-changed'))
}

