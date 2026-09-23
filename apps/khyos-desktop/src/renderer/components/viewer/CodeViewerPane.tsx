import { useEffect, useState, useMemo } from 'react'
import { MarkdownRenderer } from '../message/MarkdownRenderer'

// 代码查看面板（codeViewer.* 文案，ZC-ALIGN 逐项对齐）：
// - .md 文件：Markdown 分段控件「预览 | 源码」（markdownMode/markdownPreview/
//   markdownSource），预览复用会话消息的 MarkdownRenderer
// - 其他文本文件：直接源码视图
// - 四态：loadingFile / empty / fileMissing / fileTooLarge / binary
// - 自动换行开关（wrapLines）只作用于源码视图
//
// 数据经 preload __KHYOS__.codeViewerRead → main codeViewer:read（256KB 上限
// + 二进制检测都在主进程，渲染层只消费四态契约）。

interface ViewerPayload {
  ok: boolean
  state?: 'ok' | 'tooLarge' | 'binary' | 'missing' | 'empty'
  content?: string
  size?: number
  error?: string
}

interface CodeViewerPaneProps {
  filePath: string
  // 关闭按钮 → 由 AppLayout 移除标签（codeViewer.close = 关闭代码面板）
  onClose: () => void
}

const STATE_COPY: Record<string, string> = {
  tooLarge: '文件超过 256 KB 预览上限，请使用其他编辑器打开以查看完整内容。',
  binary: '当前文件看起来像二进制内容，暂不支持代码预览。',
  missing: '文件不存在，或当前环境无法访问该路径。',
  empty: '文件为空',
}

export function CodeViewerPane({ filePath, onClose }: CodeViewerPaneProps) {
  const [payload, setPayload] = useState<ViewerPayload | null>(null)
  const [loadError, setLoadError] = useState('')
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [wrapLines, setWrapLines] = useState(false)

  const fileName = useMemo(() => {
    const seg = filePath.split(/[\\/]/).pop() || filePath
    return seg
  }, [filePath])

  const isMarkdown = /\.md$/i.test(fileName)
  // Non-markdown files have no preview mode: source only
  const effectiveMode = isMarkdown ? mode : 'source'

  useEffect(() => {
    let cancelled = false
    setPayload(null)
    setLoadError('')
    const api = (window as unknown as {
      __KHYOS__?: { codeViewerRead?: (p: string) => Promise<ViewerPayload> }
    }).__KHYOS__
    if (!api?.codeViewerRead) {
      setLoadError('代码查看通道不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    api.codeViewerRead(filePath).then((res) => {
      if (!cancelled) setPayload(res)
    }).catch(() => {
      if (!cancelled) setLoadError('文件读取请求失败：主进程无响应，请重启应用后重试')
    })
    return () => { cancelled = true }
  }, [filePath])

  const busy = !payload && !loadError

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 头部：文件名 + 模式切换 + 自动换行 + 关闭（codeViewer.close） */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <span className="text-sm font-medium text-foreground truncate flex-1" title={filePath}>
          {fileName}
        </span>
        {isMarkdown && payload?.ok && (
          <div
            className="flex items-center rounded-lg bg-surface border border-border p-0.5"
            role="group"
            aria-label="Markdown"
          >
            <button
              onClick={() => setMode('preview')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === 'preview'
                  ? 'bg-selected text-foreground'
                  : 'text-foreground/60 hover:text-foreground'
              }`}
              aria-pressed={mode === 'preview'}
            >
              预览
            </button>
            <button
              onClick={() => setMode('source')}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === 'source'
                  ? 'bg-selected text-foreground'
                  : 'text-foreground/60 hover:text-foreground'
              }`}
              aria-pressed={mode === 'source'}
            >
              源码
            </button>
          </div>
        )}
        <button
          onClick={() => setWrapLines(v => !v)}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            wrapLines
              ? 'bg-selected text-foreground'
              : 'text-foreground/50 hover:text-foreground hover:bg-surface-hover'
          }`}
          aria-pressed={wrapLines}
          title="自动换行"
        >
          自动换行
        </button>
        <button
          onClick={onClose}
          className="w-7 h-7 rounded-md flex items-center justify-center text-foreground/40 hover:text-foreground hover:bg-surface-hover transition-colors shrink-0"
          aria-label="关闭代码面板"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* 内容区：四态 + 源码/预览视图 */}
      <div className="flex-1 overflow-auto">
        {busy ? (
          <div className="flex items-center justify-center h-full text-sm text-foreground/50">
            正在读取文件...
          </div>
        ) : loadError ? (
          <div className="flex items-center justify-center h-full text-sm text-destructive px-6 text-center">
            {loadError}
          </div>
        ) : payload && !payload.ok ? (
          <div className="flex items-center justify-center h-full text-sm text-foreground/50 px-6 text-center">
            {STATE_COPY[payload.state || 'missing'] || STATE_COPY.missing}
          </div>
        ) : (
          <>
            {effectiveMode === 'preview' ? (
              <div className="px-4 py-3">
                <MarkdownRenderer content={payload?.content || ''} />
              </div>
            ) : (
              <pre
                className={`text-xs font-mono text-foreground/90 leading-relaxed p-4 ${
                  wrapLines ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'
                }`}
              >
                <code>{payload?.content || ''}</code>
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  )
}
