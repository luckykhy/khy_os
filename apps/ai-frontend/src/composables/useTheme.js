import { ref } from 'vue'

/**
 * Theme composable (singleton).
 *
 * Manages light/dark theme state, persists the choice to localStorage and
 * toggles the `dark` class on <html> so both the custom --khy-* tokens and the
 * Element Plus dark css-vars react together.
 *
 * The default follows the OS `prefers-color-scheme` until the user makes an
 * explicit choice.
 */

const STORAGE_KEY = 'khy_ai_theme'
const VALID = ['light', 'dark']

function readStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value && VALID.includes(value)) return value
  } catch {
    // ignore storage access errors (private mode, etc.)
  }
  return null
}

function systemPrefersDark() {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

function resolveInitialTheme() {
  return readStoredTheme() || (systemPrefersDark() ? 'dark' : 'light')
}

/** Apply the theme to <html> without persisting. Safe to call pre-mount. */
export function applyTheme(theme) {
  const next = VALID.includes(theme) ? theme : 'light'
  try {
    const root = document.documentElement
    root.classList.toggle('dark', next === 'dark')
    root.setAttribute('data-theme', next)
    root.style.colorScheme = next
  } catch {
    // document may be unavailable in SSR-like contexts
  }
  return next
}

// Singleton state shared across all callers.
const theme = ref(applyTheme(resolveInitialTheme()))

export function useTheme() {
  function setTheme(next) {
    const applied = applyTheme(next)
    theme.value = applied
    try {
      localStorage.setItem(STORAGE_KEY, applied)
    } catch {
      // ignore storage write errors
    }
  }

  function toggleTheme() {
    setTheme(theme.value === 'dark' ? 'light' : 'dark')
  }

  return { theme, setTheme, toggleTheme }
}
