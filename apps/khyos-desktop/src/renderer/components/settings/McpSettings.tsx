import { useCallback, useEffect, useMemo, useState } from 'react'

// ── MCP 服务器 settings page (ZC-ALIGN-003 §2, a11y s-32) ──
// Two-tier structure: user-installed (top, from mcpStore via mcp:list —
// 新建/删除/启停/导入 all real) + plugin-hosted (bottom, derived live from
// plugin:list entries with components.mcp > 0; read-only status cards).
// ZC-ALIGN-001 P13: the static PLUGIN_SERVERS array is gone — every row and
// every button now goes through the real preload → main → store chain.

interface UserMcpServer {
  id: string
  name: string
  command: string
  enabled: boolean
  createdAt: number
}

interface PluginComponents {
  skills: number
  commands: number
  hooks: number
  mcp: number
  agents: number
  lsp: number
}

interface HostedPlugin {
  id: string
  name: string
  version: string
  description: string
  source: string
  enabled: boolean
  components: PluginComponents
}

interface KhyosMcpApi {
  mcpList?: () => Promise<{ ok: boolean; servers?: UserMcpServer[]; error?: string }>
  mcpCreate?: (input: { name: string; command: string; enabled?: boolean }) => Promise<{ ok: boolean; server?: UserMcpServer; error?: string }>
  mcpSetEnabled?: (id: string, enabled: boolean) => Promise<{ ok: boolean; server?: UserMcpServer; error?: string }>
  mcpDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>
  mcpImport?: (rows: unknown) => Promise<{ ok: boolean; created?: number; skipped?: number; error?: string }>
  pluginsList?: () => Promise<{ ok: boolean; plugins?: HostedPlugin[]; error?: string }>
}

function api(): KhyosMcpApi {
  return (window as unknown as { __KHYOS__?: KhyosMcpApi }).__KHYOS__ || {}
}

// settings.plugins.capability style summary — non-zero components only.
function capabilityLine(c: PluginComponents): string {
  const parts: string[] = []
  if (c.skills) parts.push(`${c.skills} 技能`)
  if (c.commands) parts.push(`${c.commands} 命令`)
  if (c.hooks) parts.push(`${c.hooks} Hooks`)
  if (c.mcp) parts.push(`${c.mcp} MCP`)
  return parts.join(' · ')
}

export function McpSettings() {
  const [servers, setServers] = useState<UserMcpServer[] | null>(null)
  const [plugins, setPlugins] = useState<HostedPlugin[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  // Scope filter: 用户 = user-created only; 全部 = also plugin-hosted cards.
  const [scopeAll, setScopeAll] = useState(false)
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
    if (!a.mcpList || !a.pluginsList) {
      setLoadError('MCP 数据不可用：preload 未注入 __KHYOS__，请重启应用')
      return
    }
    Promise.all([a.mcpList(), a.pluginsList()]).then(([mcpRes, pluginRes]) => {
      if (mcpRes?.ok && mcpRes.servers && pluginRes?.ok && pluginRes.plugins) {
        setServers(mcpRes.servers)
        setPlugins(pluginRes.plugins)
        setLoadError('')
      } else {
        setLoadError(mcpRes?.error || pluginRes?.error || 'MCP 列表读取失败：请重启应用后重试')
      }
    }).catch(() => {
      setLoadError('MCP 列表读取失败：主进程无响应，请重启应用')
    })
  }, [])

  useEffect(() => { load() }, [load])

  // Plugin-hosted MCP providers: live derivation from the plugin registry —
  // khyos-quant is the only seeded entry with mcp > 0, so the section shows 1
  // real card instead of the 3 previously fabricated ones.
  const hosted = useMemo(
    () => (plugins || []).filter((p) => p.components.mcp > 0),
    [plugins]
  )

  const q = search.trim().toLowerCase()
  const userRows = (servers || []).filter((s) => !q || s.name.toLowerCase().includes(q) || s.command.toLowerCase().includes(q))
  const hostedRows = scopeAll
    ? hosted.filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
    : []
  const totalCount = (servers?.length || 0) + hosted.length

  const handleCreate = useCallback(async (name: string, command: string) => {
    const a = api()
    setPendingAction(`保存 MCP 服务器 ${name.trim() || '…'}…`)
    try {
      const res = await a.mcpCreate?.({ name, command })
      if (res?.ok && res.server) {
        setCreating(false)
        flash(`已创建 MCP 服务器 ${res.server.name}`)
        load()
      } else {
        flash(res?.error || '创建失败：请检查名称与启动命令后重试', true)
      }
    } catch {
      flash('创建失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [flash, load])

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    const a = api()
    setPendingAction(`${enabled ? '启用' : '停用'} MCP 服务器…`)
    try {
      const res = await a.mcpSetEnabled?.(id, enabled)
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
    setPendingAction(`删除 MCP 服务器 ${name}…`)
    try {
      const res = await a.mcpDelete?.(id)
      if (!res?.ok) flash(res?.error || '删除失败：请重试', true)
      else { flash(`已删除 MCP 服务器 ${name}`); load() }
    } catch {
      flash('删除失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [flash, load])

  const handleImport = useCallback(async (text: string) => {
    const a = api()
    let rows: unknown
    try {
      rows = JSON.parse(text)
    } catch {
      flash('导入失败：剪贴板内容不是合法 JSON，请复制 [{name, command}] 形式后重试', true)
      return
    }
    setPendingAction('导入 MCP 服务器配置…')
    try {
      const res = await a.mcpImport?.(rows)
      if (res?.ok) {
        setImporting(false)
        flash(`导入完成：新增 ${res.created ?? 0} 台，跳过 ${res.skipped ?? 0} 台（无效或重名）`)
        load()
      } else {
        flash(res?.error || '导入失败：请检查 JSON 内容后重试', true)
      }
    } catch {
      flash('导入失败：主进程无响应，请重启应用', true)
    } finally {
      setPendingAction('')
    }
  }, [flash, load])

  return (
    <div className="max-w-3xl">
      {/* ── Header: scope + count + search ── */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-foreground">MCP</span>
          <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-brand/15 text-brand">
            {totalCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setScopeAll(!scopeAll)}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors flex items-center gap-1.5 ${
              scopeAll ? 'bg-selected text-foreground' : 'text-foreground/70 hover:text-foreground hover:bg-surface-hover'
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 4h8M2 8h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <circle cx="9" cy="4" r="1.2" fill="currentColor" />
              <circle cx="3" cy="8" r="1.2" fill="currentColor" />
            </svg>
            {scopeAll ? '全部' : '用户'}
          </button>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 MCP 服务器…"
            className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused w-56"
          />
        </div>
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

      {/* ── User-installed section (mcpStore real data) ── */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-foreground/70">
            已安装 <span className="text-foreground/40">{servers ? servers.length : '…'}</span>
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
            <button
              onClick={() => setImporting(true)}
              className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
            >
              更多操作
            </button>
          </div>
        </div>
        {servers === null && !loadError ? (
          <div className="bg-card border border-card-border rounded-xl p-8 text-center text-sm text-foreground/50">
            读取 MCP 服务器列表中…
          </div>
        ) : userRows.length === 0 ? (
          <div className="bg-card border border-card-border rounded-xl p-8 text-center">
            <p className="text-sm text-foreground/50 mb-2">
              {search ? '没有匹配搜索的服务器' : '尚未安装 MCP 服务器'}
            </p>
            <p className="text-xs text-foreground/40">手动新建服务器，或导入已有配置。</p>
          </div>
        ) : (
          <div className="space-y-3">
            {userRows.map((server) => (
              <UserServerCard
                key={server.id}
                server={server}
                onToggle={handleToggle}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Plugin-hosted section (plugin:list derivation, read-only cards) ── */}
      {(scopeAll || !search) && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm font-medium text-foreground/70">插件宿主</span>
            <span className="text-xs text-foreground/40">由插件提供（components.mcp &gt; 0），随插件启停</span>
          </div>
          {plugins === null && !loadError ? (
            <div className="bg-card border border-card-border rounded-xl p-8 text-center text-sm text-foreground/50">
              读取插件宿主列表中…
            </div>
          ) : hostedRows.length === 0 && scopeAll ? (
            <div className="bg-card border border-card-border rounded-xl p-6 text-center text-sm text-foreground/50">
              暂无插件提供 MCP 服务器（安装含 MCP 组件的插件后自动出现在此）。
            </div>
          ) : hostedRows.length > 0 ? (
            <div className="space-y-3">
              {hostedRows.map((plugin) => (
                <PluginServerCard
                  key={plugin.id}
                  plugin={plugin}
                  expanded={detailId === plugin.id}
                  onDetail={() => setDetailId(detailId === plugin.id ? null : plugin.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* ── Bottom action row ── */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={() => setCreating(true)}
          className="px-4 py-2 text-sm font-medium rounded-lg transition-colors border border-brand/30 text-brand hover:bg-brand/10"
        >
          新建 MCP 服务器
        </button>
        <button
          onClick={() => setImporting(true)}
          className="px-4 py-2 text-sm font-medium rounded-lg transition-colors border border-card-border text-foreground/70 hover:text-foreground hover:bg-surface-hover"
        >
          导入
        </button>
        {pendingAction && (
          <span className="text-xs text-foreground/50">{pendingAction}</span>
        )}
      </div>

      {/* ── 新建 dialog ── */}
      {creating && (
        <CreateServerDialog
          onClose={() => setCreating(false)}
          onSubmit={handleCreate}
        />
      )}

      {/* ── 导入 dialog ── */}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onSubmit={handleImport}
        />
      )}
    </div>
  )
}

// ── User-installed server card (mcpStore row) ──
function UserServerCard({ server, onToggle, onDelete }: {
  server: UserMcpServer
  onToggle: (id: string, enabled: boolean) => void
  onDelete: (id: string, name: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  return (
    <div className="bg-card border border-card-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${server.enabled ? 'bg-success' : 'bg-foreground/30'}`} />
            <span className="text-sm font-mono font-medium text-foreground">{server.name}</span>
            <span className="px-1.5 py-0.5 text-xs rounded bg-surface text-foreground/50">用户</span>
          </div>
          <p className="text-xs text-foreground/50 font-mono truncate" title={server.command}>{server.command}</p>
          {confirmDelete && (
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span className="text-foreground/60">删除后不可恢复，确认删除？</span>
              <button
                onClick={() => onDelete(server.id, server.name)}
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
            onClick={() => onToggle(server.id, !server.enabled)}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              server.enabled ? 'bg-brand' : 'bg-foreground/20'
            }`}
            role="switch"
            aria-checked={server.enabled}
            aria-label={`${server.enabled ? '停用' : '启用'} ${server.name}`}
          >
            <span
              className={`absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                server.enabled ? 'translate-x-4' : 'translate-x-0'
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

// ── Plugin-hosted server card (derived from plugin:list, a11y s-32 shape) ──
function PluginServerCard({ plugin, expanded, onDetail }: {
  plugin: HostedPlugin
  expanded: boolean
  onDetail: () => void
}) {
  return (
    <div className="bg-card border border-card-border rounded-xl p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Plugin name + status dot + capability + mcp count */}
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${plugin.enabled ? 'bg-success' : 'bg-foreground/30'}`} />
            <span className="text-sm font-mono font-medium text-foreground">{plugin.name}</span>
            <span className="text-xs text-foreground/50">{capabilityLine(plugin.components)}</span>
            <span className="px-1.5 py-0.5 text-xs rounded bg-surface text-foreground/50">{plugin.components.mcp}</span>
          </div>
          {/* Status text (real plugin state, not fabricated plan flags) */}
          <p className="text-xs text-foreground/50 leading-relaxed">
            {plugin.enabled
              ? `该 MCP 服务器由已启用的插件提供（v${plugin.version}），运行时身份由宿主管理。`
              : `提供方插件已停用（v${plugin.version}）：在「插件」页启用后此服务器恢复可用。`}
          </p>
          {expanded && (
            <div className="mt-2 text-xs text-foreground/60 leading-relaxed border-t border-card-border pt-2">
              {plugin.description}
            </div>
          )}
        </div>
        {/* 详情 button */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onDetail}
            className="px-2 py-1 text-xs text-foreground/60 hover:text-foreground hover:bg-surface-hover rounded transition-colors"
          >
            {expanded ? '收起' : '详情'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 新建 dialog: name + stdio command / http URL ──
function CreateServerDialog({ onClose, onSubmit }: {
  onClose: () => void
  onSubmit: (name: string, command: string) => void
}) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')

  const valid = name.trim().length > 0 && command.trim().length > 0
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        <div className="px-6 py-4 border-b border-popover-border">
          <h3 className="text-base font-semibold text-popover-foreground">新建 MCP 服务器</h3>
          <p className="text-xs text-foreground/50 mt-1">stdio 启动命令或 http(s) URL，保存后在本页管理</p>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-1 block">名称</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如 filesystem"
              className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-foreground/70 mb-1 block">启动命令 / URL</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="例如 npx -y @modelcontextprotocol/server-filesystem"
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
            onClick={() => onSubmit(name, command)}
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

// ── 导入 dialog: paste JSON array [{name, command}] ──
function ImportDialog({ onClose, onSubmit }: {
  onClose: () => void
  onSubmit: (text: string) => void
}) {
  const [text, setText] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-popover border border-popover-border rounded-2xl shadow-2xl overflow-hidden animate-slide-down">
        <div className="px-6 py-4 border-b border-popover-border">
          <h3 className="text-base font-semibold text-popover-foreground">导入 MCP 服务器</h3>
          <p className="text-xs text-foreground/50 mt-1">粘贴 JSON 数组，形如 [{`{ "name": "…", "command": "…" }`}]</p>
        </div>
        <div className="px-6 py-4">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder='[{"name":"filesystem","command":"npx -y @modelcontextprotocol/server-filesystem"}]'
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
