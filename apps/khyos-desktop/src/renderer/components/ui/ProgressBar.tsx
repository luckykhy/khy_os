interface ProgressBarProps {
  value: number
  max?: number
  label?: string
  showPercentage?: boolean
  size?: 'sm' | 'md'
  className?: string
}

export function ProgressBar({ value, max = 100, label, showPercentage = false, size = 'md', className = '' }: ProgressBarProps) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100))
  const heightClass = size === 'sm' ? 'h-1' : 'h-2'

  return (
    <div className={`w-full ${className}`}>
      {(label || showPercentage) && (
        <div className="flex items-center justify-between mb-1">
          {label && <span className="text-xs text-foreground/60">{label}</span>}
          {showPercentage && <span className="text-xs text-foreground/40">{Math.round(percentage)}%</span>}
        </div>
      )}
      <div className={`w-full bg-foreground/10 rounded-full overflow-hidden ${heightClass}`}>
        <div
          className="h-full bg-brand rounded-full transition-all duration-500 ease-out"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}

export function ContextUsageBar({ used, total }: { used: number; total: number }) {
  const percentage = (used / total) * 100
  const color = percentage > 90 ? 'bg-destructive' : percentage > 70 ? 'bg-warning' : 'bg-brand'

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-foreground/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-xs text-foreground/40 tabular-nums">
        {(used / 1000).toFixed(1)}K / {(total / 1000).toFixed(0)}K
      </span>
    </div>
  )
}
