import { useState } from 'react'
import type { ReactNode } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ChatEmptyState } from '../ui/EmptyState'
import { useAppSelector } from '../../state/store'
import type { Message as StoreMessage } from '../../state/messageSlice'

interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error'
  result?: string
}

interface TrajectoryStep {
  type: 'user' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result'
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  timestamp: number
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  trajectory?: TrajectoryStep[]
  toolCalls?: ToolCall[]
  isStreaming?: boolean
}

function TrajectoryTimeline({ steps }: { steps: TrajectoryStep[] }) {
  const [expanded, setExpanded] = useState(false)
  const [selectedStep, setSelectedStep] = useState<number | null>(null)

  const typeConfig = {
    user: { color: 'var(--color-trajectory-user)', label: '用户', icon: '👤' },
    assistant: { color: 'var(--color-trajectory-assistant)', label: '助手', icon: '🤖' },
    reasoning: { color: 'var(--color-trajectory-reasoning)', label: '思考', icon: '💭' },
    'tool-call': { color: 'var(--color-trajectory-tool-call)', label: '工具调用', icon: '🔧' },
    'tool-result': { color: 'var(--color-trajectory-tool-result)', label: '工具结果', icon: '📋' },
  }

  return (
    <div className="mb-3 bg-surface rounded-xl border border-border overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover transition-colors"
      >
        <span className={`transition-transform duration-200 text-xs ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span className="font-medium">思考轨迹</span>
        <span className="text-foreground/30 mx-1">·</span>
        <span className="text-xs text-foreground/50">{steps.length} 步</span>
        <span className="text-xs text-foreground/30 ml-auto">{expanded ? '收起' : '展开'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-1 animate-slide-down">
          {steps.map((step, index) => {
            const config = typeConfig[step.type]
            return (
              <div
                key={index}
                onClick={() => setSelectedStep(selectedStep === index ? null : index)}
                className={`flex items-start gap-2.5 p-2.5 rounded-lg cursor-pointer transition-colors ${
                  selectedStep === index ? 'bg-surface-hover' : 'hover:bg-surface-hover/50'
                }`}
              >
                <div
                  className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0"
                  style={{ backgroundColor: config.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold" style={{ color: config.color }}>
                      {config.label}
                    </span>
                    <span className="text-xs text-foreground/40">
                      {new Date(step.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="text-sm text-foreground/80 mt-1 leading-relaxed">
                    {step.content}
                  </div>
                  {selectedStep === index && step.toolName && (
                    <div className="mt-2 p-3 bg-card rounded-lg border border-card-border text-xs font-mono text-foreground/60 animate-fade-in">
                      <div className="text-foreground/50 mb-1 font-sans font-medium">Tool: {step.toolName}</div>
                      {step.toolInput && (
                        <pre className="whitespace-pre-wrap break-all leading-relaxed">
                          {JSON.stringify(step.toolInput, null, 2)}
                        </pre>
                      )}
                      {step.toolResult && (
                        <div className="mt-2 pt-2 border-t border-card-border">
                          <div className="text-foreground/50 mb-1 font-sans font-medium">Result:</div>
                          <pre className="whitespace-pre-wrap break-all leading-relaxed">{step.toolResult}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false)

  const statusConfig = {
    pending: { color: 'text-foreground/50', bg: 'bg-foreground/20', label: '等待中', icon: '⏳' },
    running: { color: 'text-warning', bg: 'bg-warning/20', label: '运行中', icon: '⚡' },
    success: { color: 'text-success', bg: 'bg-success/20', label: '完成', icon: '✅' },
    error: { color: 'text-destructive', bg: 'bg-destructive/20', label: '失败', icon: '❌' },
  }

  const status = statusConfig[tool.status]

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-surface-hover transition-colors"
      >
        <span className={`w-2.5 h-2.5 rounded-full ${status.bg} ${status.color} ${tool.status === 'running' ? 'animate-pulse' : ''}`} />
        <span className="font-medium text-foreground flex-1 text-left">{tool.name}</span>
        <span className={`text-xs font-medium ${status.color}`}>{status.label}</span>
        <span className={`text-foreground/40 text-xs transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 animate-slide-down">
          <div className="text-xs font-mono text-foreground/60 bg-input rounded-lg p-3 mb-2 max-h-32 overflow-auto">
            <pre className="whitespace-pre-wrap break-all leading-relaxed">{JSON.stringify(tool.input, null, 2)}</pre>
          </div>
          {tool.result && (
            <div className="text-xs font-mono text-foreground/70 bg-input rounded-lg p-3 max-h-32 overflow-auto">
              <pre className="whitespace-pre-wrap break-all leading-relaxed">{tool.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function MessageBubble({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(true)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const isUser = message.role === 'user'

  return (
    <div className={`group px-5 py-4 ${isUser ? 'bg-surface/30' : ''} border-b border-border/30 animate-fade-in`}>
      {/* 头部 — 始终可见 */}
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
          isUser ? 'bg-trajectory-user/20 text-trajectory-user' : 'bg-trajectory-assistant/20 text-trajectory-assistant'
        }`}>
          {isUser ? '你' : 'AI'}
        </div>
        <span className="text-sm font-semibold text-foreground">
          {isUser ? '你' : '助手'}
        </span>
        <span className="text-xs text-foreground/40">
          {new Date(message.timestamp).toLocaleTimeString()}
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-2.5 py-1 rounded-md text-xs text-foreground/50 hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            {expanded ? '收起' : '展开'}
          </button>
          <button
            onClick={handleCopy}
            className="px-2.5 py-1 rounded-md text-xs text-foreground/50 hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            {copied ? '✓ 已复制' : '复制'}
          </button>
        </div>
      </div>

      {/* 思考轨迹 */}
      {message.trajectory && message.trajectory.length > 0 && (
        <TrajectoryTimeline steps={message.trajectory} />
      )}

      {/* 工具调用 */}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mb-3 space-y-1">
          {message.toolCalls.map(tool => (
            <ToolCallCard key={tool.id} tool={tool} />
          ))}
        </div>
      )}

      {/* 消息内容 — 使用 Markdown 渲染 */}
      {expanded && (
        <div className="text-sm text-foreground pl-10">
          <MarkdownRenderer content={message.content} isStreaming={message.isStreaming} />
        </div>
      )}
    </div>
  )
}

export function MessageList({ onQuickAction, composer }: {
  onQuickAction?: (prompt: string) => void
  // 空态首页把居中悬浮 composer 卡片嵌入问候语下方（ZC-ALIGN-005 E3）；
  // 非空态走底部固定 composer，此时传 undefined。
  composer?: ReactNode
}) {
  // Live messages from Redux — Composer dispatches addMessage / updateMessage,
  // App.tsx feeds host ai:chunk streams via appendMessageContent. The previous
  // static quicksort demo violated "state transparency" (fake chat content).
  const messages = useAppSelector((s: { message: { messages: StoreMessage[] } }) => s.message.messages)
  const empty = messages.length === 0

  if (empty) {
    // 空态 = ZCode 新任务首页（问候 + 快捷卡片，ZC-ALIGN-002 E1），
    // 卡片动作经 onQuickAction 填入 composer（App 层持有 prefill 状态）。
    return <ChatEmptyState onQuickAction={onQuickAction} composer={composer} />
  }

  return (
    <div className="flex-1 overflow-auto">
      {messages.map(msg => (
        <MessageBubble
          key={msg.id}
          message={{
            id: msg.id,
            role: msg.role === 'system' ? 'assistant' : msg.role,
            content: msg.content,
            timestamp: msg.timestamp,
            isStreaming: msg.status === 'streaming' || msg.status === 'sending',
            error: msg.error,
          } as Message}
        />
      ))}
    </div>
  )
}
