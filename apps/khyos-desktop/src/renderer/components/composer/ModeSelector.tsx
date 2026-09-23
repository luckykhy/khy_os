import { useState, useEffect, useRef } from 'react'

// 模式选择器 — 对齐 ZCode Composer 工具行的「切换模式」combobox
// （ZC-ALIGN-002 G0b 实测 + 092 §7.3）。真源四项取自 i18n
// `mode.label.glm.*`：「变更前确认 / 自动编辑 / 计划模式 / 完全访问」，
// 每项带 `mode.description.glm.*` 一句话说明。当前选中态由 App 层持久化到
// settings.desktopAgentMode。
//
// P3-9①（第十六轮）：默认项对齐 ZCode 实测「完全访问」
// （i18n `mode.label.glm.yolo`，ZCode s-2 a56 combobox 实测值
// 「切换模式 = 完全访问」）。此前刻意取保守「变更前确认」，导致首屏
// 与 ZCode 的可见文案不一致（P1 失真）；用户显式切换后仍会经
// settings.desktopAgentMode 持久化覆盖默认值，行为不变。
export const AGENT_MODES: { id: string; label: string; description: string }[] = [
  { id: 'confirm', label: '变更前确认', description: '改文件前先问我。' },
  { id: 'autoEdit', label: '自动编辑', description: '自动编辑文件。' },
  { id: 'plan', label: '计划模式', description: '编辑前先出计划。' },
  { id: 'fullAccess', label: '完全访问', description: '减少确认次数。' },
]

// 对齐 ZCode 实测默认「完全访问」（i18n mode.label.glm.yolo，P3-9①）。
export const DEFAULT_AGENT_MODE = 'fullAccess'

interface ModeSelectorProps {
  mode: string
  onModeChange: (mode: string) => void
}

export function ModeSelector({ mode, onModeChange }: ModeSelectorProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = AGENT_MODES.find((m) => m.id === mode) ?? AGENT_MODES[0]

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Shift+Tab 循环切换模式（ZCode 模式快捷键）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.key !== 'Tab') return
      e.preventDefault()
      const idx = AGENT_MODES.findIndex((m) => m.id === mode)
      onModeChange(AGENT_MODES[(idx + 1) % AGENT_MODES.length].id)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mode, onModeChange])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-2 py-1 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1 whitespace-nowrap"
        title={`切换模式（当前：${current.label}，Shift+Tab 循环切换）`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{current.label}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M1.5 3l2.5 2.5L6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full mb-2 right-0 w-60 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden z-50"
        >
          <div className="px-3 py-2 text-xs font-semibold text-popover-header border-b border-popover-border">
            切换模式
          </div>
          {AGENT_MODES.map((m) => (
            <button
              key={m.id}
              role="menuitem"
              onClick={() => { onModeChange(m.id); setOpen(false) }}
              className={`w-full text-left px-3 py-2 transition-colors ${
                mode === m.id ? 'bg-selected' : 'hover:bg-surface-hover'
              }`}
            >
              <div className="text-sm font-medium text-popover-foreground">{m.label}</div>
              <div className="text-xs text-foreground/40 mt-0.5">{m.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
