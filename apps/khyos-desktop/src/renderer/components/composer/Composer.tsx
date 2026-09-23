import { useState, useCallback, useRef, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useAppDispatch } from '../../state/store'
import { store } from '../../state/store'
import { addMessage, updateMessage, setMessageStatus, setStreaming, setAgentWorking } from '../../state/messageSlice'
import { clearExecutions } from '../../state/toolExecutionSlice'
import { addToast } from '../../state/toastSlice'
import { useModelCatalog, groupByProvider, getModelOptionLabel, type ModelOption } from '../../utils/useModelCatalog'
import { ModeSelector, DEFAULT_AGENT_MODE } from './ModeSelector'

type MentionType = '@' | '#' | '$' | '/' | null

// 推理强度档位 — 对齐 i18n chat.toolbar.thoughtLevel.value.* 真源
const THOUGHT_LEVELS: { id: string; label: string }[] = [
  { id: 'off', label: '不思考' },
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' },
]

// 「添加上下文」按钮 — 对齐 ZCode G0 实测（s-22）的四项菜单：
// 添加附件 / 使用 @ 添加上下文 / 使用 / 选择能力 / 使用 $ 选择技能。
// 附件走真实文件选择对话框（fs:selectFiles），不再自造 file_N.tsx 假名；
// @ / $ 三项把触发字符插进输入框并拉起对应的提及面板。
function AddContextButton({
  onAttach,
  onInsertTrigger,
}: {
  onAttach: (kind: 'file' | 'image') => void
  onInsertTrigger: (trigger: '@' | '$' | '/') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const items: { id: string; label: string; run: () => void }[] = [
    { id: 'attach', label: '添加附件', run: () => onAttach('file') },
    { id: 'image', label: '上传图片', run: () => onAttach('image') },
    { id: 'at', label: '使用 @ 添加上下文', run: () => onInsertTrigger('@') },
    { id: 'slash', label: '使用 / 选择能力', run: () => onInsertTrigger('/') },
    { id: 'dollar', label: '使用 $ 选择技能', run: () => onInsertTrigger('$') },
  ]

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className="p-2 rounded-lg text-foreground/50 hover:text-foreground hover:bg-surface-hover transition-colors"
        title="添加上下文"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path d="M9 4v10M4 9h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full mb-2 left-0 w-52 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden z-50"
        >
          <div className="px-3 py-2 text-xs font-semibold text-popover-header border-b border-popover-border">
            添加上下文
          </div>
          {items.map((it) => (
            <button
              key={it.id}
              role="menuitem"
              onClick={() => { setOpen(false); it.run() }}
              className="w-full text-left px-3 py-2 text-sm text-popover-foreground hover:bg-surface-hover transition-colors"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// 「上下文已用 X / 总量 Y」按钮 + 用量弹窗 — 对齐 ZCode 实测 a57 的 pressable
// 统计按钮与 G0d 的上下文容量弹窗。数字来自 host 的 estimateTokens 真源启发式
// （tokenUsageService）。ZCode 弹窗里的「分类明细（消息/MCP 工具/系统提示词…）
// + 缓存命中率」需要后端分类统计，本端只有总量估算 —— 弹窗如实说明这一点，
// 不给造出来的百分比。
function ContextUsageButton({ used, total, error }: { used: number; total: number; error: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const pct = total > 0 ? (used / total) * 100 : 0
  const pctLabel = pct >= 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(1)}%`

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-2 py-1 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors tabular-nums whitespace-nowrap"
        title={error || `当前会话上下文已用 ${used.toLocaleString()} tokens`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        上下文已用 {used.toLocaleString()} / 总量 {total.toLocaleString()}
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 right-0 w-72 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2 text-xs font-semibold text-popover-header border-b border-popover-border">
            上下文容量
          </div>
          <div className="px-3 py-2.5">
            <div className="flex items-baseline justify-between text-sm text-popover-foreground">
              <span className="tabular-nums">{pctLabel}</span>
              <span className="text-xs text-foreground/50 tabular-nums">
                {used.toLocaleString()} / {total.toLocaleString()} tokens
              </span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-input overflow-hidden">
              <div
                className={`h-full rounded-full ${pct > 90 ? 'bg-destructive' : 'bg-brand'}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            {error ? (
              <p className="mt-2 text-xs text-destructive">{error}</p>
            ) : (
              <p className="mt-2 text-xs text-foreground/40 leading-relaxed">
                分类明细（消息 / 工具 / 系统提示词）与缓存命中率需后端分类统计，当前未接线，因此只显示总量估算。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// 「打开运行中的后台任务」按钮（P3-6①）— 对齐 ZCode i18n
// chat.composer.backgroundWorks.ariaLabel「Bash {n} 个，子智能体 {n} 个，
// 共 {n} 个」；count=0 时隐藏（ZCode 实测空态无此按钮）。数据经
// host → background.status（在途 ai.generate 集合，含自动化运行）。
// 点击展开面板列出在途任务 id（host 真值）；bash/subagent 计数事件流仍待接，
// 面板里如实标注恒 0，不给假数。
function BackgroundTasksButton() {
  const [count, setCount] = useState(0)
  const [bashCount, setBashCount] = useState(0)
  const [subagentCount, setSubagentCount] = useState(0)
  const [taskIds, setTaskIds] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    const api = (window as unknown as {
      __KHYOS__?: {
        backgroundStatus?: () => Promise<{
          ok: boolean
          status?: { count: number; bash: number; subagents: number; taskIds?: string[] }
          error?: string
        }>
      }
    }).__KHYOS__
    if (!api?.backgroundStatus) return
    api.backgroundStatus().then((res) => {
      if (res?.ok && res.status) {
        setCount(res.status.count)
        setBashCount(res.status.bash)
        setSubagentCount(res.status.subagents)
        setTaskIds(res.status.taskIds || [])
      }
    }).catch(() => {
      /* fail-soft：host 不可用时按钮保持隐藏 */
    })
  }, [])

  // 3s 轮询（纯 UI 计数刷新，非任务截止——规则 3 合规）
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (count === 0) return null
  const label = `Bash ${bashCount} 个，子智能体 ${subagentCount} 个，共 ${count} 个`
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-2 py-1 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5 whitespace-nowrap"
        title={`打开运行中的后台任务：${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M4.5 4.5l3.5 2.5-3.5 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="1.5" y="1.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <span>{label}</span>
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 right-0 w-72 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden z-50">
          <div className="px-3 py-2 text-xs font-semibold text-popover-header border-b border-popover-border">
            运行中的后台任务
          </div>
          <div className="max-h-56 overflow-auto py-1">
            {taskIds.length === 0 ? (
              <div className="px-3 py-2 text-xs text-foreground/40">没有在途任务。</div>
            ) : (
              taskIds.map((id) => (
                <div key={id} className="px-3 py-1.5 text-xs text-popover-foreground font-mono truncate" title={id}>
                  {id.startsWith('auto_') ? `定时任务运行 ${id}` : `AI 生成 ${id}`}
                </div>
              ))
            )}
          </div>
          <div className="px-3 py-2 border-t border-popover-border text-xs text-foreground/40 leading-relaxed">
            Bash 子进程与子智能体计数需后端执行事件流（bash.start/stop），当前恒 0 —— 不计为已连接。
          </div>
        </div>
      )}
    </div>
  )
}

// 模型选择器 — 数据源为 useModelCatalog（provider 静态 presets + 选中
// provider 的 adapter.listModels 动态叠加，P3-7/P3-7③），对齐 ZCode「选择
// 模型」combobox（provider 一级 + 模型二级）。App.tsx 顶层调用
// useModelCatalog(selectedChannel) 驱动动态拉取，本组件共享同一模块级
// 缓存直接渲染。
function ModelSelector({ current, onChange, options }: { current: string; onChange: (id: string) => void; options: ModelOption[] }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const groups = groupByProvider(options)
  const currentOption = options.find((o) => o.id === current)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen(!open); setQuery('') }}
        className="px-2 py-1 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1 max-w-[180px]"
        title="选择模型"
      >
        <span className="truncate">{currentOption?.label ?? (current || '选择模型')}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M1.5 3l2.5 2.5L6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 right-0 w-72 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden animate-slide-down z-50">
          <div className="px-3 py-2 border-b border-popover-border">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索模型…"
              className="w-full bg-input border border-input-border rounded-lg px-2 py-1.5 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none"
            />
          </div>
          {options.length === 0 && (
            <div className="px-3 py-3 text-xs text-foreground/40">加载模型列表…</div>
          )}
          <div className="max-h-64 overflow-auto py-1">
            {groups.map((g) => {
              const q = query.toLowerCase()
              const visibleModels = g.models.filter((m) => m.label.toLowerCase().includes(q) || g.provider.label.toLowerCase().includes(q))
              if (q && g.provider.label.toLowerCase().includes(q) && visibleModels.length === 0 && g.provider.id !== current) return null
              if (q && g.provider.label.toLowerCase().includes(q) && visibleModels.length === 0) {
                return (
                  <div key={g.provider.id}>
                    <button
                      onClick={() => { onChange(g.provider.id); setOpen(false) }}
                      className="w-full text-left px-3 py-2 text-sm text-popover-foreground hover:bg-surface-hover transition-colors"
                    >
                      {g.provider.label}
                    </button>
                  </div>
                )
              }
              return (
                <div key={g.provider.id}>
                  <button
                    onClick={() => { onChange(g.provider.id); setOpen(false) }}
                    className={`w-full text-left px-3 py-1.5 text-xs font-semibold text-foreground/50 hover:bg-surface-hover transition-colors ${
                      current === g.provider.id ? 'text-brand' : ''
                    }`}
                  >
                    {g.provider.label}
                  </button>
                  {visibleModels.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => { onChange(m.id); setOpen(false) }}
                      className={`w-full text-left px-5 py-1.5 text-sm text-popover-foreground hover:bg-surface-hover transition-colors ${
                        current === m.id ? 'bg-selected text-foreground' : ''
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// 推理强度按钮（对齐 i18n chat.toolbar.thoughtLevel.*，Ctrl+T 循环切换）
function ThoughtLevelButton({ level, onChange }: { level: string; onChange: (l: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = THOUGHT_LEVELS.find((l) => l.id === level) ?? THOUGHT_LEVELS[0]

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="px-2 py-1 rounded-md text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1"
        title="推理强度 (Ctrl+T)"
      >
        <span>{current.label}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M1.5 3l2.5 2.5L6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-2 right-0 w-36 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden animate-slide-down z-50">
          {THOUGHT_LEVELS.map((l) => (
            <button
              key={l.id}
              onClick={() => { onChange(l.id); setOpen(false) }}
              className={`w-full text-left px-3 py-2 text-sm hover:bg-surface-hover transition-colors ${
                level === l.id ? 'bg-selected text-foreground' : 'text-popover-foreground'
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface MentionItem {
  id: string
  label: string
  description?: string
  icon?: string
}

// 提及分类的静态框架（ZCode chat.mention.category 六分类中的四项；画板/插件
// 入口尚未实现）。条目本身不再写死 mock —— 会话来自 host session.list（真实
// .khy/sessions）、技能/命令来自 agentItemStore（agent:list），在 Composer 内
// 按需拉取。拉不到就显示空态提示，不拿假数据充数（P3-1/P3-4 同类问题）。
const MENTION_META: Record<string, { label: string; icon: string }> = {
  '@': { label: '添加上下文', icon: '📎' },
  '#': { label: '插入会话', icon: '💬' },
  '$': { label: '选择技能', icon: '⚡' },
  '/': { label: '选择能力', icon: '🔧' },
}

export function Composer({
  modelName,
  prefillText,
  onPrefillConsumed,
  header,
  variant = 'bottom',
  thoughtLevel = 'max',
  onThoughtLevelChange,
  onModelChange,
  agentMode = DEFAULT_AGENT_MODE,
  onModeChange,
}: {
  // 当前选中模型的展示名（App 用 getModelOptionLabel 解析后传入）。此前这个 prop
  // 被解构并使用，却没写进类型里 —— App.tsx 传它时一直是类型错误。
  modelName?: string
  prefillText?: string
  onPrefillConsumed?: () => void
  // 卡片顶端的可选槽位（[DESIGN-ARCH-125] P-01）：空态首页传入工作空间选择行；
  // 日常会话不传。Composer 不关心槽位里是什么，只负责版式位置与分隔线。
  header?: ReactNode
  // 'bottom' = 钉在页面底部的会话输入条（有消息时）；
  // 'card'   = 居中悬浮输入卡片（空态首页，ZC-ALIGN-005 E3）。
  variant?: 'bottom' | 'card'
  // P3-8：推理强度 / 模型 选择器 props（与 ZCode Composer 右下角整簇对齐）
  thoughtLevel?: string
  onThoughtLevelChange?: (level: string) => void
  onModelChange?: (modelId: string) => void
  // 模式选择器（ZCode G0b「切换模式」combobox）
  agentMode?: string
  onModeChange?: (mode: string) => void
}) {
  const [input, setInput] = useState('')
  const [mentionType, setMentionType] = useState<MentionType>(null)
  const [mentionQuery, setMentionQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [attachments, setAttachments] = useState<string[]>([])
  const [sending, setSending] = useState(false)
  // 提及条目按触发字符懒加载（真实数据源，见 loadMentionItems）
  const [mentionItems, setMentionItems] = useState<Record<string, MentionItem[]>>({})
  // 上下文窗口估算（P3-5/P3-6：对齐 ZCode「上下文已用 X / 总量 Y」按钮，
  // 数据经 host → tokenUsageService.estimateTokens 真源启发式，非自造）
  const [ctxUsed, setCtxUsed] = useState(0)
  const [ctxTotal, setCtxTotal] = useState(0)
  const [ctxError, setCtxError] = useState('')
  // P3-7③：模型选项表（provider 静态 presets + 选中 provider 的
  // adapter.listModels 动态叠加，经模块级缓存共享）——handleSend 用它把
  // 选中 provider 的 channel 钉进 options.preferredAdapter。
  const catalog = useModelCatalog()
  const catalogOptions = catalog.options
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionRef = useRef<HTMLDivElement>(null)
  const dispatch = useAppDispatch()

  // 估算当前会话上下文 token 数：汇总消息流文本 + 当前输入，经 host 真源启发式
  const refreshContextEstimate = useCallback((currentInput: string) => {
    const api = (window as unknown as {
      __KHYOS__?: { estimateContextSize?: (text?: string) => Promise<{ ok: boolean; estimate?: { used: number; total: number }; error?: string }> }
    }).__KHYOS__
    if (!api?.estimateContextSize) {
      setCtxError('上下文估算不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    const { messages } = store.getState().message
    const text = [...messages.map((m) => m.content), currentInput].join('\n').slice(0, 400_000)
    api.estimateContextSize(text).then((res) => {
      if (res?.ok && res.estimate) {
        setCtxUsed(res.estimate.used)
        setCtxTotal(res.estimate.total)
        setCtxError('')
      } else {
        setCtxError(res?.error || '上下文估算失败：host 进程无响应，请重启应用')
      }
    }).catch(() => {
      setCtxError('上下文估算失败：host 进程无响应，请重启应用')
    })
  }, [])

  // 会话内容或输入变化时刷新估算（输入侧 300ms 防抖，避免逐字符打 host）
  useEffect(() => {
    const t = setTimeout(() => refreshContextEstimate(input), 300)
    return () => clearTimeout(t)
  }, [input, refreshContextEstimate])

  // 消息流追加（ai:chunk 经 appendMessageContent 更新 store）时同步刷新
  useEffect(() => {
    return store.subscribe(() => {
      const { isStreaming } = store.getState().message
      if (isStreaming) refreshContextEstimate('')
    })
  }, [refreshContextEstimate])

  // 「添加上下文」菜单 → 添加附件 / 上传图片：走真实文件选择对话框
  // （fs:selectFiles），加入的是用户挑中的真实路径；取消则不动。
  const handleAttach = useCallback((kind: 'file' | 'image') => {
    const api = (window as unknown as {
      __KHYOS__?: { selectFiles?: (filters?: { name: string; extensions: string[] }[]) => Promise<string[]> }
    }).__KHYOS__
    if (!api?.selectFiles) {
      dispatch(addToast({ type: 'error', title: '附件选择不可用：preload 未注入 __KHYOS__，请重启应用' }))
      return
    }
    const filters = kind === 'image'
      ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
      : [{ name: '文本与代码', extensions: ['md', 'txt', 'json', 'js', 'jsx', 'ts', 'tsx', 'vue', 'css', 'html', 'yml', 'yaml', 'py', 'sh', 'ps1', 'bat', 'log'] }]
    void api.selectFiles(filters).then((paths) => {
      if (!paths || paths.length === 0) return
      setAttachments((prev) => [...prev, ...paths.filter((p) => !prev.includes(p))])
    }).catch((err: unknown) => {
      dispatch(addToast({ type: 'error', title: `选择文件失败：${String(err)}，请重试` }))
    })
  }, [dispatch])

  // 把 @ / $ / / 触发字符插入光标处并拉起对应提及面板（添加上下文菜单的三个入口）
  const handleInsertTrigger = useCallback((trigger: '@' | '$' | '/') => {
    const t = textareaRef.current
    const s = t?.selectionStart ?? input.length
    const e = t?.selectionEnd ?? s
    setInput(input.slice(0, s) + trigger + input.slice(e))
    requestAnimationFrame(() => {
      t?.focus()
      t?.setSelectionRange(s + 1, s + 1)
    })
    setMentionType(trigger)
    setMentionQuery('')
    setSelectedIndex(0)
  }, [input])

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
    ? (mentionItems[mentionType] ?? []).filter(item =>
        item.label.toLowerCase().includes(mentionQuery.toLowerCase())
      )
    : []

  // 提及条目的真实数据源：'#' 会话（host session.list）/'$' 技能、'/' 命令
  // （agentItemStore）。首次打开该分类时拉取，失败置空并记错误（不造数据）。
  const loadMentionItems = useCallback((trigger: MentionType) => {
    if (!trigger || mentionItems[trigger]) return
    const api = (window as unknown as {
      __KHYOS__?: {
        listSessions?: (limit?: number) => Promise<{ ok: boolean; sessions?: { sessionId: string; title: string; firstUserMessage?: string; updatedAt: number }[] }>
        agentList?: (kind: string) => Promise<{ ok: boolean; items?: { id: string; name: string; description?: string }[] }>
      }
    }).__KHYOS__
    const setItems = (items: MentionItem[]) => setMentionItems((prev) => ({ ...prev, [trigger]: items }))
    if (trigger === '#') {
      void api?.listSessions?.(20).then((res) => {
        setItems((res?.sessions || []).map((s) => ({
          id: `sess:${s.sessionId}`,
          label: s.title === '(untitled)' && s.firstUserMessage ? s.firstUserMessage.slice(0, 30) : (s.title || s.sessionId.slice(0, 12)),
          description: new Date(s.updatedAt).toLocaleString(),
        })))
      }).catch(() => setItems([]))
      return
    }
    if (trigger === '$' || trigger === '/') {
      const kind = trigger === '$' ? 'skill' : 'command'
      void api?.agentList?.(kind).then((res) => {
        setItems((res?.items || []).map((it) => ({
          id: `${kind}:${it.id}`,
          label: it.name,
          description: it.description || (kind === 'skill' ? '技能' : '命令'),
        })))
      }).catch(() => setItems([]))
      return
    }
    // '@'：工作区文件（workspace 文件索引，有界）
    const wapi = (window as unknown as { __KHYOS__?: { workspaceListFiles?: (q?: string) => Promise<{ ok: boolean; files?: { path: string; name: string }[] }> } }).__KHYOS__
    void wapi?.workspaceListFiles?.('').then((res) => {
      setItems((res?.files || []).slice(0, 200).map((f) => ({
        id: `file:${f.path}`,
        label: f.name,
        description: f.path,
      })))
    }).catch(() => setItems([]))
  }, [mentionItems])

  useEffect(() => {
    loadMentionItems(mentionType)
  }, [mentionType, loadMentionItems])

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
    if (sending) return
    const text = input.trim()
    if (!text && attachments.length === 0) return

    const userMsg = {
      id: `u_${Date.now()}`,
      role: 'user' as const,
      content: text,
      timestamp: Date.now(),
      status: 'complete' as const,
    }
    dispatch(clearExecutions())
    dispatch(addMessage(userMsg))
    const assistantId = `a_${Date.now()}`
    dispatch(addMessage({ id: assistantId, role: 'assistant', content: '', timestamp: Date.now(), status: 'streaming' }))
    dispatch(setStreaming(true))
    dispatch(setAgentWorking(true))
    setSending(true)
    setInput('')
    setAttachments([])
    setMentionType(null)

    // CH-2: renderer → main IPC → host fork → KhyOS 后端 agent 工具循环。
    // 返回字段与 host 的 ai.result 对齐：empty 只在「既无正文也无工具执行」时为真，
    // 纯工具轮次（模型只用工具回答）不算空回复。
    const api = (window as unknown as {
      __KHYOS__?: {
        aiSend: (p: unknown) => Promise<{
          ok: boolean
          text?: string
          empty?: boolean
          error?: string
          provider?: string
          actualAdapter?: string
          fallbackReason?: string
          errorType?: string
          toolCallCount?: number
        }>
      }
    }).__KHYOS__
    if (!api?.aiSend) {
      dispatch(updateMessage({ id: assistantId, updates: { content: '', status: 'error', error: 'preload 未注入：__KHYOS__ 不可用，请重启应用' } }))
      dispatch(setStreaming(false))
      dispatch(setAgentWorking(false))
      setSending(false)
      return
    }
// P3-7：把当前选中的 provider 透传给 aiGateway（options.preferredAdapter，
// 与 CLI `khy gateway` 的通道选择同契约）。模型级选项 id 形如
// `provider/model`，channel 字段是后端池 key；channelKnown=false 时
// （聚合网关等未注册池）不钉 preferredAdapter，走网关默认通道级联。
// 选项表查不到时按 id 前缀退化（P3-7③：动态模型并入后 id 形同
// `<channel>/<model>`，前缀即 channel）。
    const selId = modelName ?? ''
    const currentOption = catalogOptions.find((o) => o.id === selId)
    const pid = selId ? selId.split('/')[0] : ''
    const providerOpt = currentOption ?? catalogOptions.find((o) => o.id === pid)
    const sendOptions: Record<string, unknown> = {}
    const adapterKey = providerOpt?.channel || (pid && selId.includes('/') ? pid : selId)
    if (adapterKey && providerOpt?.channelKnown !== false) sendOptions.preferredAdapter = adapterKey
    api.aiSend({ prompt: text, options: sendOptions }).then((res) => {
      if (res?.ok && res.text) {
        dispatch(updateMessage({ id: assistantId, updates: { content: res.text, status: 'complete' } }))
        dispatch(setMessageStatus({ id: assistantId, status: 'complete' }))
      } else if (res?.ok && res.empty) {
        const chan = res.actualAdapter || res.provider || '未知通道'
        dispatch(updateMessage({
          id: assistantId,
          updates: {
            content: `网关通道 ${chan} 已收到模型答复但未返回正文${res.fallbackReason ? `（fallback：${res.fallbackReason}）` : ''}。请运行 khy gateway status 查看通道健康`,
            status: 'error',
            error: 'empty reply',
          },
        }))
      } else if (res?.ok) {
        dispatch(updateMessage({ id: assistantId, updates: { content: '', status: 'complete' } }))
      } else {
        const chan = res?.actualAdapter || res?.provider || ''
        const detail = res?.error || res?.fallbackReason || '请运行 khy gateway status 检查通道配置'
        dispatch(updateMessage({
          id: assistantId,
          updates: { content: `AI 网关调用失败${chan ? `（通道 ${chan}）` : ''}：${detail}`, status: 'error', error: res?.error },
        }))
      }
      dispatch(setStreaming(false))
      dispatch(setAgentWorking(false))
      setSending(false)
    }).catch((err: unknown) => {
      dispatch(updateMessage({ id: assistantId, updates: { content: `AI 请求失败：${String(err)}，请稍后重试`, status: 'error', error: String(err) } }))
      dispatch(setStreaming(false))
      dispatch(setAgentWorking(false))
      setSending(false)
    })
  }

  // Quick-action cards prefill the composer: fill the text once when
  // prefillText changes (parent clears it via onPrefillConsumed), then
  // hand focus to the textarea so the user can edit before sending.
  const lastPrefillRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (prefillText === undefined || prefillText === lastPrefillRef.current) return
    lastPrefillRef.current = prefillText
    setInput(prefillText)
    textareaRef.current?.focus()
    onPrefillConsumed?.()
  }, [prefillText, onPrefillConsumed])

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

  // 两种形态：'bottom' 钉在会话底部的输入条（带顶部分隔线）；'card' 居中悬浮输入卡片
  // （ZCode 空态首页，圆角卡片 + 阴影，无顶部分隔线）——对齐 ZC-ALIGN-005 E3 实测。
  const outerClass = variant === 'card'
    ? 'bg-panel rounded-xl border border-border shadow-lg px-4 py-2.5'
    : 'border-t border-border bg-panel px-4 py-3'

  return (
    <div className={outerClass}>
      {/* header 槽位（[DESIGN-ARCH-125] P-01）：空态卡片顶端的「工作空间选择行」。
          日常会话（bottom 形态）不传，即为无 header。分隔线走 border-border/50，
          与工具行上方那条同款，保持卡片内部线条一致。 */}
      {header && <div className="mb-2 pb-2 border-b border-border/50">{header}</div>}
      {/* 提及弹出层 — 条目来自真实数据源；拉不到时显示空态行而不是静默关闭 */}
      {mentionType && (
        <div
          ref={mentionRef}
          className="mb-2 bg-popover border border-popover-border rounded-xl shadow-xl overflow-hidden animate-slide-down"
        >
          <div className="px-3 py-2 border-b border-popover-border">
            <span className="text-xs font-semibold text-popover-header">{MENTION_META[mentionType]?.label}</span>
            <span className="text-xs text-foreground/40 ml-2">↑↓ 选择 · ↵ 确认 · Esc 关闭</span>
          </div>
          <div className="max-h-48 overflow-auto py-1">
            {filteredItems.length === 0 && (
              <div className="px-3 py-2.5 text-xs text-foreground/40">
                {mentionQuery ? '没有匹配的条目。' : '暂无可选条目：数据来自本地会话/技能/命令索引，可在设置中补齐。'}
              </div>
            )}
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
                    <div className="text-xs text-foreground/50 mt-0.5 truncate">{item.description}</div>
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
        {sending && (
          <div className="px-4 pt-2.5 text-xs text-foreground/50 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse inline-block" />
            <span>正在等待 KhyOS 网关回复（host 已加载 aiGateway，多通道重试中）…</span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={sending ? '继续输入以排队后续修改' : '向 KhyOS 提问，使用 @ 添加上下文，使用 / 选择命令或能力'}
          className="w-full bg-transparent px-4 pt-3.5 text-foreground placeholder:text-foreground/35 resize-none focus:outline-none text-sm leading-relaxed"
          style={{ minHeight: '80px', maxHeight: '240px' }}
          rows={3}
        />

        {/* 底部工具栏 — 左：添加上下文（ZCode G0 四项菜单）；右：ZCode E5b
            整簇（上下文用量 / 后台任务 / 模式 / 推理强度 / 模型 / 停止 / 发送）。
            右侧整体 flex-wrap + 各项 whitespace-nowrap，窄窗口下换行而不是把
            发送按钮挤出卡片（此前无 nowrap 导致提示文字竖排、发送被裁切）。 */}
        <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1.5 border-t border-border/50">
          <div className="flex items-center gap-0.5 shrink-0">
            <AddContextButton
              onAttach={handleAttach}
              onInsertTrigger={handleInsertTrigger}
            />
          </div>

          <div className="flex items-center gap-1 flex-wrap justify-end min-w-0">
            {input.length > 0 && (
              <span className="text-xs text-foreground/40 tabular-nums">{input.length} 字</span>
            )}
            {/* P3-6: 上下文已用/总量 按钮 — 对齐 ZCode 实测 a57
                「上下文已用 X / 总量 Y」+ G0d 用量弹窗（点开看容量与占比） */}
            {ctxTotal > 0 && (
              <ContextUsageButton used={ctxUsed} total={ctxTotal} error={ctxError} />
            )}
            {/* P3-6①: 运行中后台任务计数按钮（i18n chat.composer.backgroundWorks；
                count=0 时隐藏，与 ZCode 空态行为一致） */}
            <BackgroundTasksButton />
            {/* 模式选择器（ZCode G0b「切换模式」combobox，四项 mode.description.*） */}
            {onModeChange && <ModeSelector mode={agentMode} onModeChange={onModeChange} />}
            {/* P3-8: 推理强度 选择器（对齐 ZCode a259 combobox 高） */}
            {onThoughtLevelChange && (
              <ThoughtLevelButton level={thoughtLevel} onChange={onThoughtLevelChange} />
            )}
            {/* P3-7: 模型选择器 — 接后端 providerPresets 真源（useModelCatalog），
                对齐 ZCode「选择模型」combobox；无 onChange 时退化为只读 chip */}
            {onModelChange ? (
              <ModelSelector current={modelName ?? ''} onChange={onModelChange} options={catalogOptions} />
            ) : modelName ? (
              <button
                className="px-2 py-1 rounded-md text-xs text-foreground/60 transition-colors flex items-center gap-1 whitespace-nowrap"
                title={`当前模型 ${modelName}（只读）`}
                disabled
              >
                <span>{modelName}</span>
              </button>
            ) : null}
            {sending && (
              <button
                onClick={() => {
                  const api = (window as unknown as { __KHYOS__?: { aiAbort?: () => Promise<{ ok: boolean; aborted?: number }> } }).__KHYOS__
                  void api?.aiAbort?.()
                }}
                className="px-3 py-1.5 rounded-lg border border-border text-xs text-foreground/70 hover:text-foreground hover:bg-surface-hover transition-colors flex items-center gap-1.5 whitespace-nowrap"
                title="停止等待回复"
              >
                <span className="w-2.5 h-2.5 rounded-[2px] bg-current inline-block" />
                <span>停止</span>
              </button>
            )}
            <button
              onClick={handleSend}
              disabled={sending || (!input.trim() && attachments.length === 0)}
              className="bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-medium disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-opacity flex items-center gap-2 shrink-0 whitespace-nowrap"
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
