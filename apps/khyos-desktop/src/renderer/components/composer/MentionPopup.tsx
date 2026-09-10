import { useState, useEffect, useRef } from 'react'

interface MentionItem {
  id: string
  label: string
  description?: string
  icon?: string
}

interface MentionCategory {
  id: string
  title: string
  emptyText: string
  searchPlaceholder: string
  items: MentionItem[]
}

const CATEGORIES: MentionCategory[] = [
  {
    id: 'files',
    title: '文件',
    emptyText: '没有匹配的文件',
    searchPlaceholder: '输入内容以搜索文件',
    items: [
      { id: 'f1', label: 'quicksort.ts', description: 'src/sort/', icon: '🔷' },
      { id: 'f2', label: 'quicksort.test.ts', description: 'src/sort/', icon: '🔷' },
      { id: 'f3', label: 'App.tsx', description: 'src/renderer/', icon: '🔷' },
      { id: 'f4', label: 'globals.css', description: 'src/renderer/theme/', icon: '🎨' },
    ],
  },
  {
    id: 'sessions',
    title: '会话',
    emptyText: '没有匹配的近期会话',
    searchPlaceholder: '输入内容以搜索近期会话',
    items: [
      { id: 's1', label: '实现登录功能', description: '2 小时前' },
      { id: 's2', label: '修复终端渲染问题', description: '1 天前' },
      { id: 's3', label: '添加单元测试', description: '3 天前' },
    ],
  },
  {
    id: 'skills',
    title: '技能',
    emptyText: '没有匹配的技能',
    searchPlaceholder: '输入内容以搜索技能',
    items: [
      { id: 'sk1', label: '代码审查', description: '审查代码质量与规范', icon: '🔍' },
      { id: 'sk2', label: '文档生成', description: '自动生成项目文档', icon: '📝' },
      { id: 'sk3', label: '测试编写', description: '生成单元测试', icon: '🧪' },
    ],
  },
  {
    id: 'subagents',
    title: '子智能体',
    emptyText: '没有匹配的子智能体',
    searchPlaceholder: '',
    items: [
      { id: 'sa1', label: 'Explorer', description: '探索代码库结构', icon: '🔭' },
      { id: 'sa2', label: 'Debugger', description: '定位并修复问题', icon: '🐛' },
    ],
  },
  {
    id: 'plugins',
    title: '插件',
    emptyText: '没有可引用的插件',
    searchPlaceholder: '',
    items: [
      { id: 'p1', label: '文档技能', description: 'KhyOS · 5 技能 · 2 MCP', icon: '📦' },
      { id: 'p2', label: 'Github', description: 'KhyOS · 3 技能 · 1 MCP', icon: '🐙' },
    ],
  },
  {
    id: 'whiteboards',
    title: '画板',
    emptyText: '没有匹配的画板',
    searchPlaceholder: '',
    items: [
      { id: 'w1', label: '架构设计', description: '12 条笔迹', icon: '🎨' },
    ],
  },
]

interface MentionPopupProps {
  type: '@' | '#' | '$' | '/' | null
  query: string
  onSelect: (item: MentionItem, category: string) => void
  onClose: () => void
}

export function MentionPopup({ type, query, onSelect, onClose }: MentionPopupProps) {
  const [activeCategory, setActiveCategory] = useState(0)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  // 根据触发类型选择显示的类别
  const visibleCategories = type === '@' ? CATEGORIES : 
                           type === '#' ? CATEGORIES.filter(c => c.id === 'sessions') :
                           type === '$' ? CATEGORIES.filter(c => c.id === 'skills') :
                           CATEGORIES.filter(c => c.id === 'skills')

  const currentCategory = visibleCategories[activeCategory]
  const filteredItems = currentCategory?.items.filter(item =>
    item.label.toLowerCase().includes(query.toLowerCase())
  ) ?? []

  useEffect(() => {
    setSelectedIndex(0)
  }, [activeCategory, query])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, filteredItems.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
      } else if (e.key === 'ArrowRight' && visibleCategories.length > 1) {
        e.preventDefault()
        setActiveCategory(i => (i + 1) % visibleCategories.length)
      } else if (e.key === 'ArrowLeft' && visibleCategories.length > 1) {
        e.preventDefault()
        setActiveCategory(i => (i - 1 + visibleCategories.length) % visibleCategories.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        if (filteredItems[selectedIndex]) {
          onSelect(filteredItems[selectedIndex], currentCategory.id)
        }
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [filteredItems, selectedIndex, currentCategory, onSelect, onClose, visibleCategories.length])

  if (!type || visibleCategories.length === 0) return null

  return (
    <div ref={containerRef} className="mb-3 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden animate-slide-down">
      {/* 类别标签 */}
      {visibleCategories.length > 1 && (
        <div className="flex border-b border-popover-border px-2 pt-1.5 gap-0.5">
          {visibleCategories.map((cat, i) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(i)}
              className={`px-3 py-1.5 rounded-t-lg text-xs font-medium transition-colors ${
                i === activeCategory
                  ? 'bg-selected text-brand'
                  : 'text-foreground/50 hover:text-foreground hover:bg-surface-hover'
              }`}
            >
              {cat.title}
            </button>
          ))}
        </div>
      )}

      {/* 搜索提示 */}
      {currentCategory?.searchPlaceholder && (
        <div className="px-3 py-2 border-b border-popover-border">
          <span className="text-xs text-foreground/40">{currentCategory.searchPlaceholder}</span>
        </div>
      )}

      {/* 项目列表 */}
      <div className="max-h-56 overflow-auto py-1">
        {filteredItems.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-foreground/40">
            {currentCategory?.emptyText}
          </div>
        ) : (
          filteredItems.map((item, index) => (
            <button
              key={item.id}
              onClick={() => onSelect(item, currentCategory.id)}
              className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors ${
                index === selectedIndex ? 'bg-selected' : 'hover:bg-surface-hover'
              }`}
            >
              {item.icon && <span className="text-base flex-shrink-0">{item.icon}</span>}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-popover-foreground truncate">{item.label}</div>
                {item.description && (
                  <div className="text-xs text-foreground/40 truncate">{item.description}</div>
                )}
              </div>
            </button>
          ))
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-3 py-2 border-t border-popover-border flex items-center justify-between text-xs text-foreground/30">
        <span>↑↓ 选择 · ↔ 切换分类 · ↵ 确认</span>
        <span>Esc 关闭</span>
      </div>
    </div>
  )
}
