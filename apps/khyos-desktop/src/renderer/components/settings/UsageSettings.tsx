import { useState, useEffect, useCallback } from 'react'

// ── 使用统计 settings page (ZC-ALIGN-002 I8, a11y s-7) ──
// Dashboard: model usage breakdown + daily timeline.
// Real data source: backend tokenUsageService.getUsageHistory/getModelUsage
// (persistent daily buckets + per-model buckets), via preload getUsageHistory
// → main usage:history → host usage.history (CH-2). ZC-ALIGN-001 P13:
// replaced the fabricated MODEL_USAGE rows / '22.4亿' total / Math.random bars.

interface HistoryDay {
  date: string
  totalTokens: number
  requests: number
  costUSD: number
}

interface ModelUsageRow {
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
  costUSD: number
  percentage: number
}

interface UsageHistoryResponse {
  ok: boolean
  history?: HistoryDay[] | null
  models?: ModelUsageRow[] | null
  error?: string
}

// ZCode's compact token counts (亿/万 scale), matching the a11y s-7 rows.
function fmtTokens(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  return String(n)
}

// Month-day label for the timeline axis, from a YYYY-MM-DD key.
function fmtDayLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  return `${Number(m[2])}月${Number(m[3])}日`
}

const MODEL_ROW_COLORS = [
  'var(--color-brand)',
  '#58a6ff',
  '#46bf72',
  '#ff8a30',
  '#d2a8ff',
  '#f778ba',
]

export function UsageSettings() {
  const [range, setRange] = useState<'7d' | '30d'>('30d')
  const [history, setHistory] = useState<HistoryDay[] | null>(null)
  const [models, setModels] = useState<ModelUsageRow[] | null>(null)
  const [usageError, setUsageError] = useState('')
  const [loading, setLoading] = useState(true)

  const loadHistory = useCallback((days: number) => {
    const api = (window as unknown as {
      __KHYOS__?: { getUsageHistory?: (days?: number) => Promise<UsageHistoryResponse> }
    }).__KHYOS__
    if (!api?.getUsageHistory) {
      setUsageError('用量数据不可用：preload 未注入 __KHYOS__，请重启应用')
      setLoading(false)
      return
    }
    setLoading(true)
    api.getUsageHistory(days).then((res) => {
      if (res?.ok && res.history && res.models) {
        setHistory(res.history)
        setModels(res.models)
        setUsageError('')
      } else {
        setUsageError(res?.error || '用量历史读取失败：请重启应用后重试')
      }
      setLoading(false)
    }).catch(() => {
      setUsageError('用量历史读取失败：host 进程无响应，请重启应用')
      setLoading(false)
    })
  }, [])

  // Load on mount and whenever the range tab changes (real refetch, not a
  // local slice — host clamps days to the 90-day persistence horizon).
  useEffect(() => { loadHistory(range === '30d' ? 30 : 7) }, [range, loadHistory])

  const days = history || []
  const totalTokens = days.reduce((sum, d) => sum + d.totalTokens, 0)
  const maxDayTokens = Math.max(1, ...days.map((d) => d.totalTokens))
  const firstDay = days[0]?.date
  const lastDay = days[days.length - 1]?.date

  return (
    <div className="max-w-4xl">
      {/* ── Date range tabs + refresh ── */}
      <div className="flex items-center gap-1 mb-6">
        <button
          onClick={() => setRange('30d')}
          className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
            range === '30d'
              ? 'bg-selected text-foreground font-medium'
              : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          近 30 日
        </button>
        <button
          onClick={() => setRange('7d')}
          className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
            range === '7d'
              ? 'bg-selected text-foreground font-medium'
              : 'text-foreground/60 hover:text-foreground hover:bg-surface-hover'
          }`}
        >
          近 7 日
        </button>
        <div className="flex-1" />
        <button
          onClick={() => loadHistory(range === '30d' ? 30 : 7)}
          className="px-3 py-1.5 text-sm text-foreground/60 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors flex items-center gap-1.5"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 6a4 4 0 1 1 8 0a4 4 0 0 1-8 0z" stroke="currentColor" strokeWidth="1.2" />
            <path d="M6 4v2l1.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          刷新
        </button>
      </div>

      {usageError && (
        <div className="mb-4 px-4 py-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl">
          {usageError}
        </div>
      )}

      {/* ── Summary card: real total over the selected range ── */}
      <div className="bg-card border border-card-border rounded-xl p-6 mb-6">
        <div className="text-sm text-foreground/50 mb-1">总用量（{range === '30d' ? '近 30 日' : '近 7 日'}）</div>
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold text-foreground tabular-nums">
            {loading && !history ? '—' : fmtTokens(totalTokens)}
          </span>
          <span className="text-sm text-foreground/50">tokens</span>
        </div>
        {history && days.length > 0 && (
          <div className="text-xs text-foreground/40 mt-2">
            {days.reduce((s, d) => s + d.requests, 0)} 次请求 · ${days.reduce((s, d) => s + d.costUSD, 0).toFixed(2)}
          </div>
        )}
      </div>

      {/* ── Model usage breakdown (persistent per-model buckets) ── */}
      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-card-border">
          <h3 className="text-sm font-semibold text-foreground">模型用量</h3>
        </div>
        <div className="divide-y divide-card-border">
          {!loading && models && models.length === 0 && (
            <div className="px-5 py-8 text-center">
              <p className="text-sm text-foreground/50 mb-2">暂无模型用量记录</p>
              <p className="text-xs text-foreground/40">发起 AI 对话后，按模型的累计用量会在此展示。</p>
            </div>
          )}
          {(models || []).map((row, i) => (
            <div key={row.model} className="px-5 py-4 hover:bg-surface-hover transition-colors">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: MODEL_ROW_COLORS[i % MODEL_ROW_COLORS.length] }}
                  />
                  <span className="text-sm font-mono text-foreground">{row.model}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-sm text-foreground/60">{fmtTokens(row.totalTokens)} tokens</span>
                  <span className="text-sm font-medium text-foreground tabular-nums w-12 text-right">{row.percentage}%</span>
                </div>
              </div>
              {/* Usage bar (real share of the recorded grand total) */}
              <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${Math.min(100, row.percentage)}%`,
                    backgroundColor: MODEL_ROW_COLORS[i % MODEL_ROW_COLORS.length],
                  }}
                />
              </div>
            </div>
          ))}
          {loading && !models && (
            <div className="px-5 py-8 text-center text-sm text-foreground/50">读取用量历史（近 {range === '30d' ? 30 : 7} 日）…</div>
          )}
        </div>
      </div>

      {/* ── Daily usage timeline (persistent daily buckets) ── */}
      <div className="bg-card border border-card-border rounded-xl p-5 mt-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">每日用量</h3>
        {days.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-sm text-foreground/40">
            {loading ? '读取每日用量…' : '暂无记录'}
          </div>
        ) : (
          <div className="flex items-end gap-1 h-32">
            {days.map((d) => (
              <div
                key={d.date}
                className="flex-1 bg-brand/20 hover:bg-brand/40 transition-colors rounded-sm"
                style={{ height: `${Math.max(2, (d.totalTokens / maxDayTokens) * 100)}%` }}
                title={`${fmtDayLabel(d.date)}：${fmtTokens(d.totalTokens)} tokens · ${d.requests} 次请求`}
              />
            ))}
          </div>
        )}
        {days.length > 0 && (
          <div className="flex justify-between mt-2 text-xs text-foreground/40">
            <span>{fmtDayLabel(firstDay || '')}</span>
            <span>今日</span>
          </div>
        )}
      </div>
    </div>
  )
}
