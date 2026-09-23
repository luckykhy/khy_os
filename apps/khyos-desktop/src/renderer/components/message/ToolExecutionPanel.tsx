import { useState } from 'react'
import { useAppSelector } from '../../state/store'
import type { ToolExecution } from '../../state/toolExecutionSlice'

function ToolExecutionItem({ execution }: { execution: ToolExecution }) {
  const [expanded, setExpanded] = useState(execution.status === 'running')

  const statusConfig = {
    pending: { color: 'text-foreground/50', bg: 'bg-foreground/20', label: '等待中', icon: '⏳' },
    running: { color: 'text-warning', bg: 'bg-warning/20', label: '运行中', icon: '⚡' },
    success: { color: 'text-success', bg: 'bg-success/20', label: '完成', icon: '✅' },
    error: { color: 'text-destructive', bg: 'bg-destructive/20', label: '失败', icon: '❌' },
    cancelled: { color: 'text-foreground/50', bg: 'bg-foreground/20', label: '已取消', icon: '🚫' },
  }

  const status = statusConfig[execution.status]
  const duration = execution.startedAt && execution.completedAt
    ? `${((execution.completedAt - execution.startedAt) / 1000).toFixed(1)}s`
    : execution.status === 'running'
    ? `${((Date.now() - execution.startedAt) / 1000).toFixed(1)}s`
    : null

  return (
    <div className="border border-card-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-hover transition-colors"
      >
        <span className={`w-2 h-2 rounded-full ${status.bg} ${status.color} ${execution.status === 'running' ? 'animate-pulse' : ''}`} />
        <span className="font-medium text-foreground flex-1 text-left">{execution.name}</span>
        {duration && <span className="text-xs text-foreground/40">{duration}</span>}
        <span className={`text-xs ${status.color}`}>{status.label}</span>
        <span className={`text-foreground/40 text-xs transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 animate-slide-down">
          <div className="text-xs font-mono text-foreground/60 bg-input rounded-lg p-2 max-h-24 overflow-auto">
            <pre className="whitespace-pre-wrap break-all">{JSON.stringify(execution.input, null, 2)}</pre>
          </div>
          {execution.result && (
            <div className="text-xs font-mono text-foreground/70 bg-input rounded-lg p-2 mt-1 max-h-24 overflow-auto">
              <pre className="whitespace-pre-wrap break-all">{execution.result}</pre>
            </div>
          )}
          {execution.error && (
            <div className="text-xs font-mono text-destructive/80 bg-destructive/10 rounded-lg p-2 mt-1 max-h-24 overflow-auto">
              <pre className="whitespace-pre-wrap break-all">{execution.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function ToolExecutionPanel() {
  const executions = useAppSelector(state => state.toolExecution.executions)
  const activeIds = useAppSelector(state => state.toolExecution.activeIds)
  const [collapsed, setCollapsed] = useState(false)

  // 显示本轮全部工具执行（含已完成）。只显示「进行中」会让卡片在几十毫秒内
  // 一闪而过——用户看不到 agent 到底干过什么，而「看得见在干活」正是本面板的
  // 存在理由。清空交给下一次发送（Composer 发新请求时 clearExecutions）。
  const running = executions.filter(e => activeIds.includes(e.id)).length

  if (executions.length === 0) return null

  return (
    <div className="mx-4 my-2 bg-card border border-card-border rounded-xl overflow-hidden animate-slide-down">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface-hover transition-colors"
      >
        <span className={`w-2 h-2 rounded-full ${running > 0 ? 'bg-warning animate-pulse' : 'bg-success'}`} />
        <span className="font-medium text-foreground">{running > 0 ? '正在执行' : '工具执行'}</span>
        <span className="text-xs text-foreground/40">
          {running > 0 ? `${running} 个进行中` : `${executions.length} 个`}
        </span>
        <span className="text-xs text-foreground/30 ml-auto">{collapsed ? '展开' : '收起'}</span>
      </button>
      {!collapsed && (
        <div className="px-3 pb-3 space-y-1">
          {executions.map(execution => (
            <ToolExecutionItem key={execution.id} execution={execution} />
          ))}
        </div>
      )}
    </div>
  )
}
