import { useCallback, useEffect, useState } from 'react'

// ── OnboardingDialog (ZC-ALIGN-003 §1 D5, a11y s-8) ──
// The welcome dialog ZCode shows on first run, reopenable from 设置→引导→
// 打开引导 (and 常规 page's identical row). Three-part contract:
//   1. 欢迎使用 KhyOS headline
//   2. 数据迁移向导 — REAL counts scanned from Claude Code / Cursor / Codex
//      config dirs via migration:scan; 导入 buttons copy definitions into
//      agent_items.json via migration:import (both hop preload → main → store)
//   3. 开始使用 KhyOS button — closes the dialog
// Opens on the `khy:open-onboarding` window event (same pattern as
// khy:open-command-center), so any settings page can trigger it without prop
// drilling.

interface MigrationCount {
  label: string
  count: number
}

interface MigrationSourceView {
  id: string
  label: string
  found: boolean
  counts: MigrationCount[]
}

interface KhyosOnboardingApi {
  migrationScan?: () => Promise<{ ok: boolean; sources?: MigrationSourceView[]; error?: string }>
  migrationImport?: (sourceId: string) => Promise<{ ok: boolean; created?: number; skipped?: number; error?: string }>
  getDataHome?: () => Promise<string>
}

function onboardingApi(): KhyosOnboardingApi {
  return (window as unknown as { __KHYOS__?: KhyosOnboardingApi }).__KHYOS__ || {}
}

export function OnboardingDialog() {
  const [visible, setVisible] = useState(false)
  const [sources, setSources] = useState<MigrationSourceView[] | null>(null)
  const [scanError, setScanError] = useState('')
  const [imported, setImported] = useState<Record<string, string>>({})
  const [importingId, setImportingId] = useState('')
  const [dataHome, setDataHome] = useState('')

  const runScan = useCallback(() => {
    const api = onboardingApi()
    if (!api.migrationScan) {
      setScanError('迁移检测不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    api.migrationScan().then((res) => {
      if (res?.ok && res.sources) {
        setSources(res.sources)
        setScanError('')
      } else {
        setScanError(res?.error || '迁移检测失败：请重启应用后重试')
      }
    }).catch(() => {
      setScanError('迁移检测失败：主进程无响应，请重启应用')
    })
  }, [])

  useEffect(() => {
    const onOpen = () => setVisible(true)
    window.addEventListener('khy:open-onboarding', onOpen)
    return () => window.removeEventListener('khy:open-onboarding', onOpen)
  }, [])

  // Scan on first open + data home for the storage hint (read-only, real).
  useEffect(() => {
    if (!visible) return
    runScan()
    const api = onboardingApi()
    api.getDataHome?.().then((p) => {
      if (typeof p === 'string' && p) setDataHome(p)
    }).catch(() => {})
  }, [visible, runScan])

  const handleImport = useCallback(async (sourceId: string, label: string) => {
    const api = onboardingApi()
    setImportingId(sourceId)
    try {
      const res = await api.migrationImport?.(sourceId)
      if (res?.ok) {
        setImported((prev) => ({
          ...prev,
          [sourceId]: `已导入 ${res.created ?? 0} 项${res.skipped ? `，跳过 ${res.skipped} 项（重名或无效）` : ''}`,
        }))
      } else {
        setImported((prev) => ({ ...prev, [sourceId]: res?.error || `导入 ${label} 失败：请重试` }))
      }
    } catch {
      setImported((prev) => ({ ...prev, [sourceId]: `导入 ${label} 失败：主进程无响应，请重启应用` }))
    } finally {
      setImportingId('')
    }
  }, [])

  const close = () => {
    setVisible(false)
    // Reset transient state so reopening rescans fresh counts.
    setSources(null)
    setImported({})
    setScanError('')
  }

  if (!visible) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-full max-w-lg bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        {/* 头部：欢迎使用 ZCode */}
        <div className="px-8 pt-8 pb-5">
          <h2 className="text-2xl font-bold text-popover-foreground">欢迎使用 ZCode</h2>
          <p className="text-sm text-foreground/50 mt-2 leading-relaxed">
            你的 AI 编码搭档。可以先从其他 Agent 迁移数据，也可以直接开始使用。
          </p>
        </div>

        {/* 数据迁移向导 */}
        <div className="px-8 pb-4">
          <h3 className="text-sm font-semibold text-foreground mb-3">数据迁移向导</h3>
          {scanError ? (
            <div className="px-4 py-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl">
              {scanError}
            </div>
          ) : sources === null ? (
            <div className="px-4 py-3 text-sm text-foreground/50 bg-surface border border-card-border rounded-xl">
              正在检测本机 Claude Code / Cursor / Codex 配置…
            </div>
          ) : (
            <div className="space-y-2">
              {sources.map((src) => {
                const total = src.counts.reduce((sum, c) => sum + c.count, 0)
                const summary = src.found
                  ? (src.counts.filter((c) => c.count > 0).map((c) => `${c.label} ${c.count}`).join(' · ')
                    || '未发现可迁移项')
                  : '未检测到安装'
                const done = imported[src.id]
                return (
                  <div
                    key={src.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 bg-card border border-card-border rounded-xl"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground">{src.label}</div>
                      <div className="text-xs text-foreground/50 mt-0.5">
                        {done ? done : summary}
                      </div>
                    </div>
                    {src.found && total > 0 && !done && (
                      <button
                        onClick={() => handleImport(src.id, src.label)}
                        disabled={importingId === src.id}
                        className="px-3 py-1.5 text-sm rounded-lg border border-brand/30 text-brand hover:bg-brand/10 disabled:opacity-50 transition-colors flex-shrink-0"
                      >
                        {importingId === src.id ? '导入中…' : '导入'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {dataHome && (
            <p className="text-xs text-foreground/40 mt-3 leading-relaxed">
              迁移后的数据存储于 {dataHome}
            </p>
          )}
        </div>

        {/* 底部：开始使用 ZCode */}
        <div className="px-8 py-5 border-t border-popover-border flex items-center justify-end">
          <button
            onClick={close}
            className="px-6 py-2.5 bg-brand text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            开始使用 ZCode
          </button>
        </div>
      </div>
    </div>
  )
}
