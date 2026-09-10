import { useState } from 'react'

interface GoalBannerProps {
  goal?: string
  status?: 'idle' | 'running' | 'checking' | 'complete' | 'incomplete' | 'cancelled'
  onSetGoal?: (goal: string) => void
  onCancel?: () => void
}

export function GoalBanner({ goal, status = 'idle', onSetGoal, onCancel }: GoalBannerProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(goal ?? '')

  const statusConfig = {
    idle: { color: 'text-foreground/40', bg: 'bg-foreground/5', label: '' },
    running: { color: 'text-brand', bg: 'bg-brand/10', label: '执行中' },
    checking: { color: 'text-warning', bg: 'bg-warning/10', label: '目标校验中' },
    complete: { color: 'text-success', bg: 'bg-success/10', label: '目标已完成，任务结束' },
    incomplete: { color: 'text-warning', bg: 'bg-warning/10', label: '目标未完成，任务继续' },
    cancelled: { color: 'text-destructive', bg: 'bg-destructive/10', label: '目标校验已中断' },
  }

  const config = statusConfig[status]

  if (!goal && !editing) return null

  return (
    <div className={`mx-4 mt-3 rounded-xl border border-border overflow-hidden animate-slide-down`}>
      <div className={`flex items-center gap-3 px-4 py-3 ${config.bg}`}>
        <span className="text-sm">🎯</span>
        <div className="flex-1">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                placeholder="描述你的目标，例如：实现用户登录功能"
                className="flex-1 bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder:text-foreground/30 focus:outline-none focus:border-input-border-focused"
                autoFocus
              />
              <button
                onClick={() => {
                  if (draft.trim()) {
                    onSetGoal?.(draft.trim())
                    setEditing(false)
                  }
                }}
                className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium"
              >
                设定
              </button>
              <button
                onClick={() => { setEditing(false); setDraft(goal ?? '') }}
                className="px-3 py-1.5 text-foreground/60 hover:text-foreground text-sm"
              >
                取消
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">目标</span>
              <span className="text-sm text-foreground/70">{goal}</span>
              {config.label && (
                <span className={`text-xs ${config.color}`}>· {config.label}</span>
              )}
            </div>
          )}
        </div>
        {!editing && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setEditing(true)}
              className="p-1.5 rounded-lg text-foreground/40 hover:text-foreground hover:bg-surface-hover text-xs"
            >
              编辑
            </button>
            {onCancel && (
              <button
                onClick={onCancel}
                className="p-1.5 rounded-lg text-foreground/40 hover:text-destructive hover:bg-surface-hover text-xs"
              >
                取消
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
