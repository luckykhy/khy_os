import { useEffect, useCallback } from 'react'

export interface KeyboardShortcut {
  key: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
  handler: (e: KeyboardEvent) => void
  description: string
}

/**
 * Global keyboard shortcut hook.
 * Register shortcuts that work app-wide.
 */
export function useKeyboard(shortcuts: KeyboardShortcut[], enabled = true) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    for (const shortcut of shortcuts) {
      const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase()
      const ctrlMatch = shortcut.ctrl ? (e.ctrlKey || e.metaKey) : !(e.ctrlKey || e.metaKey)
      const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey
      const altMatch = shortcut.alt ? e.altKey : !e.altKey
      const metaMatch = shortcut.meta ? e.metaKey : !e.metaKey

      if (keyMatch && ctrlMatch && shiftMatch && altMatch && metaMatch) {
        // Don't trigger shortcuts when typing in inputs
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
          // Allow Escape and Ctrl+key shortcuts even in inputs
          if (e.key !== 'Escape' && !e.ctrlKey && !e.metaKey) {
            continue
          }
        }
        shortcut.handler(e)
        return
      }
    }
  }, [shortcuts])

  useEffect(() => {
    if (!enabled) return
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown, enabled])
}

/**
 * Format shortcut for display
 */
export function formatShortcut(shortcut: Partial<KeyboardShortcut>): string {
  const parts: string[] = []
  if (shortcut.ctrl) parts.push('Ctrl')
  if (shortcut.shift) parts.push('Shift')
  if (shortcut.alt) parts.push('Alt')
  if (shortcut.meta) parts.push('Cmd')
  if (shortcut.key) parts.push(shortcut.key === ' ' ? 'Space' : shortcut.key.toUpperCase())
  return parts.join(' + ')
}
