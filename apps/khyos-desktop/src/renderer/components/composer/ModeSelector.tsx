import { useState, useEffect, useRef } from 'react'

interface Provider {
  id: string
  label: string
  icon: string
  modes: { id: string; label: string; description: string }[]
}

const PROVIDERS: Provider[] = [
  {
    id: 'claude',
    label: 'Claude',
    icon: '🧠',
    modes: [
      { id: 'default', label: '默认模式', description: '编辑和高风险操作前询问' },
      { id: 'plan', label: '计划模式', description: '先计划，确认后执行' },
      { id: 'acceptEdits', label: '自动接受编辑', description: '自动接受文件编辑' },
      { id: 'dontAsk', label: '静默模式', description: '跳过常规确认' },
      { id: 'bypassPermissions', label: '跳过权限检查', description: '跳过权限检查' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    icon: '⚡',
    modes: [
      { id: 'readOnly', label: '只读模式', description: '只读代码，不修改文件' },
      { id: 'agent', label: 'Agent 模式', description: '编辑和运行命令前保留确认' },
      { id: 'auto', label: '自动编辑模式', description: '在常规保护下编辑' },
      { id: 'agentFullAccess', label: '全权限模式', description: '完整文件和网络访问' },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    icon: '💎',
    modes: [
      { id: 'default', label: '默认模式', description: '使用默认确认策略' },
      { id: 'plan', label: '计划模式', description: '先计划，确认后执行' },
      { id: 'autoEdit', label: '自动编辑模式', description: '自动应用编辑' },
      { id: 'yolo', label: '全自动模式', description: '减少确认次数' },
    ],
  },
  {
    id: 'glm',
    label: 'GLM',
    icon: '🔮',
    modes: [
      { id: 'default', label: '默认模式', description: '使用默认确认策略' },
      { id: 'plan', label: '计划模式', description: '编辑前先出计划' },
      { id: 'build', label: '变更前确认', description: '改文件前先问我' },
      { id: 'edit', label: '自动编辑', description: '自动编辑文件' },
      { id: 'yolo', label: '完全访问', description: '减少确认次数' },
    ],
  },
]

interface ModeSelectorProps {
  provider: string
  mode: string
  onProviderChange: (provider: string) => void
  onModeChange: (mode: string) => void
}

export function ModeSelector({ provider, mode, onProviderChange, onModeChange }: ModeSelectorProps) {
  const [expanded, setExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const currentProvider = PROVIDERS.find(p => p.id === provider) ?? PROVIDERS[0]
  const currentMode = currentProvider.modes.find(m => m.id === mode) ?? currentProvider.modes[0]

  // Shift+Tab 循环切换模式
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault()
        const currentIndex = currentProvider.modes.findIndex(m => m.id === mode)
        const nextIndex = (currentIndex + 1) % currentProvider.modes.length
        onModeChange(currentProvider.modes[nextIndex].id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [provider, mode, currentProvider, onModeChange])

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-card border border-card-border hover:bg-surface-hover transition-colors text-sm"
      >
        <span>{currentProvider.icon}</span>
        <span className="text-foreground font-medium">{currentMode.label}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`text-foreground/40 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {expanded && (
        <div className="absolute bottom-full mb-2 left-0 w-72 bg-popover border border-popover-border rounded-xl shadow-2xl overflow-hidden animate-slide-down z-50">
          {/* Provider 选择 */}
          <div className="flex border-b border-popover-border p-1 gap-0.5">
            {PROVIDERS.map(p => (
              <button
                key={p.id}
                onClick={() => { onProviderChange(p.id); onModeChange(p.modes[0].id) }}
                className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  provider === p.id
                    ? 'bg-selected text-brand'
                    : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
                }`}
              >
                <span className="mr-1">{p.icon}</span>
                {p.label}
              </button>
            ))}
          </div>

          {/* Mode 列表 */}
          <div className="max-h-64 overflow-auto py-1">
            {currentProvider.modes.map(m => (
              <button
                key={m.id}
                onClick={() => { onModeChange(m.id); setExpanded(false) }}
                className={`w-full text-left px-3 py-2.5 transition-colors ${
                  mode === m.id ? 'bg-selected' : 'hover:bg-surface-hover'
                }`}
              >
                <div className="text-sm font-medium text-popover-foreground">{m.label}</div>
                <div className="text-xs text-foreground/40 mt-0.5">{m.description}</div>
              </button>
            ))}
          </div>

          {/* 快捷键提示 */}
          <div className="px-3 py-2 border-t border-popover-border text-xs text-foreground/30 flex items-center justify-between">
            <span>Shift+Tab 循环切换</span>
            <span>Esc 关闭</span>
          </div>
        </div>
      )}
    </div>
  )
}
