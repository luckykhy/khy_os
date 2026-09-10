import { useState } from 'react'

interface ContextBreakdown {
  label: string
  tokens: number
  color: string
  percentage: number
}

export function ContextUsagePanel() {
  const [expanded, setExpanded] = useState(false)

  const used = 12400
  const total = 128000
  const percentage = (used / total) * 100

  const breakdown: ContextBreakdown[] = [
    { label: '系统提示词', tokens: 4200, color: 'bg-fuchsia-500', percentage: 33.9 },
    { label: '消息', tokens: 3800, color: 'bg-sky-500', percentage: 30.6 },
    { label: '系统工具', tokens: 2100, color: 'bg-yellow-500', percentage: 16.9 },
    { label: 'MCP 工具', tokens: 1200, color: 'bg-green-500', percentage: 9.7 },
    { label: '技能', tokens: 800, color: 'bg-cyan-500', percentage: 6.5 },
    { label: '工具提示词', tokens: 200, color: 'bg-orange-500', percentage: 1.6 },
    { label: '其他', tokens: 100, color: 'bg-foreground/30', percentage: 0.8 },
  ]

  return (
    <div className="my-3 bg-card border border-card-border rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-surface-hover transition-colors"
      >
        <span className={`transition-transform duration-200 text-xs ${expanded ? 'rotate-90' : ''}`}>▶</span>
        <span className="font-medium text-foreground">上下文用量</span>
        <span className="text-xs text-foreground/40 ml-auto">
          {(used / 1000).toFixed(1)}K / {(total / 1000).toFixed(0)}K ({percentage.toFixed(1)}%)
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 animate-slide-down">
          {/* 总进度条 */}
          <div className="h-2 bg-surface rounded-full overflow-hidden mb-4 flex">
            {breakdown.map((item, i) => (
              <div
                key={i}
                className={`${item.color} transition-all duration-500`}
                style={{ width: `${item.percentage}%` }}
                title={`${item.label}: ${item.tokens} tokens`}
              />
            ))}
          </div>

          {/* 分项列表 */}
          <div className="space-y-2">
            {breakdown.map((item, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className={`w-3 h-3 rounded-sm ${item.color} flex-shrink-0`} />
                <span className="text-sm text-foreground/70 flex-1">{item.label}</span>
                <span className="text-xs text-foreground/40 tabular-nums">{(item.tokens / 1000).toFixed(1)}K</span>
                <span className="text-xs text-foreground/30 tabular-nums w-12 text-right">{item.percentage.toFixed(1)}%</span>
              </div>
            ))}
          </div>

          {/* 缓存命中率 */}
          <div className="mt-4 pt-3 border-t border-card-border flex items-center justify-between">
            <span className="text-xs text-foreground/50">平均缓存命中率</span>
            <span className="text-xs font-medium text-success">78.5%</span>
          </div>
        </div>
      )}
    </div>
  )
}

export function CheckpointRewindDialog({ visible, onClose, onConfirm }: { visible: boolean; onClose: () => void; onConfirm: () => void }) {
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)

  const safeToUndo = 3
  const unsafeToUndo = 1
  const ignored = 1

  const handleCheck = () => {
    setChecking(true)
    setTimeout(() => {
      setChecking(false)
      setChecked(true)
    }, 1500)
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        {/* 头部 */}
        <div className="px-6 py-4 border-b border-popover-border">
          <h3 className="text-lg font-semibold text-popover-foreground">撤销文件改动</h3>
          <p className="text-sm text-foreground/50 mt-1">撤销前会重新检查当前文件内容</p>
        </div>

        {/* 内容 */}
        <div className="px-6 py-4">
          {!checked ? (
            <div className="text-center py-6">
              <p className="text-sm text-foreground/60 mb-4">
                点击下方按钮检查可撤销的文件
              </p>
              <button
                onClick={handleCheck}
                disabled={checking}
                className="px-6 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
              >
                {checking ? '正在检查可撤销文件...' : '检查可撤销文件'}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* 安全区 */}
              <div className="p-3 bg-success/10 rounded-xl border border-success/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-success" />
                  <span className="text-sm font-medium text-success">可安全撤销</span>
                  <span className="text-xs text-foreground/40 ml-auto">{safeToUndo} 个文件</span>
                </div>
                <div className="text-xs text-foreground/50">这些文件未被外部修改，可以安全撤销</div>
              </div>

              {/* 不安全区 */}
              <div className="p-3 bg-destructive/10 rounded-xl border border-destructive/20">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-destructive" />
                  <span className="text-sm font-medium text-destructive">不能安全撤销</span>
                  <span className="text-xs text-foreground/40 ml-auto">{unsafeToUndo} 个文件</span>
                </div>
                <div className="text-xs text-foreground/50">文件已被外部修改，撤销可能丢失更改</div>
              </div>

              {/* 忽略区 */}
              <div className="p-3 bg-surface rounded-xl border border-card-border">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-foreground/30" />
                  <span className="text-sm font-medium text-foreground/60">已忽略</span>
                  <span className="text-xs text-foreground/40 ml-auto">{ignored} 个文件</span>
                </div>
                <div className="text-xs text-foreground/50">bash/shell 修改不参与撤销</div>
              </div>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="px-6 py-4 border-t border-popover-border flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-foreground/60 hover:text-foreground rounded-lg hover:bg-surface-hover transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => { onConfirm(); onClose() }}
            disabled={!checked}
            className="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg text-sm font-medium disabled:opacity-30 hover:opacity-90 transition-opacity"
          >
            撤销文件
          </button>
        </div>
      </div>
    </div>
  )
}
