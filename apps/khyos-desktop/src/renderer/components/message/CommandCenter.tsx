import { useState, useEffect, useRef, useMemo } from 'react'
import { store } from '../../state/store'
import { addToast } from '../../state/toastSlice'
import { openWorkspace } from '../../utils/openWorkspace'
import { keyLabelFor } from '../../shared/keymap'

interface Command {
  id: string
  label: string
  description?: string
  icon: string
  // 键位徽标只从 shared/keymap.ts 的单一真源取（keyLabelFor），**不手写字符串**：
  // 表里没有绑定 → 空 → 不渲染徽标。此前这里是手写的 'Ctrl+N' / 'Ctrl+O' / 'F11'…，
  // 而对应的加速键根本没人实现，等于向用户展示一组假的快捷键。
  shortcut?: string
  category: string
  action: () => void
}

interface CommandCenterProps {
  visible: boolean
  onClose: () => void
  // Side-pane / panel commands dispatched to AppLayout's tab state machine
  // (quickPick.command.* wiring, ZC-ALIGN-003). Optional second arg carries a
  // payload (e.g. opened file path for openFile).
  onPanelAction?: (action: string, arg?: string) => void
  // 下面两个由 AppLayout 注入 —— 它才是会话状态的主人（新建任务要同时重置
  // activeTaskId 与导航历史，只清消息是不够的）。未注入 = 该命令**不渲染**：
  // 不为「列表看起来完整」留一条点了没反应的命令（[DESIGN-ARCH-125] §5 诚实边界）。
  onNewTask?: () => void
  onReloadSession?: () => void
}

function applyTheme(mode: 'dark' | 'light') {
  const api = (window as unknown as { __KHYOS__?: { setTheme?: (m: string) => Promise<void> } }).__KHYOS__
  if (!api?.setTheme) {
    store.dispatch(addToast({ type: 'error', title: '主题切换不可用：preload 未注入 __KHYOS__，请重启应用' }))
    return
  }
  void api.setTheme(mode).catch((err: unknown) => {
    store.dispatch(addToast({ type: 'error', title: `主题切换失败：${String(err)}，请重试` }))
  })
}

export function CommandCenter({ visible, onClose, onPanelAction, onNewTask, onReloadSession }: CommandCenterProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 命令清单（[DESIGN-ARCH-125] P-03）。本轮只保留**真能执行**的命令：
  // 此前 28 条里有 20 条的 action 是 `console.log('[cmd] ...')` 空壳 —— 包括
  // 「新建任务」和「打开工作区」，用户点了没有任何反应。
  //
  // 已删除且**不再恢复**的条目（连同其假快捷键），原因是它们既无后端能力也无
  // 现有 UI 可接线，留着就是假功能（诚实红线）：
  //   查找任务(Ctrl+F) / 切换模型 / 切换执行模式(Shift+Tab) / 思考强度 / 压缩上下文
  //   / 技能 / MCP 服务器 / 问题反馈 / 用户社群 / 检查更新 / 导出日志 / 开发者工具(F12)
  //   / 切换全屏(F11) / 命令面板自身
  // 模型与执行模式选择器的真正入口是 Composer 工具行右下角那一簇；技能与 MCP 在
  // 设置页。等它们各自有了可调用的通道再回到本面板登记。
  const commands: Command[] = useMemo(() => {
    const list: Command[] = []

    // ── 任务 ──
    if (onNewTask) {
      list.push({
        id: 'new-task', label: '新建任务', description: '清空当前对话，回到启动卡片页',
        icon: '➕', shortcut: keyLabelFor('newTask'), category: '任务', action: () => onNewTask(),
      })
    }
    list.push({
      id: 'open-workspace', label: '打开工作区', description: '切换工作空间：最近打开 / 选择其他文件夹',
      icon: '📂', shortcut: keyLabelFor('openWorkspace'), category: '任务', action: () => { void openWorkspace() },
    })
    if (onReloadSession) {
      list.push({
        id: 'reload-session', label: '重载会话', description: '重新加载当前会话的消息流',
        icon: '↻', category: '任务', action: () => onReloadSession(),
      })
    }

    // ── 视图（由 AppLayout 的 side-pane 状态机执行）──
    if (onPanelAction) {
      list.push(
        {
          id: 'toggle-sidepane', label: '切换面板', description: '显示/隐藏侧边面板',
          icon: '📋', shortcut: keyLabelFor('toggleSidePane'), category: '视图', action: () => onPanelAction('toggleSidePane'),
        },
        {
          id: 'toggle-terminal', label: '切换终端', description: '显示/隐藏终端面板',
          icon: '💻', shortcut: keyLabelFor('toggleTerminal'), category: '视图', action: () => onPanelAction('toggleTerminal'),
        },
        { id: 'add-terminal-tab', label: '添加终端标签', description: '在侧边面板打开终端标签', icon: '🖥️', category: '视图', action: () => onPanelAction('addTerminalTab') },
        { id: 'add-browser-tab', label: '添加浏览器标签', description: '在侧边面板打开浏览器标签', icon: '🌐', category: '视图', action: () => onPanelAction('addBrowserTab') },
        { id: 'add-review-tab', label: '添加审查标签', description: '在侧边面板打开 Git 审查标签', icon: '🔍', category: '视图', action: () => onPanelAction('addReviewTab') },
        { id: 'add-selection-chat-tab', label: '新建辅助对话', description: '在侧边面板打开辅助对话标签', icon: '💬', category: '视图', action: () => onPanelAction('addSelectionChatTab') },
      )
    }

    // ── 文件 ──
    if (onPanelAction) {
      list.push({
        id: 'open-file', label: '打开文件', description: '从当前工作区选择文件并在侧边面板打开',
        icon: '📄', category: '文件', action: () => onPanelAction('openFileTab'),
      })
    }

    // ── 应用 ──
    list.push(
      {
        id: 'settings', label: '设置', description: '打开应用设置',
        icon: '⚙️', shortcut: keyLabelFor('openSettings'), category: '应用', action: () => { window.location.hash = '#/settings' },
      },
      { id: 'switch-theme-dark', label: '切换主题到深色', description: '深色主题', icon: '🌙', category: '应用', action: () => applyTheme('dark') },
      { id: 'switch-theme-light', label: '切换主题到浅色', description: '浅色主题', icon: '☀️', category: '应用', action: () => applyTheme('light') },
    )

    return list
  }, [onPanelAction, onNewTask, onReloadSession])

  const filtered = useMemo(() => {
    if (!query.trim()) return commands
    const q = query.toLowerCase()
    return commands.filter(cmd =>
      cmd.label.toLowerCase().includes(q) ||
      cmd.description?.toLowerCase().includes(q) ||
      cmd.category.toLowerCase().includes(q)
    )
  }, [query, commands])

  const grouped = useMemo(() => {
    const groups: Record<string, Command[]> = {}
    filtered.forEach(cmd => {
      if (!groups[cmd.category]) groups[cmd.category] = []
      groups[cmd.category].push(cmd)
    })
    return groups
  }, [filtered])

  useEffect(() => {
    if (visible) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [visible])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) {
        filtered[selectedIndex].action()
        onClose()
      }
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  // 滚动选中项到视图
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
      selected?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!visible) return null

  let flatIndex = -1

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* 面板 */}
      <div className="relative w-full max-w-lg bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        {/* 搜索框 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-popover-border">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="text-foreground/40 flex-shrink-0">
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M12.5 12.5L16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索操作、任务或文件"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground/30 focus:outline-none"
          />
          <kbd className="px-1.5 py-0.5 rounded text-xs text-foreground/40 bg-surface border border-border">Esc</kbd>
        </div>

        {/* 命令列表 */}
        <div ref={listRef} className="max-h-80 overflow-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-foreground/40">
              暂无相关结果
            </div>
          ) : (
            Object.entries(grouped).map(([category, cmds]) => (
              <div key={category}>
                <div className="px-4 py-1.5 text-xs font-semibold text-foreground/40 uppercase tracking-wider">
                  {category}
                </div>
                {cmds.map(cmd => {
                  flatIndex++
                  const isSelected = flatIndex === selectedIndex
                  return (
                    <button
                      key={cmd.id}
                      data-index={flatIndex}
                      onClick={() => { cmd.action(); onClose() }}
                      className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                        isSelected ? 'bg-selected' : 'hover:bg-surface-hover'
                      }`}
                    >
                      <span className="text-base w-6 text-center">{cmd.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-popover-foreground">{cmd.label}</div>
                        {cmd.description && (
                          <div className="text-xs text-foreground/40 truncate">{cmd.description}</div>
                        )}
                      </div>
                      {cmd.shortcut && (
                        <kbd className="px-2 py-0.5 rounded text-xs text-foreground/40 bg-surface border border-border font-mono">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* 底部提示 */}
        <div className="px-4 py-2 border-t border-popover-border flex items-center gap-4 text-xs text-foreground/30">
          <span>↑↓ 导航</span>
          <span>↵ 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
