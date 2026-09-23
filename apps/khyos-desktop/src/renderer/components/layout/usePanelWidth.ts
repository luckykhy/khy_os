import { useCallback, useEffect, useRef, useState } from 'react'

// Panel width persistence + drag-resize (workspaceSidebar.resizeSidebar /
// sidePane.restoreSize alignment): widths live as local state, are applied to
// the panel style, and are persisted (debounced) to settings.json via
// __KHYOS__.setSetting → main settings:set. On mount the last value is
// restored once from settings (desktopSidebarWidth / desktopSidePaneWidth).
//
// Drag contract: pointerdown captures the resizer, pointermove clamps and
// applies the width live, pointerup releases and persists. All listeners are
// window-level so the drag survives leaving the thin resizer strip, and every
// registration is cleaned up on release/unmount (no kill paths — Rule 3 safe).

export interface PanelWidthOptions {
  // settings.json key used for persistence
  settingsKey: string
  // Fallback width when no persisted value exists (or it is invalid)
  defaultWidth: number
  min: number
  max: number
}

const RESTORE_TIMEOUT_MS = 3000
const PERSIST_DEBOUNCE_MS = 300

export function usePanelWidth({ settingsKey, defaultWidth, min, max }: PanelWidthOptions) {
  const [width, setWidth] = useState<number>(defaultWidth)
  const [dragging, setDragging] = useState(false)
  // Latest width readable from drag-end without re-subscribing mid-drag
  const widthRef = useRef(width)
  widthRef.current = width
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Restore once on mount from settings.json (fail-soft: missing key or IPC
  // failure keeps the default; bounded wait so a stuck IPC never blocks UI)
  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> }
    }).__KHYOS__
    if (!api?.getSettings) {
      return
    }
    let cancelled = false
    const guard = setTimeout(() => { cancelled = true }, RESTORE_TIMEOUT_MS)
    api.getSettings().then((settings) => {
      if (cancelled) return
      const raw = settings?.[settingsKey]
      // 带 _v2 后缀的 key 读不到时才回落到旧 key —— 让「默认宽度收窄」等
      // 布局调整能重新生效，而不是被历史值卡住（ZC-ALIGN-005 面板调宽）。
      const rawV2 = settings?.[`${settingsKey}_v2`]
      const persisted = typeof rawV2 === 'number' ? rawV2 : raw
      if (typeof persisted === 'number' && Number.isFinite(persisted) && persisted >= min && persisted <= max) {
        widthRef.current = persisted
        setWidth(persisted)
      }
    }).catch(() => { /* keep default */ }).finally(() => clearTimeout(guard))
    return () => { cancelled = true; clearTimeout(guard) }
  }, [settingsKey, min, max])

  // Debounced persist so a drag writes once on settle, not per pixel
  const persist = useCallback((value: number) => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      const api = (window as unknown as {
        __KHYOS__?: { setSetting?: (key: string, value: unknown) => Promise<boolean> }
      }).__KHYOS__
      api?.setSetting?.(settingsKey, value)
    }, PERSIST_DEBOUNCE_MS)
  }, [settingsKey])

  useEffect(() => () => {
    if (persistTimer.current) clearTimeout(persistTimer.current)
  }, [])

  // Start a drag from a resizer element. `direction` decides which way the
  // panel grows: +1 = wider when the pointer moves right (left panel, resizer
  // on its right edge), -1 = wider when the pointer moves left (right panel).
  const startDrag = useCallback((e: React.PointerEvent<HTMLDivElement>, direction: 1 | -1) => {
    if (e.button !== 0) return
    e.preventDefault()
    const anchorX = e.clientX
    const startWidth = widthRef.current
    setDragging(true)

    const onMove = (ev: PointerEvent) => {
      const delta = (ev.clientX - anchorX) * direction
      widthRef.current = Math.min(max, Math.max(min, startWidth + delta))
      setWidth(widthRef.current)
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      persist(widthRef.current)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [min, max, persist])

  // Set the width programmatically (e.g. double-click restore) and persist
  const resize = useCallback((value: number) => {
    const next = Math.min(max, Math.max(min, value))
    widthRef.current = next
    setWidth(next)
    persist(next)
  }, [min, max, persist])

  return { width, dragging, resize, startDrag }
}
