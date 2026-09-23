import { useCallback, useEffect, useState } from 'react'

// ── 索引库 settings page (Pattern B variant, ZC-ALIGN-001 P13) ──
// Real workspace index registry via indexList/create/rebuild/setEnabled/delete
// (preload → main → indexStore). Stats are read from disk at scan time — no
// fabricated counts; 重建 rescan is honest, not a fake refresh.

interface CodeIndex {
  id: string
  name: string
  root: string
  fileCount: number
  totalBytes: number
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface KhyosIndexApi {
  indexList?: () => Promise<{ ok: boolean; indexes?: CodeIndex[]; error?: string }>
  indexCreate?: (input: { name?: string; root?: string }) => Promise<{ ok: boolean; index?: CodeIndex; error?: string }>
  indexRebuild?: (id: string) => Promise<{ ok: boolean; index?: CodeIndex; error?: string }>
  indexSetEnabled?: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  indexDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>
}

function api(): KhyosIndexApi {
  return (window as unknown as { __KHYOS__?: KhyosIndexApi }).__KHYOS__ || {}
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

export function IndexSettingsPage() {
  const [indexes, setIndexes] = useState<CodeIndex[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const [pendingAction, setPendingAction] = useState('')
  const [creating, setCreating] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)

  const flash = useCallback((msg: string, isError = false) => {
    setNotice(msg)
    setNoticeError(isError)
    if (msg) {
      setTimeout(() => { setNotice('') }, 4000)
    }
  }, [])

  const load = useCallback(() => {
    const a = api()
    if (!a.indexList) {
      setLoadError('索引库数据不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    a.indexList().then((res) => {
      if (res?.ok && res.indexes) {
        setIndexes(res.indexes)
        setLoadError('')
      } else {
        setLoadError(res?.error || '索引库读取失败：请重启应用后重试')
      }
    }).catch(() => {
      setLoadError('索引库读取失败：主进程无响应，请重启应用')
    })
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreate = useCallback(async (name: string, root: string) => {
    const a = api()
    setPendingAction(`索引 ${name.trim() || '当前工作区'}（单次扫描）…`)
    try {
      const res = await a.indexCreate?.({ name, root })
      if (res?.ok && res.index) {
        setCreating(false)
        flash(`已创建索引 ${res.index.name}（${res.index.fileCount} 个文件）`)
        load()
      } else {
        flash(res?.error || '创建索引失败：请确认工作区可读后重试', true)
      }
    } catch {
      flash('创建索引失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [flash, load])

  const handleRebuild = useCallback(async (id: string, name: string) => {
    const a = api()
    setPendingAction(`重建索引 ${name}（单次扫描）…`)
    try {
      const res = await a.indexRebuild?.(id)
      if (res?.ok && res.index) {
        flash(`已重建索引 ${name}（${res.index.fileCount} 个文件）`)
        load()
      } else {
        flash(res?.error || '重建失败：请重试', true)
      }
    } catch {
      flash('重建失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [flash, load])

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    const a = api()
    setPendingAction(`${enabled ? '启用' : '停用'}索引…`)
    try {
      const res = await a.indexSetEnabled?.(id, enabled)
      if (!res?.ok) flash(res?.error || '切换失败：请重试', true)
      else load()
    } catch {
      flash('切换失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [flash, load])

  const handleDelete = useCallback(async (id: string, name: string) => {
    const a = api()
    setPendingAction(`删除索引 ${name}…`)
    try {
      const res = await a.indexDelete?.(id)
      if (!res?.ok) flash(res?.error || '删除失败：请重试', true)
      else { flash(`已删除索引 ${name}`); load() }
    } catch {
      flash('删除失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [flash, load])

  return (
    <div className="max-w-3xl">
      {/* ── Header: count + refresh ── */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-foreground">索引库</span>
          <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-brand/15 text-brand">
            {indexes ? indexes.length : '…'}
          </span>
        </div>
        <button
          onClick={load}
          className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
        >
          刷新
        </button>
      </div>

      {loadError && (
        <div className="mb-4 px-4 py-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl">
          {loadError}
        </div>
      )}
      {notice && (
        <div className={`mb-4 px-4 py-3 text-sm rounded-xl border ${
          noticeError
            ? 'text-destructive bg-destructive/10 border-destructive/20'
            : 'text-foreground/70 bg-surface border-card-border'
        }`}>
          {notice}
        </div>
      )}

      {/* ── Index list ── */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-foreground/70">
            已建立 <span className="text-foreground/40">{indexes ? indexes.length : '…'}</span>
          </span>
        </div>
        {indexes === null && !loadError ? (
          <div className="bg-card border border-card-border rounded-xl p-8 text-center text-sm text-foreground/50">
            读取索引库中…
          </div>
        ) : (indexes || []).length === 0 ? (
          <div className="bg-card border border-card-border rounded-xl p-8 text-center">
            <p className="text-sm text-foreground/50 mb-2">尚未建立索引</p>
            <p className="text-xs text-foreground/40">为当前工作区建立索引，增强 Agent 的代码理解能力。</p>
          </div>
        ) : (
          <div className="space-y-3">
            {(indexes || []).map((ix) => (
              <div key={ix.id} className="bg-card border border-card-border rounded-xl p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ix.enabled ? 'bg-success' : 'bg-foreground/30'}`} />
                      <span className="text-sm font-medium text-foreground">{ix.name}</span>
                    </div>
                    <p className="text-xs text-foreground/50">
                      {ix.fileCount} 个文件 · {fmtBytes(ix.totalBytes)}
                      {!ix.enabled && ' · 已停用'}
                    </p>
                    {detailId === ix.id && (
                      <p className="mt-2 text-xs text-foreground/40 font-mono break-all">{ix.root}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => setDetailId(detailId === ix.id ? null : ix.id)}
                      className="px-2 py-1 text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover rounded transition-colors"
                    >
                      {detailId === ix.id ? '收起' : '详情'}
                    </button>
                    <button
                      onClick={() => handleRebuild(ix.id, ix.name)}
                      className="px-2 py-1 text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover rounded transition-colors"
                    >
                      重建
                    </button>
                    <button
                      onClick={() => handleToggle(ix.id, !ix.enabled)}
                      className={`relative w-9 h-5 rounded-full transition-colors ${
                        ix.enabled ? 'bg-brand' : 'bg-foreground/20'
                      }`}
                      role="switch"
                      aria-checked={ix.enabled}
                      aria-label={`${ix.enabled ? '停用' : '启用'}索引 ${ix.name}`}
                    >
                      <span
                        className={`absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                          ix.enabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                    <button
                      onClick={() => handleDelete(ix.id, ix.name)}
                      className="px-2 py-1 text-xs text-foreground/60 hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Bottom action row ── */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 text-sm font-medium rounded-lg transition-colors border border-brand/30 text-brand hover:bg-brand/10"
        >
          为当前工作区建立索引
        </button>
        {pendingAction && (
          <span className="text-xs text-foreground/50">{pendingAction}</span>
        )}
      </div>

      {creating && (
        <CreateIndexDialog
          onClose={() => setCreating(false)}
          onSubmit={handleCreate}
        />
      )}
    </div>
  )
}

// ── 新建索引 dialog: name + root（默认当前工作区）──
function CreateIndexDialog({ onClose, onSubmit }: {
  onClose: () => void
  onSubmit: (name: string, root: string) => void
}) {
  const [name, setName] = useState('')
  const [root, setRoot] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        <div className="px-6 py-4 border-b border-popover-border">
          <h3 className="text-base font-semibold text-popover-foreground">新建索引</h3>
          <p className="text-xs text-foreground/50 mt-1">默认索引当前工作区；可自定义名称</p>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-1 block">名称（可选）</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="默认：当前工作区"
              className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-1 block">工作区根目录（可选）</label>
            <input
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="留空 = 当前工作区"
              className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm font-mono text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
            />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-popover-border flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-foreground/60 hover:text-foreground rounded-lg hover:bg-surface-hover transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onSubmit(name, root)}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:opacity-90 transition-opacity"
          >
            扫描并建立
          </button>
        </div>
      </div>
    </div>
  )
}
