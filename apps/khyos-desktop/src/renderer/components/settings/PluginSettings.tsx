// PluginSettings — 设置页「插件」(ZC-ALIGN-003 §2). Two tabs 已安装/发现,
// row toggles, 检查更新/刷新 header actions, detail pane, uninstall confirm.
// UI copy mirrors ZCode's settings.plugins.* i18n bundle verbatim.
// All state comes from pluginStore via preload __KHYOS__ → main IPC — no mocks.

import { useCallback, useEffect, useMemo, useState } from 'react'

interface PluginComponents {
  skills: number
  commands: number
  hooks: number
  mcp: number
  agents: number
  lsp: number
}

interface Plugin {
  id: string
  name: string
  version: string
  description: string
  source: string
  enabled: boolean
  installedAt: number
  installPath: string
  updateAvailable?: boolean
  components: PluginComponents
}

interface KhyosPluginsApi {
  pluginsList?: () => Promise<{ ok: boolean; plugins?: Plugin[]; error?: string }>
  pluginsInstall?: (input: Record<string, unknown>) => Promise<{ ok: boolean; plugin?: Plugin; error?: string }>
  pluginsSetEnabled?: (id: string, enabled: boolean) => Promise<{ ok: boolean; plugin?: Plugin; error?: string }>
  pluginsUninstall?: (id: string) => Promise<{ ok: boolean; error?: string }>
  pluginsCheckUpdates?: () => Promise<{ ok: boolean; count?: number; error?: string }>
}

function api(): KhyosPluginsApi {
  return (window as unknown as { __KHYOS__?: KhyosPluginsApi }).__KHYOS__ || {}
}

// settings.plugins.capability: {skills} 技能 · {commands} 命令 · {hooks} Hooks · {mcp} MCP
// ZCode only surfaces non-zero component counts in the row summary.
function capabilityLine(c: PluginComponents): string {
  const parts: string[] = []
  if (c.skills) parts.push(`${c.skills} 技能`)
  if (c.commands) parts.push(`${c.commands} 命令`)
  if (c.hooks) parts.push(`${c.hooks} Hooks`)
  if (c.mcp) parts.push(`${c.mcp} MCP`)
  return parts.join(' · ')
}

// settings.plugins.detail.component.* labels for the detail pane
const COMPONENT_LABEL: { key: keyof PluginComponents; label: string }[] = [
  { key: 'skills', label: '技能' },
  { key: 'commands', label: '命令' },
  { key: 'hooks', label: 'Hooks' },
  { key: 'mcp', label: 'MCP 服务器' },
  { key: 'agents', label: 'Agents' },
  { key: 'lsp', label: 'LSP 服务器' },
]

// settings.plugins.detail.component.unknown fallback when nothing is declared
const NO_COMPONENTS = '暂无组件信息'

export function PluginSettings() {
  const [tab, setTab] = useState<'installed' | 'marketplace'>('installed')
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [noticeError, setNoticeError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [checking, setChecking] = useState(false)
  // Per-row pending toggles so the switch shows 正在更新 {plugin}… state
  const [pendingToggle, setPendingToggle] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)

  const flash = useCallback((msg: string, isError = false) => {
    setNotice(msg)
    setNoticeError(isError)
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const res = await api().pluginsList?.()
    if (res?.ok) {
      setPlugins(res.plugins || [])
    } else {
      flash(res?.error || '插件列表读取失败：请重启应用后重试', true)
    }
    setRefreshing(false)
  }, [flash])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return plugins
    return plugins.filter(
      (p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    )
  }, [plugins, search])

  const enabledCount = plugins.filter((p) => p.enabled).length
  const selected = plugins.find((p) => p.id === selectedId) || null

  const toggleEnabled = useCallback(
    async (p: Plugin) => {
      setPendingToggle(p.id)
      const res = await api().pluginsSetEnabled?.(p.id, !p.enabled)
      setPendingToggle(null)
      if (res?.ok) {
        flash(!p.enabled ? `已启用 ${p.name}` : `已停用 ${p.name}`)
        await refresh()
      } else {
        flash(res?.error || `无法更新 ${p.name}，请重试。`, true)
      }
    },
    [flash, refresh]
  )

  const doUninstall = useCallback(
    async (p: Plugin) => {
      const res = await api().pluginsUninstall?.(p.id)
      if (res?.ok) {
        setConfirmUninstall(null)
        if (selectedId === p.id) setSelectedId(null)
        flash(`已卸载 ${p.name}`)
        await refresh()
      } else {
        flash(res?.error || `无法卸载 ${p.name}，请重试。`, true)
      }
    },
    [flash, refresh, selectedId]
  )

  const checkUpdates = useCallback(async () => {
    setChecking(true)
    const res = await api().pluginsCheckUpdates?.()
    setChecking(false)
    if (!res?.ok) {
      flash(res?.error || '检查更新失败：请稍后重试', true)
      return
    }
    const count = res.count ?? 0
    flash(count > 0 ? `发现 ${count} 个插件可更新` : '所有已安装插件已是最新')
    await refresh()
  }, [flash, refresh])

  const uninstallTarget = plugins.find((p) => p.id === confirmUninstall) || null

  return (
    <div className="max-w-4xl">
      {/* ── Tabs: 已安装 / 发现 (settings.plugins.tab.*) ── */}
      <div className="flex items-center gap-6 mb-4 border-b border-border">
        <button
          onClick={() => setTab('installed')}
          className={`px-1 pb-2.5 text-sm transition-colors border-b-2 -mb-px ${
            tab === 'installed'
              ? 'text-foreground font-medium border-brand'
              : 'text-foreground/60 hover:text-foreground border-transparent'
          }`}
        >
          已安装
          <span className="ml-1.5 text-xs text-foreground/40">{plugins.length}</span>
        </button>
        <button
          onClick={() => setTab('marketplace')}
          className={`px-1 pb-2.5 text-sm transition-colors border-b-2 -mb-px ${
            tab === 'marketplace'
              ? 'text-foreground font-medium border-brand'
              : 'text-foreground/60 hover:text-foreground border-transparent'
          }`}
        >
          发现
        </button>
      </div>

      {/* ── Row: search + header actions ── */}
      <div className="flex items-center justify-between mb-4 gap-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索插件..."
          className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused w-64"
        />
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => {
              void checkUpdates()
            }}
            disabled={checking}
            className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {checking ? '检查更新中…' : '检查更新'}
          </button>
          <button
            onClick={() => {
              void refresh()
            }}
            disabled={refreshing}
            className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {refreshing ? '刷新中...' : '刷新'}
          </button>
        </div>
      </div>

      {/* Action feedback */}
      {notice && (
        <div
          className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${
            noticeError ? 'bg-red-500/10 text-red-400' : 'bg-green-500/10 text-green-500'
          }`}
        >
          {notice}
        </div>
      )}

      {tab === 'installed' ? (
        <>
          {/* ── 已安装 list ── */}
          {filtered.length === 0 ? (
            <div className="bg-card border border-card-border rounded-xl p-12 text-center">
              <p className="text-sm text-foreground/50">没有找到插件</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setSelectedId(selectedId === p.id ? null : p.id)}
                  className={`bg-card border rounded-xl p-4 cursor-pointer transition-colors ${
                    selectedId === p.id ? 'border-brand/50' : 'border-card-border hover:border-card-border-focused'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground">{p.name}</span>
                        <span className="text-xs text-foreground/40">v{p.version}</span>
                        {p.updateAvailable && (
                          <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-amber-500/15 text-amber-500">
                            可更新
                          </span>
                        )}
                        {p.source === 'builtin' ? (
                          <span className="px-1.5 py-0.5 text-xs rounded-full bg-foreground/5 text-foreground/50">
                            内置
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 text-xs rounded-full bg-foreground/5 text-foreground/50">
                            从 {p.source} 安装
                          </span>
                        )}
                      </div>
                      {p.description && (
                        <p className="text-xs text-foreground/50 mt-1 line-clamp-1">{p.description}</p>
                      )}
                      <p className="text-xs text-foreground/40 mt-1">
                        {capabilityLine(p.components) || NO_COMPONENTS}
                      </p>
                    </div>
                    {/* toggle — settings.plugins.toggle.pending while in flight */}
                    <button
                      role="switch"
                      aria-checked={p.enabled}
                      aria-label={p.enabled ? `停用 ${p.name}` : `启用 ${p.name}`}
                      disabled={pendingToggle === p.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        void toggleEnabled(p)
                      }}
                      className={`relative w-9 h-5 rounded-full flex-shrink-0 transition-colors disabled:opacity-60 ${
                        p.enabled ? 'bg-brand' : 'bg-foreground/20'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          p.enabled ? 'translate-x-4' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Footer summary ── */}
          <p className="text-xs text-foreground/40 mt-4">
            共 {plugins.length} 个插件 · {enabledCount} 个已启用
          </p>

          {/* ── Detail pane (settings.plugins.detail.*) ── */}
          {selected && (
            <div className="bg-card border border-card-border rounded-xl p-5 mt-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-foreground">{selected.name}</h3>
                <button
                  onClick={() => setSelectedId(null)}
                  className="text-foreground/50 hover:text-foreground transition-colors text-sm"
                  aria-label="关闭详情"
                >
                  ✕
                </button>
              </div>
              <div className="grid grid-cols-[88px_1fr] gap-y-2 gap-x-3 text-sm">
                <span className="text-foreground/50">状态</span>
                <span className={selected.enabled ? 'text-green-500' : 'text-foreground/60'}>
                  {selected.enabled ? '已启用' : '已停用'}
                </span>
                <span className="text-foreground/50">来源</span>
                <span className="text-foreground/70">
                  {selected.source === 'builtin' ? '内置' : `来自 ${selected.source}`}
                </span>
                <span className="text-foreground/50">安装路径</span>
                <span className="text-foreground/70 break-all font-mono text-xs leading-5">
                  {selected.installPath}
                </span>
                <span className="text-foreground/50">组件</span>
                <span className="text-foreground/70">
                  {COMPONENT_LABEL.filter((c) => selected.components[c.key] > 0).length === 0
                    ? '无组件'
                    : COMPONENT_LABEL.filter((c) => selected.components[c.key] > 0)
                        .map((c) => `${c.label} × ${selected.components[c.key]}`)
                        .join('，')}
                </span>
              </div>
              {confirmUninstall === selected.id ? (
                <div className="mt-4 pt-4 border-t border-card-border">
                  <p className="text-sm font-medium text-foreground mb-1">卸载 {selected.name}？</p>
                  <p className="text-xs text-foreground/50 mb-3">
                    将删除该插件的缓存文件、数据目录以及已保存的配置。此操作无法撤销。
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        void doUninstall(selected)
                      }}
                      className="px-3 py-1.5 text-sm font-medium rounded-lg bg-red-500/90 text-white hover:bg-red-500 transition-colors"
                    >
                      卸载
                    </button>
                    <button
                      onClick={() => setConfirmUninstall(null)}
                      className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmUninstall(selected.id)}
                  className="mt-4 px-3 py-1.5 text-sm text-red-400/80 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                >
                  卸载
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          {/* ── 发现 tab: marketplace source info + catalog placeholder ── */}
          <div className="bg-card border border-card-border rounded-xl p-4 mb-4">
            <p className="text-sm font-medium text-foreground mb-1">发现页内容来自 GitHub 插件市场</p>
            <p className="text-xs text-foreground/50">
              请确保当前工作区网络可以访问 GitHub。GitHub 不可达时，插件目录、详情和安装可能加载失败。
            </p>
          </div>
          <div className="bg-card border border-card-border rounded-xl p-12 text-center">
            <p className="text-sm text-foreground/50 mb-1">暂无市场插件</p>
            <p className="text-xs text-foreground/40">
              已安装页可管理本机插件；市场目录拉取需要网络访问 GitHub 插件市场。
            </p>
          </div>
        </>
      )}

      {/* Uninstall confirm for rows without the detail pane open */}
      {uninstallTarget && confirmUninstall === uninstallTarget.id && !selected && (
        <div className="bg-card border border-card-border rounded-xl p-5 mt-4">
          <p className="text-sm font-medium text-foreground mb-1">卸载 {uninstallTarget.name}？</p>
          <p className="text-xs text-foreground/50 mb-3">
            将删除该插件的缓存文件、数据目录以及已保存的配置。此操作无法撤销。
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void doUninstall(uninstallTarget)
              }}
              className="px-3 py-1.5 text-sm font-medium rounded-lg bg-red-500/90 text-white hover:bg-red-500 transition-colors"
            >
              卸载
            </button>
            <button
              onClick={() => setConfirmUninstall(null)}
              className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
