import { useCallback, useEffect, useState } from 'react'

// ── Reusable list settings page (Pattern B, ZC-ALIGN-003 §2 → P13 真实化) ──
// Covers: 命令/钩子/技能/子智能体/记忆 — all backed by agentItemStore via
// agent:list/create/setEnabled/delete/import (preload → main → store 正门).
// The previous static empty-state version is gone: every button now responds.
// a11y evidence: s-32 (MCP), s-38 (命令) — identical structure.

interface AgentItem {
  id: string
  kind: string
  name: string
  description: string
  content: string
  enabled: boolean
  source: string
  createdAt: number
  updatedAt: number
}

interface KhyosAgentApi {
  agentList?: (kind: string) => Promise<{ ok: boolean; items?: AgentItem[]; error?: string }>
  agentCreate?: (kind: string, input: { name: string; description?: string; content?: string }) =>
    Promise<{ ok: boolean; item?: AgentItem; error?: string }>
  agentSetEnabled?: (kind: string, id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
  agentDelete?: (kind: string, id: string) => Promise<{ ok: boolean; error?: string }>
  agentImport?: (kind: string, rows: unknown) => Promise<{ ok: boolean; created?: number; skipped?: number; error?: string }>
}

function api(): KhyosAgentApi {
  return (window as unknown as { __KHYOS__?: KhyosAgentApi }).__KHYOS__ || {}
}

interface ListSettingsPageProps {
  kind: string               // agentItemStore kind: command/hook/skill/subagent/memory
  noun: string               // e.g. '命令', '钩子', '技能'
  description: string        // empty-state hint
  importable?: boolean       // show 导入 button (default true)
  // Field labels for the 新建 form (e.g. 命令内容 / 钩子脚本 / 记忆内容)
  contentLabel: string
  contentPlaceholder?: string
}

export function ListSettingsPage({
  kind,
  noun,
  description,
  importable = true,
  contentLabel,
  contentPlaceholder,
}: ListSettingsPageProps) {
  const [items, setItems] = useState<AgentItem[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const [pendingAction, setPendingAction] = useState('')

  const flash = useCallback((msg: string, isError = false) => {
    setNotice(msg)
    setNoticeError(isError)
    if (msg) {
      setTimeout(() => { setNotice('') }, 4000)
    }
  }, [])

  const load = useCallback(() => {
    const a = api()
    if (!a.agentList) {
      setLoadError(`${noun}数据不可用：preload 未注入 __KHYOS__，请重启应用`)
      return
    }
    a.agentList(kind).then((res) => {
      if (res?.ok && res.items) {
        setItems(res.items)
        setLoadError('')
      } else {
        setLoadError(res?.error || `${noun}列表读取失败：请重启应用后重试`)
      }
    }).catch(() => {
      setLoadError(`${noun}列表读取失败：主进程无响应，请重启应用`)
    })
  }, [kind, noun])

  useEffect(() => { load() }, [load])

  const q = search.trim().toLowerCase()
  const rows = (items || []).filter((it) => !q || it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q))

  const handleCreate = useCallback(async (name: string, description: string, content: string) => {
    const a = api()
    setPendingAction(`保存${noun} ${name.trim() || '…'}…`)
    try {
      const res = await a.agentCreate?.(kind, { name, description, content })
      if (res?.ok && res.item) {
        setCreating(false)
        flash(`已创建${noun} ${res.item.name}`)
        load()
      } else {
        flash(res?.error || `创建失败：请检查名称后重试`, true)
      }
    } catch {
      flash(`创建失败：主进程无响应，请重启应用`, true)
    } finally {
      setPendingAction('')
    }
  }, [kind, noun, flash, load])

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    const a = api()
    setPendingAction(`${enabled ? '启用' : '停用'}${noun}…`)
    try {
      const res = await a.agentSetEnabled?.(kind, id, enabled)
      if (!res?.ok) flash(res?.error || '切换失败：请重试', true)
      else load()
    } catch {
      flash('切换失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [kind, noun, flash, load])

  const handleDelete = useCallback(async (id: string, name: string) => {
    const a = api()
    setPendingAction(`删除${noun} ${name}…`)
    try {
      const res = await a.agentDelete?.(kind, id)
      if (!res?.ok) flash(res?.error || '删除失败：请重试', true)
      else { flash(`已删除${noun} ${name}`); load() }
    } catch {
      flash('删除失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [kind, noun, flash, load])

  const handleImport = useCallback(async (text: string) => {
    const a = api()
    let rows: unknown
    try {
      rows = JSON.parse(text)
    } catch {
      flash(`导入失败：内容不是合法 JSON，请复制 [{name, ${contentLabel}}] 形式后重试`, true)
      return
    }
    setPendingAction(`导入${noun}…`)
    try {
      const res = await a.agentImport?.(kind, rows)
      if (res?.ok) {
        setImporting(false)
        flash(`导入完成：新增 ${res.created ?? 0} 项，跳过 ${res.skipped ?? 0} 项（无效或重名）`)
        load()
      } else {
        flash(res?.error || '导入失败：请检查 JSON 内容后重试', true)
      }
    } catch {
      flash('导入失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [kind, noun, contentLabel, flash, load])

  return (
    <div className="max-w-3xl">
      {/* ── Header: count + search ── */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-foreground">{noun}</span>
          <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-brand/15 text-brand">
            {items ? items.length : '…'}
          </span>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`搜索${noun}…`}
          className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused w-56"
        />
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

      {/* ── Installed section ── */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-foreground/70">
            已安装 <span className="text-foreground/40">{items ? items.length : '…'}</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCreating(true)}
              className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
            >
              新建
            </button>
            <button
              onClick={load}
              className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
            >
              刷新
            </button>
            {importable && (
              <button
                onClick={() => setImporting(true)}
                className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
              >
                更多操作
              </button>
            )}
          </div>
        </div>
        {items === null && !loadError ? (
          <div className="bg-card border border-card-border rounded-xl p-8 text-center text-sm text-foreground/50">
            读取{noun}列表中…
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-card border border-card-border rounded-xl p-8 text-center">
            <p className="text-sm text-foreground/50 mb-2">
              {search ? `没有匹配搜索的${noun}` : `尚未安装${noun}`}
            </p>
            <p className="text-xs text-foreground/40">{description}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                noun={noun}
                expanded={detailId === item.id}
                onDetail={() => setDetailId(detailId === item.id ? null : item.id)}
                onToggle={handleToggle}
                onDelete={handleDelete}
              />
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
          新建{noun}
        </button>
        {importable && (
          <button
            onClick={() => setImporting(true)}
            className="px-4 py-2 text-sm font-medium rounded-lg transition-colors border border-card-border text-foreground/70 hover:text-foreground hover:bg-surface-hover"
          >
            导入
          </button>
        )}
        {pendingAction && (
          <span className="text-xs text-foreground/50">{pendingAction}</span>
        )}
      </div>

      {creating && (
        <CreateItemDialog
          noun={noun}
          contentLabel={contentLabel}
          contentPlaceholder={contentPlaceholder}
          onClose={() => setCreating(false)}
          onSubmit={handleCreate}
        />
      )}
      {importing && (
        <ImportTextDialog
          noun={noun}
          contentLabel={contentLabel}
          onClose={() => setImporting(false)}
          onSubmit={handleImport}
        />
      )}
    </div>
  )
}

// ── Item row card ──
function ItemCard({ item, noun, expanded, onDetail, onToggle, onDelete }: {
  item: AgentItem
  noun: string
  expanded: boolean
  onDetail: () => void
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string, name: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const imported = item.source.startsWith('imported:')
  return (
    <div className="bg-card border border-card-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${item.enabled ? 'bg-success' : 'bg-foreground/30'}`} />
            <span className="text-sm font-mono font-medium text-foreground">{item.name}</span>
            {imported && (
              <span className="px-1.5 py-0.5 text-xs rounded bg-surface text-foreground/50">已导入</span>
            )}
          </div>
          {item.description && (
            <p className="text-xs text-foreground/50">{item.description}</p>
          )}
          {expanded && item.content && (
            <pre className="mt-2 p-3 bg-surface border border-card-border rounded-lg text-xs text-foreground/70 whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
              {item.content}
            </pre>
          )}
          {confirmDelete && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-foreground/60">删除后不可恢复，确认删除？</span>
              <button
                onClick={() => onDelete(item.id, item.name)}
                className="px-2 py-1 rounded bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
              >
                确认删除
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1 rounded text-foreground/60 hover:text-foreground transition-colors"
              >
                取消
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onDetail}
            className="px-2 py-1 text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover rounded transition-colors"
          >
            {expanded ? '收起' : '详情'}
          </button>
          <button
            onClick={() => onToggle(item.id, !item.enabled)}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              item.enabled ? 'bg-brand' : 'bg-foreground/20'
            }`}
            role="switch"
            aria-checked={item.enabled}
            aria-label={`${item.enabled ? '停用' : '启用'}${noun} ${item.name}`}
          >
            <span
              className={`absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                item.enabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
          <button
            onClick={() => setConfirmDelete(true)}
            className="px-2 py-1 text-xs text-foreground/60 hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 新建 dialog: name + description + content ──
function CreateItemDialog({ noun, contentLabel, contentPlaceholder, onClose, onSubmit }: {
  noun: string
  contentLabel: string
  contentPlaceholder?: string
  onClose: () => void
  onSubmit: (name: string, description: string, content: string) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')

  const valid = name.trim().length > 0
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        <div className="px-6 py-4 border-b border-popover-border">
          <h3 className="text-base font-semibold text-popover-foreground">新建{noun}</h3>
          <p className="text-xs text-foreground/50 mt-1">名称必填，保存后在本页管理</p>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-1 block">名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`例如 my-${noun}`}
              className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-1 block">描述（可选）</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话说明用途"
              className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-1 block">{contentLabel}（可选）</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              placeholder={contentPlaceholder || `在此填写${noun}内容`}
              className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm font-mono text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused resize-none"
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
            onClick={() => onSubmit(name, description, content)}
            disabled={!valid}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 导入 dialog: paste JSON array [{name, content}] ──
function ImportTextDialog({ noun, contentLabel, onClose, onSubmit }: {
  noun: string
  contentLabel: string
  onClose: () => void
  onSubmit: (text: string) => void
}) {
  const [text, setText] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        <div className="px-6 py-4 border-b border-popover-border">
          <h3 className="text-base font-semibold text-popover-foreground">导入{noun}</h3>
          <p className="text-xs text-foreground/50 mt-1">粘贴 JSON 数组，形如 [{`{ "name": "…", "content": "…" }`}]</p>
        </div>
        <div className="px-6 py-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={`[{"name":"my-item","content":"${contentLabel}内容"}]`}
            className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm font-mono text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused resize-none"
          />
        </div>
        <div className="px-6 py-4 border-t border-popover-border flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-foreground/60 hover:text-foreground rounded-lg hover:bg-surface-hover transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onSubmit(text)}
            disabled={!text.trim()}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            导入
          </button>
        </div>
      </div>
    </div>
  )
}
