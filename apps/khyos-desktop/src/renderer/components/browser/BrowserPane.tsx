import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { EmptyState } from '../ui/EmptyState'

// Browser tab body (browser.* i18n, ZC-ALIGN-003). Embeds live pages via
// <webview> — the Electron equivalent of ZCode's guest view: real back /
// forward / reload semantics and did-navigate / did-fail-load events.
// Requires webviewTag:true in main's webPreferences.

// Local minimal webview element model (renderer has no electron global
// types; the methods/events below are the WebviewTag DOM surface we use).
interface WebviewElement extends HTMLElement {
  src: string
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  addEventListener(type: string, listener: (event: never) => void): void
  removeEventListener(type: string, listener: (event: never) => void): void
}

// did-navigate / did-navigate-in-page payload
interface NavDetail {
  url: string
}
// did-fail-load payload (main frame only is handled)
interface FailLoadDetail {
  errorCode: number
  errorDescription: string
  isMainFrame: boolean
}
// render-process-gone payload
interface GoneDetail {
  reason: string
  exitCode: number
}

// Register <webview> as a JSX intrinsic element (React 19 type surface)
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<WebviewElement> & { src?: string },
        WebviewElement
      >
    }
  }
}

// browser.invalidUrl: 仅支持 http、https、file、about、data 地址
const ALLOWED_URL = /^(https?|file|about|data):/i

// did-fail-load error codes surfaced with dedicated copy (browser.loadError.*)
const CERT_ERROR_CODES = new Set([
  -202, // ERR_CERT_AUTHORITY_INVALID
  -200, // ERR_CERT_COMMON_NAME_INVALID
  -201, // ERR_CERT_DATE_INVALID
  -203, // ERR_CERT_WEAK_SIGNATURE_ALGORITHM,
])

interface NavState {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

type Failure =
  | { kind: 'cert' }
  | { kind: 'load'; message: string }
  | { kind: 'guest'; reason: string; exitCode: number }

function normalizeInput(raw: string): string | null {
  const input = raw.trim()
  if (!input) return null
  // Bare host input gets https:// prefixed (address-bar UX convention)
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`
  try {
    return new URL(candidate).toString()
  } catch {
    return null
  }
}

export function BrowserPane() {
  const webviewRef = useRef<WebviewElement | null>(null)
  const [address, setAddress] = useState('')
  const [currentUrl, setCurrentUrl] = useState('')
  const [nav, setNav] = useState<NavState>({ url: '', canGoBack: false, canGoForward: false, loading: false })
  const [failure, setFailure] = useState<Failure | null>(null)
  const [invalidHint, setInvalidHint] = useState(false)
  // Bump to force a webview remount on retry / reload (fresh guest process)
  const [reloadSeq, setReloadSeq] = useState(0)

  const attach = useCallback((node: WebviewElement | null) => {
    webviewRef.current = node
  }, [])

  const navigate = useCallback((raw: string) => {
    const normalized = normalizeInput(raw)
    if (!normalized || !ALLOWED_URL.test(normalized)) {
      setInvalidHint(true)
      window.setTimeout(() => setInvalidHint(false), 2500)
      return
    }
    setFailure(null)
    setCurrentUrl(normalized)
    setReloadSeq((s) => s + 1)
  }, [])

  // Bind webview lifecycle events after each remount.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || !currentUrl) return
    const onNavigate = (e: { url: string }) => {
      setNav({ url: e.url, canGoBack: wv.canGoBack(), canGoForward: wv.canGoForward(), loading: false })
      setAddress(e.url)
    }
    const onDidStartLoading = () => setNav((n) => ({ ...n, loading: true }))
    const onDidStopLoading = () => setNav((n) => ({ ...n, loading: false }))
    const onFailLoad = (e: FailLoadDetail) => {
      if (e.isMainFrame) {
        if (CERT_ERROR_CODES.has(e.errorCode)) setFailure({ kind: 'cert' })
        else setFailure({ kind: 'load', message: e.errorDescription || String(e.errorCode) })
      }
    }
    const onCrashed = () => setFailure({ kind: 'guest', reason: '渲染进程崩溃', exitCode: -1 })
    const onGone = (e: GoneDetail) => setFailure({ kind: 'guest', reason: e.reason, exitCode: e.exitCode })
    const onPluginCrashed = () => setFailure({ kind: 'guest', reason: '渲染进程插件崩溃', exitCode: -2 })
    const add = (type: string, listener: (event: never) => void) => wv.addEventListener(type, listener)
    const remove = (type: string, listener: (event: never) => void) => wv.removeEventListener(type, listener)
    const nav = onNavigate as unknown as (event: never) => void
    add('did-navigate', nav)
    add('did-navigate-in-page', nav)
    add('did-start-loading', onDidStartLoading as unknown as (event: never) => void)
    add('did-stop-loading', onDidStopLoading as unknown as (event: never) => void)
    add('did-fail-load', onFailLoad as unknown as (event: never) => void)
    add('crashed', onCrashed as unknown as (event: never) => void)
    add('render-process-gone', onGone as unknown as (event: never) => void)
    add('plugin-crashed', onPluginCrashed as unknown as (event: never) => void)
    return () => {
      remove('did-navigate', nav)
      remove('did-navigate-in-page', nav)
      remove('did-start-loading', onDidStartLoading as unknown as (event: never) => void)
      remove('did-stop-loading', onDidStopLoading as unknown as (event: never) => void)
      remove('did-fail-load', onFailLoad as unknown as (event: never) => void)
      remove('crashed', onCrashed as unknown as (event: never) => void)
      remove('render-process-gone', onGone as unknown as (event: never) => void)
      remove('plugin-crashed', onPluginCrashed as unknown as (event: never) => void)
    }
  }, [currentUrl, reloadSeq])

  const goBack = () => webviewRef.current?.goBack()
  const goForward = () => webviewRef.current?.goForward()
  const reload = () => {
    if (currentUrl) {
      setFailure(null)
      setReloadSeq((s) => s + 1)
    }
  }

  return (
    <div className="h-full flex flex-col bg-panel">
      {/* 地址栏 + 导航按钮 */}
      <div className="flex items-center gap-1 px-2 h-11 border-b border-border shrink-0">
        <button
          onClick={goBack}
          disabled={!nav.canGoBack}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground/60 hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="后退"
          aria-label="后退"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M9.5 3.5L5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={goForward}
          disabled={!nav.canGoForward}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground/60 hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="前进"
          aria-label="前进"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M6.5 3.5L11 8l-4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          onClick={reload}
          disabled={!currentUrl}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-foreground/60 hover:text-foreground transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="刷新"
          aria-label="刷新"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M13.5 2.5v4h-4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M13.3 6.4A5.5 5.5 0 1 0 13.5 8.5" strokeLinecap="round" />
          </svg>
        </button>
        <form
          className="flex-1 flex items-center"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(address)
          }}
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="输入网址后回车"
            spellCheck={false}
            className={`flex-1 h-7 rounded-md bg-input border px-2.5 text-xs text-foreground placeholder:text-foreground/30 focus:outline-none transition-colors ${
              invalidHint ? 'border-destructive' : 'border-input-border focus:border-input-border-focused'
            }`}
          />
        </form>
      </div>

      {/* 页面区 */}
      <div className="flex-1 relative overflow-hidden">
        {/* 空态：browser.empty */}
        {!currentUrl && (
          <EmptyState
            icon="🌐"
            title="粘贴或输入 URL 以打开网页。"
          />
        )}

        {/* 加载失败 / 证书错误 / 内置浏览器崩溃 */}
        {currentUrl && failure && (
          <div className="absolute inset-0 z-10 bg-panel">
            {failure.kind === 'cert' && (
              <EmptyState
                icon="🔒"
                title="该站点的 HTTPS 证书不受信任"
                description="如确认此地址可信，可在「设置 → 浏览器 → 安全」里开启「忽略证书校验」，再重启 App 后即可访问。"
                action={{ label: '重新加载', onClick: reload }}
              />
            )}
            {failure.kind === 'load' && (
              <EmptyState
                icon="⚠️"
                title="无法打开该页面"
                description={`页面加载失败：${failure.message}`}
                action={{ label: '重新加载', onClick: reload }}
              />
            )}
            {failure.kind === 'guest' && (
              <div className="flex flex-col items-center justify-center h-full text-center px-8 animate-fade-in">
                <span className="text-4xl mb-4">💥</span>
                <h3 className="text-base font-medium text-foreground mb-2">内置浏览器启动失败</h3>
                <p className="text-sm text-foreground/50 max-w-xs mb-2">
                  浏览器进程在显示页面前退出。检查系统环境后可以重试。
                </p>
                <p className="text-xs text-foreground/30 max-w-xs mb-4">
                  渲染进程：{failure.reason}（退出码 {failure.exitCode}）
                </p>
                <button
                  onClick={reload}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  重试浏览器
                </button>
              </div>
            )}
          </div>
        )}

        {/* webview 主体（key 触发重挂载 = 全新 guest 进程） */}
        {currentUrl && (
          <webview
            key={`${reloadSeq}:${currentUrl}`}
            ref={attach}
            src={currentUrl}
            className="absolute inset-0 w-full h-full"
          />
        )}
      </div>
    </div>
  )
}
