import { ContextUsageBar } from '../ui/ProgressBar'

interface StatusBarProps {
  model?: string
  mode?: string
  contextUsage?: { used: number; total: number }
  status?: 'idle' | 'working' | 'waiting'
  elapsed?: number
}

export function StatusBar({ model = '未配置', mode = '默认模式', contextUsage, status = 'idle', elapsed }: StatusBarProps) {
  const formatElapsed = (ms: number) => {
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s} 秒`
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${m} 分 ${sec} 秒`
  }

  return (
    <div className="bg-header h-7 flex items-center px-4 text-xs text-foreground/60 border-t border-border select-none gap-4">
      <span className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-success" />
        <span>KhyOS Desktop</span>
      </span>

      <span className="text-foreground/30">|</span>

      <span className="flex items-center gap-1.5">
        <span className="text-foreground/40">模型</span>
        <span className="text-foreground/80 font-medium">{model}</span>
      </span>

      <span className="flex items-center gap-1.5">
        <span className="text-foreground/40">模式</span>
        <span className="text-foreground/80 font-medium">{mode}</span>
      </span>

      {contextUsage && (
        <div className="w-32">
          <ContextUsageBar used={contextUsage.used} total={contextUsage.total} />
        </div>
      )}

      <div className="flex-1" />

      {status === 'working' && elapsed !== undefined && (
        <span className="flex items-center gap-1.5 text-warning">
          <span className="animate-pulse">●</span>
          <span>已工作 {formatElapsed(elapsed)}</span>
        </span>
      )}

      {status === 'waiting' && (
        <span className="flex items-center gap-1.5 text-brand">
          <span className="animate-pulse">●</span>
          <span>等待响应</span>
        </span>
      )}

      {status === 'idle' && (
        <span className="flex items-center gap-1.5 text-foreground/40">
          <span>就绪</span>
        </span>
      )}
    </div>
  )
}
