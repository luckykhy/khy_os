import { useState, useEffect } from 'react'
import { TerminalPanel } from '../terminal/Terminal'
import { FileTree } from '../filetree/FileTree'
import { GitPanel } from '../git/GitPanel'

interface SidePaneProps {
  visible: boolean
  activeTab: string
  onTabChange: (tab: string) => void
  onClose: () => void
}

const TABS = [
  { id: 'files', label: '文件', icon: '📁' },
  { id: 'terminal', label: '终端', icon: '💻' },
  { id: 'git', label: 'Git', icon: '🔀' },
]

export function SidePane({ visible, activeTab, onTabChange, onClose }: SidePaneProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key === 'b') {
        e.preventDefault()
        onClose()
      }
      if (e.ctrlKey && e.key === 'j') {
        e.preventDefault()
        onTabChange('terminal')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, onTabChange])

  if (!visible) return null

  return (
    <div className="bg-panel w-80 border-l border-border flex flex-col h-full animate-slide-up">
      {/* 标签栏 */}
      <div className="flex border-b border-border items-center">
        <div className="flex flex-1">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`px-3 py-2.5 text-sm font-medium transition-all duration-150 relative ${
                activeTab === tab.id
                  ? 'text-brand'
                  : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
              }`}
            >
              <span className="mr-1.5">{tab.icon}</span>
              {tab.label}
              {activeTab === tab.id && (
                <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-brand rounded-full" />
              )}
            </button>
          ))}
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

      {/* 内容区 */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'files' && <FileTree />}
        {activeTab === 'terminal' && <TerminalPanel />}
        {activeTab === 'git' && <GitPanel />}
      </div>
    </div>
  )
}
