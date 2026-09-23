import { useState } from 'react'
import { MarkdownRenderer } from '../message/MarkdownRenderer'

// 辅助对话 tab body (sidePane.selectionChat, ZC-ALIGN-003). A compact chat
// surface riding the same ai:send host bridge as the main Composer — typed
// fail-soft lookup, ok/empty/error branches, abort via ai:abort.

interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
}

interface AiSendResult {
  ok?: boolean
  text?: string
  error?: string
  actualAdapter?: string
  provider?: string
}

let messageSeq = 0

export function SelectionChatPane() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    const api = (window as unknown as {
      __KHYOS__?: {
        aiSend?: (payload: { prompt: string; options?: Record<string, unknown> }) => Promise<AiSendResult>
        aiAbort?: () => Promise<unknown>
      }
    }).__KHYOS__
    if (!api?.aiSend) {
      setMessages((m) => [...m, { id: ++messageSeq, role: 'user', content: text },
        { id: ++messageSeq, role: 'assistant', content: 'preload 未注入：__KHYOS__ 不可用，请重启应用' }])
      setInput('')
      return
    }
    setMessages((m) => [...m, { id: ++messageSeq, role: 'user', content: text }])
    setInput('')
    setSending(true)
    try {
      const result = await api.aiSend({ prompt: text, options: {} })
      let reply: string
      if (result.ok && typeof result.text === 'string' && result.text.length > 0) {
        reply = result.text
      } else if (result.ok && typeof result.text === 'string') {
        // ok + empty text: complete-but-empty (gateway done, nothing to say)
        reply = '（本轮回复为空：通道已正常完成，但模型没有输出内容）'
      } else if (result.ok) {
        reply = '（本轮回复为空：通道已正常完成，但模型没有输出内容）'
      } else {
        const channel = result.actualAdapter || result.provider || '未知通道'
        reply = result.error || `AI 网关调用失败（通道 ${channel}）`
      }
      setMessages((m) => [...m, { id: ++messageSeq, role: 'assistant', content: reply }])
    } catch (err) {
      setMessages((m) => [...m, {
        id: ++messageSeq,
        role: 'assistant',
        content: `AI 请求失败：${String(err)}，请稍后重试`,
      }])
    } finally {
      setSending(false)
    }
  }

  const stop = () => {
    const api = (window as unknown as { __KHYOS__?: { aiAbort?: () => Promise<unknown> } }).__KHYOS__
    void api?.aiAbort?.()
    // UI recovers immediately; the settle reply arrives via the same branch
    setSending(false)
  }

  return (
    <div className="h-full flex flex-col bg-panel">
      {/* 消息列表 */}
      <div className="flex-1 overflow-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-6 animate-fade-in">
            <span className="text-3xl mb-3">💬</span>
            <p className="text-sm text-foreground/50">
              辅助对话与主会话共用同一网关；发送的内容不会进入主对话上下文。
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                {m.role === 'user' ? (
                  <div className="max-w-[85%] rounded-xl bg-brand/10 text-foreground px-3 py-2 text-sm whitespace-pre-wrap break-words">
                    {m.content}
                  </div>
                ) : (
                  <div className="max-w-[85%] rounded-xl bg-card border border-card-border px-3 py-2 text-sm">
                    <MarkdownRenderer content={m.content} />
                  </div>
                )}
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-xl bg-card border border-card-border px-3 py-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse" />
                  <span className="text-xs text-foreground/50">正在等待 KhyOS 网关回复（host 已加载 aiGateway，多通道重试中）…</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="border-t border-border p-2.5 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder="提出后续修改要求"
            rows={2}
            disabled={sending}
            className="flex-1 resize-none bg-input border border-input-border rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-foreground/30 focus:outline-none focus:border-input-border-focused transition-colors disabled:opacity-50"
          />
          {sending ? (
            <button
              onClick={stop}
              className="bg-destructive text-destructive-foreground px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 transition-opacity flex items-center gap-1.5 shrink-0"
            >
              停止
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim()}
              className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity flex items-center gap-1.5 shrink-0"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
