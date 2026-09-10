import { useState, useCallback, useRef, useEffect } from 'react'

type MentionType = '@' | '#' | '$' | '/' | null

interface MentionItem {
  id: string
  label: string
  description?: string
  icon?: string
}

const MENTION_CATEGORIES: Record<string, { label: string; icon: string; items: MentionItem[] }> = {
  '@': {
    label: '添加上下文',
    icon: '📎',
    items: [
      { id: 'file', label: '文件', description: '引用工作区文件', icon: '📄' },
      { id: 'folder', label: '文件夹', description: '引用整个目录', icon: '📁' },
    ],
  },
  '#': {
    label: '插入会话',
    icon: '💬',
    items: [
      { id: 'recent1', label: '实现登录功能', description: '2 小时前' },
      { id: 'recent2', label: '修复终端渲染问题', description: '1 天前' },
    ],
  },
  '$': {
    label: '选择技能',
    icon: '⚡',
    items: [
      { id: 'skill1', label: '代码审查', description: '审查代码质量与规范' },
      { id: 'skill2', label: '文档生成', description: '自动生成项目文档' },
      { id: 'skill3', label: '测试编写', description: '生成单元测试' },
    ],
  },
  '/': {
    label: '选择能力',
    icon: '🔧',
    items: [
      { id: 'cmd1', label: '/compact', description: '压缩对话上下文' },
      { id: 'cmd2', label: '/clear', description: '清空当前对话' },
      { id: 'cmd3', label: '/model', description: '切换模型' },
      { id: 'cmd4', label: '/help', description: '查看帮助' },
    ],
  },
}

export function Composer() {
  const [input, setInput] = useState('')
  const [mentionType, setMentionType] = useState<MentionType>(null)
  const [mentionQuery, setMentionQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [attachments, setAttachments] = useState<string[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionRef = useRef<HTMLDivElement>(null)

  const handleInput = useCallback((value: string) => {
    setInput(value)
    const lastChar = value.slice(-1)
    if (['@', '#', '$', '/'].includes(lastChar)) {
      setMentionType(lastChar as MentionType)
      setMentionQuery('')
      setSelectedIndex(0)
    } else if (mentionType) {
      const triggerIndex = value.lastIndexOf(mentionType)
      if (triggerIndex >= 0) {
        const after = value.slice(triggerIndex + 1)
        if (after.includes(' ')) {
          setMentionType(null)
        } else {
          setMentionQuery(after)
        }
      }
    }
  }, [mentionType])

  const filteredItems = mentionType
    ? MENTION_CATEGORIES[mentionType]?.items.filter(item =>
        item.label.toLowerCase().includes(mentionQuery.toLowerCase())
      ) ?? []
    : []

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (mentionType && filteredItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => (i + 1) % filteredItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => (i - 1 + filteredItems.length) % filteredItems.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const item = filteredItems[selectedIndex]
        if (item) {
          const triggerIndex = input.lastIndexOf(mentionType)
          const newValue = input.slice(0, triggerIndex) + mentionType + item.label + ' '
          setInput(newValue)
          setMentionType(null)
        }
        return
      }
      if (e.key === 'Escape') {
        setMentionType(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [mentionType, filteredItems, selectedIndex, input])

  const handleSend = () => {
    if (!input.trim() && attachments.length === 0) return
    console.log('[composer] send:', input, 'attachments:', attachments)
    setInput('')
    setAttachments([])
    setMentionType(null)
  }

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 240) + 'px'
    }
  }, [input])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
        // click outside closes mention
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div className="border-t border-border bg-panel px-4 py-3">
      {/* 提及弹出层 */}
      {mentionType && filteredItems.length > 0 && (
        <div
          ref={mentionRef}
          className="mb-2 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden animate-slide-down"
        >
          <div className="px-3 py-2 border-b border-popover-border">
            <span className="text-xs font-semibold text-popover-header">{MENTION_CATEGORIES[mentionType]?.label}</span>
            <span className="text-xs text-foreground/40 ml-2">↑↓ 选择 · ↵ 确认 · Esc 关闭</span>
          </div>
          <div className="max-h-48 overflow-auto py-1">
            {filteredItems.map((item, index) => (
              <button
                key={item.id}
                onClick={() => {
                  const triggerIndex = input.lastIndexOf(mentionType)
                  const newValue = input.slice(0, triggerIndex) + mentionType + item.label + ' '
                  setInput(newValue)
                  setMentionType(null)
                }}
                className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors ${
                  index === selectedIndex ? 'bg-selected' : 'hover:bg-surface-hover'
                }`}
              >
                {item.icon && <span className="text-base">{item.icon}</span>}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-popover-foreground">{item.label}</div>
                  {item.description && (
                    <div className="text-xs text-foreground/50 mt-0.5">{item.description}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 附件预览 */}
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((file, i) => (
            <div key={i} className="flex items-center gap-2 bg-card border border-card-border rounded-lg px-3 py-2 text-sm">
              <span>📎</span>
              <span className="text-foreground">{file}</span>
              <button
                onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))}
                className="text-foreground/50 hover:text-destructive text-xs ml-1 font-bold"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 输入框区域 — 加高加大 */}
      <div className="rounded-xl border border-input-border bg-input focus-within:border-input-border-focused transition-colors">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... 使用 @ 添加上下文, # 插入会话, $ 选择技能, / 选择能力"
          className="w-full bg-transparent px-4 pt-3.5 text-foreground placeholder:text-foreground/35 resize-none focus:outline-none text-sm leading-relaxed"
          style={{ minHeight: '80px', maxHeight: '240px' }}
          rows={3}
        />

        {/* 底部工具栏 — 始终可见 */}
        <div className="flex items-center justify-between px-3 pb-2.5 pt-1.5 border-t border-border/50">
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setAttachments(prev => [...prev, `file_${prev.length + 1}.tsx`])}
              className="p-2 rounded-lg text-foreground/50 hover:text-foreground hover:bg-surface-hover transition-colors"
              title="添加附件"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M9 4v10M4 9h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="p-2 rounded-lg text-foreground/50 hover:text-foreground hover:bg-surface-hover transition-colors"
              title="语音输入"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="7" y="3" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M4 8a5 5 0 0010 0M9 13v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button
              className="p-2 rounded-lg text-foreground/50 hover:text-foreground hover:bg-surface-hover transition-colors"
              title="上传图片"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="2.5" y="3.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="6" cy="7" r="1.5" fill="currentColor" />
                <path d="M2.5 12.5l3.5-3 2.5 2.5 4.5-4 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="w-px h-5 bg-border mx-1" />
            <span className="text-xs text-foreground/40 px-2">
              @ 上下文 · # 会话 · $ 技能 · / 命令
            </span>
          </div>

          <div className="flex items-center gap-3">
            {input.length > 0 && (
              <span className="text-xs text-foreground/40 tabular-nums">{input.length} 字</span>
            )}
            <button
              onClick={handleSend}
              disabled={!input.trim() && attachments.length === 0}
              className="bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity flex items-center gap-2"
            >
              <span>发送</span>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 7h10M7 2l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
