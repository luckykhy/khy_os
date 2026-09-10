import { Component, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
  section?: boolean
  onReset?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ errorInfo })
    console.error('[ErrorBoundary]', error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: null })
    this.props.onReset?.()
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      const isSection = this.props.section

      return (
        <div className={`flex flex-col items-center justify-center p-8 ${isSection ? 'rounded-xl border border-card-border bg-card m-4' : 'h-full'}`}>
          <div className="text-center max-w-md">
            <span className="text-4xl block mb-4">⚠️</span>
            <h3 className="text-lg font-semibold text-foreground mb-2">
              {isSection ? '这块界面出了点问题' : '应用界面出了点问题'}
            </h3>
            <p className="text-sm text-foreground/50 mb-4">
              {isSection
                ? '错误已经限制在当前区域，其他功能可以继续使用。你可以先重试这个区域；如果问题持续，再刷新应用。'
                : '刚才的页面错误已经被拦住了，所以不会直接白屏。你可以先重试；如果问题持续，再刷新应用恢复界面。'
              }
            </p>

            {/* 错误详情 */}
            {this.state.error && (
              <details className="mb-4 text-left">
                <summary className="text-xs text-foreground/40 cursor-pointer hover:text-foreground/60">
                  查看组件堆栈
                </summary>
                <div className="mt-2 p-3 bg-input rounded-lg text-xs font-mono text-foreground/50 overflow-auto max-h-32">
                  <div className="text-destructive mb-1">{this.state.error.message}</div>
                  {this.state.errorInfo && (
                    <pre className="whitespace-pre-wrap">{this.state.errorInfo.componentStack}</pre>
                  )}
                </div>
              </details>
            )}

            <p className="text-xs text-foreground/30 mb-4">
              错误详情已记录到诊断日志里，方便继续排查。
            </p>

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={this.handleRetry}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
              >
                {isSection ? '重试此区域' : '重试'}
              </button>
              {!isSection && (
                <button
                  onClick={this.handleReload}
                  className="px-4 py-2 text-sm text-foreground/60 hover:text-foreground rounded-lg border border-card-border hover:bg-surface-hover transition-colors"
                >
                  刷新应用
                </button>
              )}
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export function ErrorBanner({ error, onRetry, onDismiss }: { error: string; onRetry?: () => void; onDismiss?: () => void }) {
  return (
    <div className="mx-4 my-2 p-4 bg-destructive/10 border border-destructive/20 rounded-xl animate-slide-down">
      <div className="flex items-start gap-3">
        <span className="text-lg">❌</span>
        <div className="flex-1">
          <div className="text-sm font-medium text-destructive mb-1">发生错误</div>
          <div className="text-sm text-foreground/60">{error}</div>
        </div>
        <div className="flex items-center gap-2">
          {onRetry && (
            <button
              onClick={onRetry}
              className="px-3 py-1 text-xs font-medium text-destructive border border-destructive/30 rounded-lg hover:bg-destructive/10 transition-colors"
            >
              重试
            </button>
          )}
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="p-1 text-foreground/40 hover:text-foreground rounded transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
