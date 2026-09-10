import { useState, useCallback } from 'react'

export function Composer() {
  const [input, setInput] = useState('')
  const [showMention, setShowMention] = useState(false)

  const handleInput = useCallback((value: string) => {
    setInput(value)
    const lastChar = value.slice(-1)
    setShowMention(lastChar === '@' || lastChar === '#' || lastChar === '$' || lastChar === '/')
  }, [])

  const handleSend = () => {
    if (!input.trim()) return
    console.log('[composer] send:', input)
    setInput('')
  }

  return (
    <div className="border-t border-border bg-panel p-4">
      {showMention && (
        <div className="mb-2 bg-popover border border-popover-border rounded-lg p-2 text-sm text-foreground">
          <div className="text-xs text-foreground/50 mb-1">提及</div>
          <div className="space-y-1">
            <div className="px-2 py-1 rounded hover:bg-surface-hover cursor-pointer">文件</div>
            <div className="px-2 py-1 rounded hover:bg-surface-hover cursor-pointer">会话</div>
            <div className="px-2 py-1 rounded hover:bg-surface-hover cursor-pointer">技能</div>
          </div>
        </div>
      )}

      <textarea
        value={input}
        onChange={e => handleInput(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSend()
          }
        }}
        placeholder="输入消息... (@ 添加上下文, # 插入会话, \$ 选择技能, / 选择能力)"
        className="w-full bg-input border border-input-border rounded-lg p-3 text-foreground resize-none"
        rows={3}
      />

      <div className="flex items-center justify-between mt-2">
        <div className="flex gap-2">
          <button className="text-sm text-foreground/50 hover:text-foreground">📎</button>
        </div>
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="bg-primary text-primary-foreground px-4 py-1.5 rounded-md text-sm disabled:opacity-50"
        >
          发送
        </button>
      </div>
    </div>
  )
}
