import { useEffect, useRef, useState } from 'react'
import { TerminalPanel } from '../terminal/Terminal'
import { GitPanel } from '../git/GitPanel'
import { BrowserPane } from '../browser/BrowserPane'
import { SelectionChatPane } from '../selection/SelectionChatPane'
import { CodeViewerPane } from '../viewer/CodeViewerPane'
import { OpenFilePane } from '../viewer/OpenFilePane'

// Side pane as a multi-tab container (sidePane.* i18n, ZC-ALIGN-003):
// empty state shows the 打开标签页 tile selector; open tabs render a strip
// with per-tab close + 新增标签 (back to selector) + the active pane body.

export type PaneTabKind = 'selectionChat' | 'review' | 'terminal' | 'browser' | 'openFile' | 'file'

export interface PaneTab {
  id: string
  kind: PaneTabKind
  title: string
  // 'file' tabs carry the opened file path (title shows the file name)
  filePath?: string
}

interface SidePaneProps {
  visible: boolean
  tabs: PaneTab[]
  activeTabId: string | null
  hasSessions: boolean
  // Panel width in px (drag-resizable from its left edge, owned by AppLayout)
  width?: number
  // Selector tile click → open that tab kind (SidePane owns the selector view)
  onOpenTab: (kind: PaneTabKind) => void
  onTabSelect: (id: string) => void
  onTabClose: (id: string) => void
  // 打开文件选择器选中文件 → AppLayout 打开 codeViewer 标签（sidePane.openFile）
  onOpenFile: (filePath: string) => void
  // Ctrl+Alt+B 切换面板：面板隐藏时也能呼出（快捷键注册在 visible 闸门之前）
  onToggle: () => void
  onClose: () => void
}

// Tile copy maps 1:1 to ZCode: 辅助对话 / 审查 / 终端 / 浏览器 + 打开文件
// (icons are the placeholder glyphs; ZCode draws real icons — swap when assets
// land). 打开文件 is the sidePane.openFile quickPick (opens the file picker).
const TAB_TILES: { kind: PaneTabKind; label: string; icon: string; description: string }[] = [
  { kind: 'selectionChat', label: '辅助对话', icon: '💬', description: '独立于主会话的小型问答' },
  { kind: 'review', label: '审查', icon: '🔍', description: '当前工作区的 Git 改动' },
  { kind: 'terminal', label: '终端', icon: '💻', description: '在面板中运行命令' },
  { kind: 'browser', label: '浏览器', icon: '🌐', description: '在面板中打开网页' },
  { kind: 'openFile', label: '打开文件', icon: '📄', description: '从当前 workspace 中选择文件并在侧边面板打开。' },
]

function TabBody({
  kind,
  filePath,
  onOpenFile,
  onFileClose,
}: {
  kind: PaneTabKind
  filePath?: string
  onOpenFile: (filePath: string) => void
  onFileClose: () => void
}) {
  switch (kind) {
    case 'selectionChat':
      return <SelectionChatPane />
    case 'review':
      return <GitPanel />
    case 'terminal':
      return <TerminalPanel />
    case 'browser':
      return <BrowserPane />
    case 'openFile':
      return <OpenFilePane onOpenFile={onOpenFile} />
    case 'file':
      return <CodeViewerPane filePath={filePath || ''} onClose={onFileClose} />
  }
}

export function SidePane({ visible, tabs, activeTabId, hasSessions, width, onOpenTab, onOpenFile, onTabSelect, onTabClose, onToggle, onClose }: SidePaneProps) {
  // 搜索标签页 dropdown open state (closes on outside click / Escape)
  const [searchMenuOpen, setSearchMenuOpen] = useState(false)
  const searchMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!searchMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (searchMenuRef.current && !searchMenuRef.current.contains(e.target as Node)) {
        setSearchMenuOpen(false)
      }
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [searchMenuOpen])

  // Shortcuts are registered BEFORE the visible gate so they also work while
  // the pane is hidden: Ctrl+Alt+B toggles (parent decides direction),
  // Ctrl+J opens/focuses a terminal tab (sidePane.openTab convention).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key === 'b') {
        e.preventDefault()
        onToggle()
      }
      if (e.ctrlKey && e.key === 'j') {
        e.preventDefault()
        onOpenTab('terminal')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onToggle, onOpenTab])

  if (!visible) return null

  const activeTab = tabs.find((t) => t.id === activeTabId) || null

  return (
    <div
      className="bg-panel border-l border-border flex flex-col h-full animate-slide-up"
      style={width ? { width: `${width}px` } : undefined}
    >
      {/* 标签栏：每标签一个条目 + 关闭按钮；新增标签回到选择器 */}
      <div className="flex border-b border-border items-center">
        <div className="flex flex-1 overflow-x-auto">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`group flex items-center gap-1 pl-3 pr-1.5 py-2.5 text-sm font-medium transition-all duration-150 relative cursor-pointer ${
                activeTabId === tab.id
                  ? 'text-brand'
                  : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
              }`}
              onClick={() => onTabSelect(tab.id)}
            >
              <span className="truncate max-w-24">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onTabClose(tab.id)
                }}
                className="w-4 h-4 rounded flex items-center justify-center text-foreground/30 hover:text-foreground hover:bg-surface-hover opacity-0 group-hover:opacity-100 transition-all"
                aria-label={`关闭 ${tab.title}`}
              >
                <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                  <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              {activeTabId === tab.id && (
                <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-brand rounded-full" />
              )}
            </div>
          ))}
          {/* 新增标签（sidePane.addTab）→ 回到选择器：清空 activeTabId */}
          <button
            onClick={() => onTabSelect('')}
            title="新增标签"
            className="w-8 flex items-center justify-center text-foreground/40 hover:text-foreground hover:bg-surface-hover transition-colors shrink-0"
            aria-label="新增标签"
          >
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {/* 搜索标签页（sidePane.tabOverview，ZCode s-45 实测 has_menu）：下拉
            列出全部标签，点击聚焦；无标签时显示 noTabsFound 空态行 */}
        <div ref={searchMenuRef} className="relative shrink-0">
          <button
            onClick={() => setSearchMenuOpen((v) => !v)}
            className="p-2 text-foreground/40 hover:text-foreground hover:bg-surface-hover rounded-md transition-colors"
            title="搜索标签页"
            aria-label="搜索标签页"
            aria-haspopup="menu"
            aria-expanded={searchMenuOpen}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9.2 9.2L12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {searchMenuOpen && (
            <div
              className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg py-1 z-50"
              role="menu"
            >
              <div className="px-3 py-1.5 text-xs font-medium text-foreground/50">
                打开的标签页
              </div>
              {tabs.length === 0 ? (
                <div className="px-3 py-2 text-xs text-foreground/40">
                  没有找到标签页。
                </div>
              ) : (
                tabs.map((tab) => (
                  <button
                    key={tab.id}
                    role="menuitem"
                    onClick={() => {
                      onTabSelect(tab.id)
                      setSearchMenuOpen(false)
                    }}
                    className={`w-full px-3 py-1.5 text-left text-sm truncate transition-colors ${
                      activeTabId === tab.id
                        ? 'text-foreground bg-selected'
                        : 'text-foreground/70 hover:text-foreground hover:bg-surface-hover'
                    }`}
                  >
                    {tab.title}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-2 text-foreground/40 hover:text-foreground hover:bg-surface-hover rounded-md mr-1 transition-colors"
          aria-label="关闭面板"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* 内容区：无激活标签时显示「打开标签页」选择器；否则显示标签体 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {!activeTab ? (
          <div className="flex flex-col h-full overflow-auto">
            <div className="px-4 pt-5 pb-1">
              <h3 className="text-sm font-medium text-foreground">打开标签页</h3>
              <p className="text-xs text-foreground/50 mt-1">选择要在侧边面板中打开的标签。</p>
            </div>
            <div className="grid grid-cols-2 gap-2 px-4 py-3">
              {TAB_TILES.filter((t) => t.kind !== 'selectionChat' || hasSessions).map((tile) => (
                <button
                  key={tile.kind}
                  onClick={() => onOpenTab(tile.kind)}
                  className="flex flex-col gap-1.5 p-3 rounded-xl border border-border bg-card hover:bg-surface-hover transition-colors text-left"
                >
                  <span className="text-xl">{tile.icon}</span>
                  <div>
                    <div className="text-sm font-medium text-foreground">{tile.label}</div>
                    <div className="text-xs text-foreground/40 mt-0.5">{tile.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* 标签体挂载区：非激活标签保持挂载会保住终端会话/表单状态；
                但当前先只渲染激活标签（与 ZCode 面板行为一致的轻量起点） */}
            <TabBody
              key={activeTab.id}
              kind={activeTab.kind}
              filePath={activeTab.filePath}
              onOpenFile={onOpenFile}
              onFileClose={() => onTabClose(activeTab.id)}
            />
          </>
        )}
      </div>
    </div>
  )
}
