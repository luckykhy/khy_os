import { useState } from 'react'

interface SidebarProps {
  activePanel: string
  onPanelChange: (panel: string) => void
}

const NAV_ITEMS = [
  { id: 'tasks', icon: '📋', label: '任务' },
  { id: 'files', icon: '📁', label: '文件' },
  { id: 'git', icon: '🔀', label: 'Git' },
  { id: 'terminal', icon: '💻', label: '终端' },
  { id: 'browser', icon: '🌐', label: '浏览器' },
]

export function Sidebar({ activePanel, onPanelChange }: SidebarProps) {
  const [hoveredItem, setHoveredItem] = useState<string | null>(null)

  return (
    <div className="bg-sidebar w-12 flex flex-col items-center py-2 gap-0.5 border-r border-border select-none">
      <div className="flex flex-col items-center gap-0.5 py-1">
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            onClick={() => onPanelChange(item.id)}
            onMouseEnter={() => setHoveredItem(item.id)}
            onMouseLeave={() => setHoveredItem(null)}
            className={`relative w-10 h-10 rounded-lg flex items-center justify-center text-sm transition-all duration-150 ${
              activePanel === item.id
                ? 'bg-selected text-brand'
                : 'text-foreground/70 hover:bg-surface-hover hover:text-foreground'
            }`}
            aria-label={item.label}
          >
            <span className="text-base">{item.icon}</span>
            {hoveredItem === item.id && (
              <div className="absolute left-full ml-2 px-2 py-1 bg-popover border border-popover-border rounded-md text-xs text-popover-foreground whitespace-nowrap shadow-lg z-50 animate-fade-in">
                {item.label}
              </div>
            )}
          </button>
        ))}
      </div>
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-0.5 py-1">
        <button
          onMouseEnter={() => setHoveredItem('notifications')}
          onMouseLeave={() => setHoveredItem(null)}
          className="relative w-10 h-10 rounded-lg flex items-center justify-center text-sm text-foreground/70 hover:bg-surface-hover hover:text-foreground transition-all duration-150"
          aria-label="通知"
        >
          <span className="text-base">🔔</span>
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-destructive rounded-full" />
        </button>
        <button
          onMouseEnter={() => setHoveredItem('settings')}
          onMouseLeave={() => setHoveredItem(null)}
          className="relative w-10 h-10 rounded-lg flex items-center justify-center text-sm text-foreground/70 hover:bg-surface-hover hover:text-foreground transition-all duration-150"
          aria-label="设置"
        >
          <span className="text-base">⚙️</span>
        </button>
      </div>
    </div>
  )
}
