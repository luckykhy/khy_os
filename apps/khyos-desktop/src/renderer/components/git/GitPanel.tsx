import { useCallback, useEffect, useState } from 'react'
import { EmptyState } from '../ui/EmptyState'
import { Spinner } from '../ui/Spinner'

// Result contract of main's git:status handler (git status --porcelain=v1
// -z --branch over the workspace cwd). Four outcome states:
// ok / notRepository / gitUnavailable (no git.exe on PATH) / error.
interface GitStatusResult {
  ok: boolean
  state?: 'ok' | 'notRepository' | 'gitUnavailable' | 'error'
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  changes?: { path: string; status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'; staged: boolean }[]
  error?: string
}

interface GitChange {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

// git.kind.* i18n: 新增 / 冲突 / 删除 / 修改 / 重命名 (untracked falls under
// the untracked section, labeled by section.untracked)
const KIND_LABEL: Record<GitChange['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  renamed: '重命名',
  untracked: '新增',
}

const STATUS_CONFIG: Record<GitChange['status'], { color: string; letter: string }> = {
  modified: { color: 'var(--color-git-modified)', letter: 'M' },
  added: { color: 'var(--color-git-added)', letter: 'A' },
  deleted: { color: 'var(--color-git-deleted)', letter: 'D' },
  renamed: { color: 'var(--color-git-renamed)', letter: 'R' },
  untracked: { color: 'var(--color-git-untracked)', letter: 'U' },
}

type PanelState =
  | { phase: 'loading' }
  | { phase: 'ready'; data: GitStatusResult }
  | { phase: 'empty'; data: GitStatusResult }
  | { phase: 'gitUnavailable' }
  | { phase: 'notRepository' }
  | { phase: 'error'; message: string }

function classify(result: GitStatusResult | null, err?: unknown): PanelState {
  if (!result) {
    // preload not injected or IPC threw before returning a payload
    const msg = err instanceof Error ? err.message : String(err ?? '未知错误')
    return { phase: 'error', message: msg || 'preload 未注入：__KHYOS__ 不可用，请重启应用' }
  }
  if (!result.ok) {
    if (result.state === 'gitUnavailable') return { phase: 'gitUnavailable' }
    if (result.state === 'notRepository') return { phase: 'notRepository' }
    return { phase: 'error', message: result.error || 'git status 执行失败' }
  }
  const changes = result.changes || []
  if (changes.length === 0) return { phase: 'empty', data: result }
  return { phase: 'ready', data: result }
}

function ChangeRow({ change }: { change: GitChange }) {
  const config = STATUS_CONFIG[change.status]
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md mx-1 hover:bg-surface-hover transition-colors">
      <span
        className="w-4 h-4 rounded text-xs font-bold flex items-center justify-center shrink-0"
        style={{ backgroundColor: config.color + '20', color: config.color }}
      >
        {config.letter}
      </span>
      <span className="text-sm text-foreground truncate flex-1" title={change.path}>
        {change.path}
      </span>
      <span className="text-xs" style={{ color: config.color }}>
        {KIND_LABEL[change.status]}
      </span>
    </div>
  )
}

function Section({ title, changes }: { title: string; changes: GitChange[] }) {
  if (changes.length === 0) return null
  return (
    <div>
      <div className="flex items-center gap-1.5 px-4 pt-3 pb-1">
        <span className="text-xs font-medium text-foreground/60">{title}</span>
        <span className="text-xs text-foreground/30">{changes.length}</span>
      </div>
      {changes.map((c) => (
        <ChangeRow key={`${c.staged ? 's' : 'u'}:${c.path}`} change={c} />
      ))}
    </div>
  )
}

export function GitPanel() {
  const [state, setState] = useState<PanelState>({ phase: 'loading' })
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const api = (window as unknown as {
      __KHYOS__?: { gitStatus?: () => Promise<GitStatusResult> }
    }).__KHYOS__
    if (!api?.gitStatus) {
      setState({ phase: 'error', message: 'preload 未注入：__KHYOS__ 不可用，请重启应用' })
      return
    }
    try {
      const result = await api.gitStatus()
      setState(classify(result))
    } catch (err) {
      setState(classify(null, err))
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="h-full flex flex-col">
      {/* 头部：分支信息 + 刷新（git.action.refresh） */}
      <div className="flex items-center gap-2 px-3 h-11 border-b border-border shrink-0">
        {state.phase === 'ready' && (
          <span className="text-xs text-foreground/50 truncate">
            {state.data.branch === 'HEAD' ? '游离 HEAD' : state.data.branch}
            {state.data.ahead !== undefined && state.data.behind !== undefined && (
              <span className="ml-1 text-foreground/30">
                (↑{state.data.ahead} ↓{state.data.behind})
              </span>
            )}
          </span>
        )}
        <div className="flex-1" />
        <button
          onClick={() => {
            setRefreshing(true)
            void load()
          }}
          disabled={refreshing}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground/60 hover:text-foreground transition-colors disabled:opacity-40"
          title="刷新"
          aria-label="刷新"
        >
          {refreshing ? (
            <Spinner size="sm" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M13.5 2.5v4h-4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M13.3 6.4A5.5 5.5 0 1 0 13.5 8.5" strokeLinecap="round" />
            </svg>
          )}
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {state.phase === 'loading' && (
          <div className="flex flex-col items-center justify-center h-full text-center px-8 animate-fade-in">
            <Spinner size="md" />
            <p className="text-sm text-foreground/50 mt-3">正在读取当前工作区的 Git 状态和文件改动。</p>
          </div>
        )}

        {state.phase === 'gitUnavailable' && (
          <EmptyState
            icon="🔧"
            title="当前环境没有可用的 Git"
            description="请先安装 Git，或确认当前运行环境里可以执行 git 命令。"
          />
        )}

        {state.phase === 'notRepository' && (
          <EmptyState
            icon="📁"
            title="当前 workspace 不在 Git 仓库中"
            description="打开一个 Git 仓库目录后，这里会展示当前 workspace 作用域内的改动。"
          />
        )}

        {state.phase === 'error' && (
          <EmptyState
            icon="⚠️"
            title="无法加载 Git 改动"
            description={`Git 返回错误：${state.message}`}
          />
        )}

        {state.phase === 'empty' && (
          <EmptyState
            icon="✅"
            title="当前来源下没有可展示的改动"
            description="可以切换其它来源，或等当前 workspace 产生新的 Git 改动后再查看。"
          />
        )}

        {state.phase === 'ready' && (
          <div className="pb-3">
            {/* git.section.* 三节：已暂存 / 未暂存 / 未跟踪 */}
            <Section
              title="已暂存"
              changes={(state.data.changes || []).filter((c) => c.staged)}
            />
            <Section
              title="未暂存"
              changes={(state.data.changes || []).filter((c) => !c.staged && c.status !== 'untracked')}
            />
            <Section
              title="未跟踪"
              changes={(state.data.changes || []).filter((c) => c.status === 'untracked')}
            />
          </div>
        )}
      </div>
    </div>
  )
}
