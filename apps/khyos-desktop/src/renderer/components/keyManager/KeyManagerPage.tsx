// KeyManagerPage — 密钥与端点中心管理 (DESIGN-ARCH-091 §5.2, P1).
//
// Four tabs: T1 Provider 与密钥 / T2 端点预设 / T3 Agent 应用矩阵（Mode B
// 一键激活）/ T4 健康与审计。Works full-screen in the standalone
// key-manager window (#/key-manager hash) and embedded in the settings
// page providers group.

import { useCallback, useEffect, useState } from 'react'
import {
  khyosApi,
  type Card,
  type MatrixRow,
  type Preset,
  type ProviderView,
  type ProxyState,
  type HealthResult,
  type AuditEntry,
  type EnvOverlayView
} from '../../keyManager/api'

type Tab = 'providers' | 'endpoints' | 'agents' | 'health'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'providers', label: 'Provider 与密钥', icon: '🔑' },
  { id: 'endpoints', label: '端点预设', icon: '🌐' },
  { id: 'agents', label: 'Agent 应用', icon: '🤖' },
  { id: 'health', label: '健康与审计', icon: '📊' }
]

const P1_APPS: { id: string; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'qodercli', label: 'Qoder CLI' }
]

const PROTOCOLS = ['openai', 'anthropic', 'openai_responses', 'gemini']

export function KeyManagerPage({
  standalone = false,
  embedded = false
}: {
  standalone?: boolean
  embedded?: boolean
}) {
  const api = khyosApi()
  const [tab, setTab] = useState<Tab>('providers')
  const [reloadTick, setReloadTick] = useState(0)
  const bump = () => setReloadTick((t) => t + 1)

  if (!api) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-foreground/60 bg-panel">
        密钥管理模块不可用：preload 未就绪，请重启 KhyOS 桌面端
      </div>
    )
  }

  return (
    <div className={`flex flex-col bg-panel text-foreground ${standalone ? 'h-full' : 'min-h-0'}`}>
      {standalone && (
        <div className="flex items-center justify-between px-4 h-11 border-b border-border flex-shrink-0">
          <div className="text-sm font-semibold">🔐 KhyOS 密钥与端点管理</div>
          <button
            onClick={() => api.closeWindow()}
            className="text-foreground/60 hover:text-foreground text-lg leading-none px-2"
            aria-label="关闭窗口"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        {/* 左侧 Tab 导航 */}
        <div className="w-52 border-r border-border py-3 flex-shrink-0 overflow-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`w-full px-4 py-2.5 text-sm text-left flex items-center gap-3 transition-colors ${
                tab === t.id ? 'bg-selected text-brand font-medium' : 'text-foreground/70 hover:bg-surface-hover'
              }`}
            >
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        {/* 右侧内容 */}
        <div className="flex-1 overflow-auto p-6">
          {tab === 'providers' && <T1Providers api={api} tick={reloadTick} onChange={bump} />}
          {tab === 'endpoints' && <T2Endpoints api={api} tick={reloadTick} onChange={bump} />}
          {tab === 'agents' && <T3Agents api={api} tick={reloadTick} onChange={bump} />}
          {tab === 'health' && <T4Health api={api} tick={reloadTick} />}
        </div>
      </div>
    </div>
  )
}

// ── shared bits ──────────────────────────────────────────────────────────────

function Notice({ kind, children }: { kind: 'ok' | 'err' | 'info'; children: React.ReactNode }) {
  const cls =
    kind === 'ok'
      ? 'border-success/40 text-success bg-success/10'
      : kind === 'err'
        ? 'border-destructive/40 text-destructive bg-destructive/10'
        : 'border-card-border text-foreground/70 bg-input'
  return <div className={`text-xs rounded-lg border px-3 py-2 my-2 ${cls}`}>{children}</div>
}

// ── T1 Provider 与密钥 ───────────────────────────────────────────────────────

function T1Providers({ api, tick, onChange }: { api: NonNullable<ReturnType<typeof khyosApi>>; tick: number; onChange: () => void }) {
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [envOverlay, setEnvOverlay] = useState<EnvOverlayView[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // add-key form
  const [fProvider, setFProvider] = useState('')
  const [fEndpoint, setFEndpoint] = useState('')
  const [fKey, setFKey] = useState('')
  const [fLabel, setFLabel] = useState('')
  // models auto-fetch result for a freshly saved custom endpoint
  const [fetchedModels, setFetchedModels] = useState<{ verified: boolean; models: string[]; error?: string } | null>(null)
  // read-only aggregated catalog (union of /models over enabled pool keys)
  const [catalog, setCatalog] = useState<string[]>([])

  const load = useCallback(async () => {
    const r = await api.keysList()
    if (r.ok && r.data) {
      setProviders(r.data.providers)
      setEnvOverlay(r.data.envOverlay)
      if (!selected && r.data.providers.length) setSelected(r.data.providers[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  useEffect(() => {
    void load()
  }, [tick, load])

  // aggregated catalog: fetch /models for enabled openai-endpoint keys (deduped)
  useEffect(() => {
    let cancelled = false
    async function buildCatalog() {
      const seen = new Set<string>()
      const union: string[] = []
      for (const p of providers) {
        for (const k of p.keys) {
          if (!k.enabled || !k.endpoint) continue
          const r = await api.modelsFetch({ endpoint: k.endpoint, protocol: 'openai' })
          if (r.ok && r.data && r.data.verified) {
            for (const m of r.data.models) {
              const ref = `${p.id}/${m}`
              if (!seen.has(ref)) {
                seen.add(ref)
                union.push(ref)
              }
            }
          }
        }
      }
      if (!cancelled) setCatalog(union)
    }
    void buildCatalog()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const sel = providers.find((p) => p.id === selected)

  async function doAdd() {
    if (!fProvider.trim()) {
      setMsg({ kind: 'err', text: 'provider 必填' })
      return
    }
    setBusy('add')
    setMsg(null)
    const r = await api.keysAdd({ provider: fProvider.trim(), endpoint: fEndpoint.trim(), key: fKey, label: fLabel.trim(), priority: 0 })
    setBusy('')
    if (!r.ok) {
      setMsg({ kind: 'err', text: r.error || '添加失败' })
      return
    }
    // auto-fetch models for the new endpoint (spec §8b.2: 成功填充 / 失败不阻塞)
    const mr = await api.modelsFetch({ endpoint: fEndpoint.trim(), protocol: 'openai', key: fKey })
    setFetchedModels(mr.ok && mr.data ? { verified: mr.data.verified, models: mr.data.models, error: mr.data.error } : null)
    setMsg({ kind: 'ok', text: `密钥已入库：${fProvider}（${r.data?.keyId || ''}）` })
    setFKey('')
    onChange()
  }

  return (
    <div>
      <h2 className="text-lg font-bold mb-1">Provider 与密钥</h2>
      <p className="text-xs text-foreground/50 mb-4">
        一处配置 → 全 Agent 跟随。密钥默认脱敏展示，reveal 为一次性操作（60s 冷却 + 审计）。
      </p>

      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <div className="flex gap-2 mb-4">
        <button
          onClick={async () => {
            const r = await api.keysImport()
            if (r.ok && r.data) {
              setMsg({ kind: 'ok', text: `导入完成：${r.data.added} 条入库，${r.data.skipped.length} 条跳过` })
              onChange()
            } else {
              setMsg({ kind: 'err', text: r.error || '导入失败' })
            }
          }}
          className="px-3 py-1.5 text-xs rounded-lg border border-brand/30 text-brand hover:bg-brand/10 transition-colors"
        >
          ＋ 从 docs/opencode-provider-keys.md 一键导入
        </button>
      </div>

      <div className="flex gap-4 min-h-[420px]">
        {/* 左：provider 列表 */}
        <div className="w-56 flex-shrink-0 space-y-2">
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelected(p.id)}
              className={`w-full px-3 py-2 rounded-lg text-sm text-left border transition-colors ${
                selected === p.id ? 'border-brand/40 bg-brand/10 text-brand' : 'border-card-border bg-card hover:bg-surface-hover'
              }`}
            >
              <div className="font-medium">{p.id}</div>
              <div className="text-xs text-foreground/50">{p.keys.length} 条密钥</div>
            </button>
          ))}
          {envOverlay.filter((e) => e.set).length > 0 && (
            <div className="pt-2">
              <div className="text-xs text-foreground/40 px-1 mb-1">env 叠加层（仅展示）</div>
              {envOverlay
                .filter((e) => e.set)
                .map((e) => (
                  <div key={e.provider} className="text-xs px-2 py-1.5 rounded bg-input border border-card-border">
                    {e.provider} · <span className="text-success">env:{e.envName}</span>
                  </div>
                ))}
            </div>
          )}
        </div>

        {/* 右：当前 provider 的密钥 */}
        <div className="flex-1 space-y-4">
          {sel && (
            <div className="bg-card border border-card-border rounded-xl divide-y divide-card-border">
              {sel.keys.map((k) => (
                <div key={k.keyId} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium flex items-center gap-2">
                      {k.label || k.fingerprint}
                      <span className="text-xs text-foreground/40 font-mono">{k.mask}</span>
                      {!k.enabled && <span className="text-xs px-1.5 rounded bg-destructive/20 text-destructive">已停用</span>}
                      {k.source === 'env' && <span className="text-xs px-1.5 rounded bg-brand/20 text-brand">env</span>}
                    </div>
                    <div className="text-xs text-foreground/50 mt-0.5 truncate">{k.endpoint || '(未设端点)'}</div>
                  </div>
                  <button
                    onClick={async () => {
                      const r = await api.keysToggle(sel.id, k.keyId, !k.enabled)
                      if (r.ok) onChange()
                      else setMsg({ kind: 'err', text: r.error || '切换失败' })
                    }}
                    className="text-xs px-2 py-1 rounded border border-card-border hover:bg-surface-hover"
                  >
                    {k.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    onClick={async () => {
                      if (!window.confirm(`一次性显示 ${sel.id} 的完整密钥？（60s 冷却，已审计）`)) return
                      const r = await api.keysReveal(sel.id, k.keyId)
                      if (r.ok && r.data) {
                        try {
                          await navigator.clipboard.writeText(r.data.key)
                        } catch {
                          /* clipboard unavailable */
                        }
                        setMsg({ kind: 'ok', text: '密钥已显示并复制到剪贴板（10s 后请手动清除剪贴板）' })
                      } else {
                        setMsg({ kind: 'err', text: r.error || 'reveal 失败' })
                      }
                    }}
                    className="text-xs px-2 py-1 rounded border border-card-border hover:bg-surface-hover"
                  >
                    显示
                  </button>
                  <button
                    onClick={async () => {
                      if (!window.confirm(`删除 ${sel.id} 的密钥 ${k.mask}？`)) return
                      const r = await api.keysRemove(sel.id, k.keyId)
                      if (!r.ok) {
                        setMsg({ kind: 'err', text: r.error || '删除失败' })
                        return
                      }
                      setMsg({ kind: 'ok', text: '已删除' })
                      onChange()
                    }}
                    className="text-xs px-2 py-1 rounded border border-destructive/40 text-destructive hover:bg-destructive/10"
                  >
                    删除
                  </button>
                </div>
              ))}
              {sel.keys.length === 0 && <div className="px-4 py-6 text-xs text-foreground/40 text-center">该 provider 暂无密钥</div>}
            </div>
          )}

          {/* 添加密钥表单 */}
          <div className="bg-card border border-card-border rounded-xl p-4 space-y-2">
            <div className="text-xs font-semibold text-foreground/60 uppercase tracking-wider">添加密钥</div>
            <div className="flex gap-2 flex-wrap">
              <input
                value={fProvider}
                onChange={(e) => setFProvider(e.target.value)}
                placeholder="provider（如 agnes / deepseek）"
                className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[180px] focus:outline-none focus:border-input-border-focused"
              />
              <input
                value={fEndpoint}
                onChange={(e) => setFEndpoint(e.target.value)}
                placeholder="端点 Base URL（如 https://…/v1）"
                className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm flex-[2] min-w-[220px] focus:outline-none focus:border-input-border-focused"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <input
                value={fKey}
                onChange={(e) => setFKey(e.target.value)}
                placeholder="API Key"
                type="password"
                className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm flex-[2] min-w-[200px] focus:outline-none focus:border-input-border-focused"
              />
              <input
                value={fLabel}
                onChange={(e) => setFLabel(e.target.value)}
                placeholder="标签（可选）"
                className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm flex-1 min-w-[120px] focus:outline-none focus:border-input-border-focused"
              />
              <button
                onClick={() => void doAdd()}
                disabled={busy === 'add'}
                className="px-3 py-1.5 text-sm rounded-lg bg-brand text-white disabled:opacity-50"
              >
                {busy === 'add' ? '入库中…' : '入库'}
              </button>
            </div>
            {fetchedModels && (
              <div className="text-xs text-foreground/60">
                {fetchedModels.verified ? (
                  <span>模型目录已拉取（{fetchedModels.models.length} 个）：{fetchedModels.models.slice(0, 8).join(', ')}{fetchedModels.models.length > 8 ? ' …' : ''}</span>
                ) : (
                  <span>未验证：{fetchedModels.error || '端点不可达'}（不阻塞入库，可稍后在健康页探测）</span>
                )}
              </div>
            )}
          </div>

          {/* 只读：网关聚合模型目录 */}
          {catalog.length > 0 && (
            <div className="bg-card border border-card-border rounded-xl p-4">
              <div className="text-xs font-semibold text-foreground/60 uppercase tracking-wider mb-2">网关聚合模型目录（只读）</div>
              <div className="flex flex-wrap gap-1.5">
                {catalog.map((m) => (
                  <span key={m} className="text-xs px-2 py-0.5 rounded bg-input border border-card-border text-foreground/70">
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── T2 端点预设（卡片） ──────────────────────────────────────────────────────

function T2Endpoints({ api, tick, onChange }: { api: NonNullable<ReturnType<typeof khyosApi>>; tick: number; onChange: () => void }) {
  const [cards, setCards] = useState<Card[]>([])
  const [presets, setPresets] = useState<Preset[]>([])
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [fName, setFName] = useState('')
  const [fPreset, setFPreset] = useState('')
  const [fEndpoint, setFEndpoint] = useState('')
  const [fProtocol, setFProtocol] = useState('openai')
  const [fKeyId, setFKeyId] = useState('')
  const [fModel, setFModel] = useState('')
  const [validateState, setValidateState] = useState<{ reachable: boolean; status?: number; latencyMs: number; error?: string } | null>(null)

  useEffect(() => {
    async function load() {
      const cr = await api.cardsList()
      if (cr.ok && cr.data) setCards(cr.data.cards)
      const pr = await api.endpointsPresets()
      if (pr.ok && pr.data) setPresets(pr.data)
      const kl = await api.keysList()
      if (kl.ok && kl.data) setProviders(kl.data.providers)
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const preset = presets.find((p) => p.id === fPreset)

  async function doSave() {
    const baseUrl = preset ? preset.baseUrl : fEndpoint
    if (!fName.trim() || !baseUrl) {
      setMsg({ kind: 'err', text: '卡片名称与端点必填（预设或自定义端点二选一）' })
      return
    }
    const r = await api.cardsAdd({
      name: fName.trim(),
      baseUrl,
      keyId: fKeyId,
      protocol: preset ? preset.apiFormat : fProtocol,
      defaultModel: fModel || preset?.defaultModel || '',
      models: fModel ? [fModel] : [],
      apps: P1_APPS.map((a) => a.id)
    })
    if (r.ok) {
      setMsg({ kind: 'ok', text: `卡片已创建：${fName} → ${baseUrl}` })
      setFName('')
      setFEndpoint('')
      setFKeyId('')
      setFModel('')
      onChange()
    } else {
      setMsg({ kind: 'err', text: r.error || '创建失败' })
    }
  }

  const allKeys = providers.flatMap((p) => p.keys.map((k) => ({ ...k, provider: p.id })))

  return (
    <div>
      <h2 className="text-lg font-bold mb-1">端点预设</h2>
      <p className="text-xs text-foreground/50 mb-4">
        卡片 = 端点 + 协议 + 池内 key 引用（无凭据设计：卡片本身不存密钥）。预设目录 {presets.length > 0 && presets[0].source === 'builtin-fallback' ? '（内置回退源，backend 未解析）' : '（backend 真源）'}。
      </p>

      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <div className="flex gap-4">
        <div className="flex-1 space-y-2">
          {cards.map((c) => (
            <div key={c.id} className="flex items-center gap-3 bg-card border border-card-border rounded-xl px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {c.name} <span className="text-xs text-foreground/40">[{c.protocol}]</span>
                </div>
                <div className="text-xs text-foreground/50 truncate">{c.baseUrl} · 模型 {c.defaultModel || '(未设)'} · key {c.keyId ? c.keyId.slice(0, 8) : '(未绑定)'}</div>
              </div>
              {!c.enabled && <span className="text-xs px-1.5 rounded bg-destructive/20 text-destructive">停用</span>}
              <button
                onClick={async () => {
                  const r = await api.cardsRemove(c.id)
                  if (r.ok) onChange()
                  else setMsg({ kind: 'err', text: r.error || '删除失败' })
                }}
                className="text-xs px-2 py-1 rounded border border-destructive/40 text-destructive hover:bg-destructive/10"
              >
                删除
              </button>
            </div>
          ))}
          {cards.length === 0 && <div className="text-xs text-foreground/40 py-8 text-center bg-card border border-card-border rounded-xl">暂无卡片，在右侧创建</div>}
        </div>

        <div className="w-80 flex-shrink-0 space-y-2">
          <div className="bg-card border border-card-border rounded-xl p-4 space-y-2">
            <div className="text-xs font-semibold text-foreground/60 uppercase tracking-wider">新建卡片</div>
            <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="名称（如 SupXH）" className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm w-full focus:outline-none focus:border-input-border-focused" />
            <select
              value={fPreset}
              onChange={(e) => {
                setFPreset(e.target.value)
                const p = presets.find((x) => x.id === e.target.value)
                if (p) setFModel(p.defaultModel || '')
              }}
              className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm w-full focus:outline-none"
            >
              <option value="">自定义端点…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.apiFormat})
                </option>
              ))}
            </select>
            {!preset && (
              <>
                <input value={fEndpoint} onChange={(e) => setFEndpoint(e.target.value)} placeholder="端点 Base URL" className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm w-full focus:outline-none focus:border-input-border-focused" />
                <select value={fProtocol} onChange={(e) => setFProtocol(e.target.value)} className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm w-full focus:outline-none">
                  {PROTOCOLS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </>
            )}
            <select value={fKeyId} onChange={(e) => setFKeyId(e.target.value)} className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm w-full focus:outline-none">
              <option value="">不绑定密钥（端点直连无鉴权场景）</option>
              {allKeys.map((k) => (
                <option key={k.keyId} value={k.keyId}>
                  {k.provider} · {k.label || k.fingerprint} · {k.mask}
                </option>
              ))}
            </select>
            <input value={fModel} onChange={(e) => setFModel(e.target.value)} placeholder="默认模型（可留空）" className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-sm w-full focus:outline-none focus:border-input-border-focused" />
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  const url = preset ? preset.baseUrl : fEndpoint
                  if (!url) {
                    setValidateState({ reachable: false, latencyMs: 0, error: '先选择预设或填写端点' })
                    return
                  }
                  const r = await api.endpointsValidate({ endpoint: url, protocol: preset ? preset.apiFormat : fProtocol })
                  if (r.ok && r.data) setValidateState(r.data)
                }}
                className="flex-1 text-xs px-2 py-1.5 rounded-lg border border-card-border hover:bg-surface-hover"
              >
                验证端点
              </button>
              <button onClick={() => void doSave()} className="flex-1 text-xs px-2 py-1.5 rounded-lg bg-brand text-white">
                保存卡片
              </button>
            </div>
            {validateState && (
              <div className="text-xs text-foreground/60">
                {validateState.reachable ? `端点可达 (HTTP ${validateState.status}，${validateState.latencyMs}ms)` : `端点不可达：${validateState.error || '网络错误'}`}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── T3 Agent 应用矩阵（Mode B 一键激活） ─────────────────────────────────────

function T3Agents({ api, tick, onChange }: { api: NonNullable<ReturnType<typeof khyosApi>>; tick: number; onChange: () => void }) {
  const [rows, setRows] = useState<MatrixRow[]>([])
  const [cards, setCards] = useState<Card[]>([])
  const [proxy, setProxy] = useState<ProxyState | null>(null)
  const [pick, setPick] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [applying, setApplying] = useState('')

  useEffect(() => {
    async function load() {
      const mr = await api.agentsMatrix()
      if (mr.ok && mr.data) setRows(mr.data)
      const cr = await api.cardsList()
      if (cr.ok && cr.data) {
        setCards(cr.data.cards)
        const am = cr.data.agentMode || {}
        setPick(Object.fromEntries(Object.entries(am).map(([app, m]) => [app, m.cardId])))
      }
      const ps = await api.proxyStatus()
      if (ps.ok && ps.data) setProxy(ps.data)
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  async function doActivate(app: string, mode: 'proxy' | 'direct') {
    const cardId = pick[app]
    if (!cardId) {
      setMsg({ kind: 'err', text: `${app}：请先在端点预设页创建并选择一张卡片` })
      return
    }
    setApplying(app)
    setMsg(null)
    const r = await api.agentsApply({ app, cardId, mode })
    setApplying('')
    if (r.ok) {
      const card = cards.find((c) => c.id === cardId)
      const model = card?.defaultModel || '(卡片默认)'
      setMsg({
        kind: 'ok',
        text:
          mode === 'proxy'
            ? `已激活 ${app} → khy 聚合 (${(proxy?.endpoint || '本地网关').replace(/^https?:\/\//, '')}, 模型 ${model}）。重启 Agent 生效（仅 claude-code 支持热切换）。此后换模型/换 key 均为纯 khy 侧操作，Agent 零改动。`
            : `已激活 ${app} → 直连 ${card?.baseUrl || ''}（模型 ${model}）。重启 Agent 生效。`
      })
      onChange()
    } else {
      setMsg({ kind: 'err', text: `激活失败 ${app}：${r.error || '未知错误'}` })
    }
  }

  const cardName = (id: string) => cards.find((c) => c.id === id)?.name || id

  return (
    <div>
      <h2 className="text-lg font-bold mb-1">Agent 应用</h2>
      <p className="text-xs text-foreground/50 mb-4">
        推荐「khy 聚合」模式：Agent 只指向 khy 本地网关（凭据为本地 relay token，真实 key 不出池）。
      </p>

      {/* proxy 状态横幅 */}
      {proxy && (
        <div
          className={`rounded-xl border px-4 py-3 mb-4 flex items-center gap-3 ${
            proxy.running ? 'border-success/40 bg-success/10' : 'border-warning/40 bg-warning/10'
          }`}
        >
          <div className="flex-1">
            <div className={`text-sm font-medium ${proxy.running ? 'text-success' : 'text-warning'}`}>
              {proxy.running ? `khy 本地网关运行中：${proxy.endpoint}` : proxy.detail}
            </div>
            <div className="text-xs text-foreground/50 mt-0.5">
              {proxy.running ? '聚合模式可用：换模型/换 key 纯 khy 侧操作' : '聚合模式暂不可用（直连模式仍可用）'}
            </div>
          </div>
          {!proxy.running && (
            <button
              onClick={async () => {
                const r = await api.proxyStart()
                if (r.ok) {
                  setMsg({ kind: 'ok', text: `本地网关已启动：${r.data?.detail || ''}` })
                  onChange()
                } else {
                  setMsg({ kind: 'err', text: `启动失败：${r.error || 'backend 服务不可用，请改用 khy CLI 启动网关'}` })
                }
              }}
              className="px-3 py-1.5 text-xs rounded-lg bg-brand text-white"
            >
              启动网关
            </button>
          )}
        </div>
      )}

      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <div className="space-y-3">
        {P1_APPS.map((app) => {
          const row = rows.find((r) => r.app === app.id)
          const qoderOnlyProxy = app.id === 'qodercli'
          return (
            <div key={app.id} className="bg-card border border-card-border rounded-xl px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-sm font-medium">
                    {app.label}
                    {row?.mode === 'none' && <span className="text-xs text-foreground/40 ml-2">未激活</span>}
                    {row?.mode === 'proxy' && <span className="text-xs text-success ml-2">khy 聚合中</span>}
                    {row?.mode === 'direct' && <span className="text-xs text-warning ml-2">直连中</span>}
                  </div>
                  <div className="text-xs text-foreground/50 truncate mt-0.5">
                    {row?.targetPath || '(目标路径未解析)'}{row?.lastApplied ? ` · 上次激活 ${new Date(row.lastApplied).toLocaleString()}` : ''}
                  </div>
                </div>
                <select
                  value={pick[app.id] || ''}
                  onChange={(e) => setPick((prev) => ({ ...prev, [app.id]: e.target.value }))}
                  className="bg-input border border-input-border rounded-lg px-3 py-1.5 text-xs min-w-[160px] focus:outline-none"
                >
                  <option value="">选择卡片…</option>
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} [{c.protocol}]
                    </option>
                  ))}
                </select>
                {!qoderOnlyProxy && (
                  <button
                    onClick={() => void doActivate(app.id, 'proxy')}
                    disabled={applying === app.id}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      pick[app.id] ? 'text-brand border-brand/40 hover:bg-brand/10' : 'text-foreground/40 border-card-border'
                    } disabled:opacity-50`}
                  >
                    激活（khy 聚合）
                  </button>
                )}
                <button
                  onClick={() => void doActivate(app.id, qoderOnlyProxy ? 'proxy' : 'direct')}
                  disabled={applying === app.id}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                    qoderOnlyProxy ? 'text-brand border-brand/40 hover:bg-brand/10' : pick[app.id] ? 'text-foreground/70 border-card-border hover:bg-surface-hover' : 'text-foreground/40 border-card-border'
                  } disabled:opacity-50`}
                >
                  {qoderOnlyProxy ? '激活（qoder-proxy 门控）' : '激活（直连）'}
                </button>
                {row?.mode !== 'none' && (
                  <button
                    onClick={async () => {
                      const r = await api.agentsRevert(app.id)
                      if (r.ok) {
                        setMsg({ kind: 'ok', text: `已撤销 ${app.label}：${r.data?.detail || ''}` })
                        onChange()
                      } else {
                        setMsg({ kind: 'err', text: r.error || '撤销失败' })
                      }
                    }}
                    className="px-3 py-1.5 text-xs rounded-lg border border-card-border text-foreground/70 hover:bg-surface-hover"
                  >
                    撤销
                  </button>
                )}
              </div>
              {qoderOnlyProxy && (
                <div className="text-xs text-foreground/40 mt-1.5">
                  Qoder CLI 走 qoder-proxy 门控（KHY_QODER_PROXY）：激活后网关池出现 qoder 哨兵条目，模型经 khy 代理路由。
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── T4 健康与审计 ────────────────────────────────────────────────────────────

function T4Health({ api, tick }: { api: NonNullable<ReturnType<typeof khyosApi>>; tick: number }) {
  const [results, setResults] = useState<HealthResult[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [probing, setProbing] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    void api.healthAuditList(100).then((r) => {
      if (r.ok && r.data) setAudit(r.data)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const statusCls = (s: string) =>
    s === 'ok' || s === 'reachable'
      ? 'text-success'
      : s === 'auth'
        ? 'text-destructive'
        : s === 'rate'
          ? 'text-warning'
          : 'text-foreground/60'

  return (
    <div>
      <h2 className="text-lg font-bold mb-1">健康与审计</h2>
      <p className="text-xs text-foreground/50 mb-4">单条探测 10s 短超时（并发上限 4，单条卡死不阻塞批次）。</p>

      <button
        onClick={async () => {
          setProbing(true)
          setMsg(null)
          const r = await api.healthProbe()
          setProbing(false)
          if (r.ok && r.data) {
            setResults(r.data.results)
            setMsg(`探测完成：${r.data.results.length} 条密钥（10s/条 短超时，并发 4）`)
          } else {
            setMsg(r.error || '探测失败')
          }
        }}
        disabled={probing}
        className="px-3 py-1.5 text-xs rounded-lg bg-brand text-white disabled:opacity-50 mb-3"
      >
        {probing ? '探测中…' : '全量探测'}
      </button>

      {msg && <Notice kind={msg.startsWith('探测') ? 'ok' : 'err'}>{msg}</Notice>}

      {results.length > 0 && (
        <div className="bg-card border border-card-border rounded-xl divide-y divide-card-border mb-6">
          {results.map((r) => (
            <div key={r.keyId} className="flex items-center gap-3 px-4 py-2.5">
              <div className={`w-20 text-xs font-medium ${statusCls(r.status)}`}>{r.status}</div>
              <div className="text-xs flex-1 truncate">
                {r.provider} <span className="text-foreground/40">({r.endpoint || '无端点'})</span>
              </div>
              <div className="text-xs text-foreground/50">{r.detail}</div>
              <div className="text-xs text-foreground/40 w-16 text-right">{r.latencyMs}ms</div>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs font-semibold text-foreground/60 uppercase tracking-wider mb-2">审计流水（只读）</div>
      <div className="bg-card border border-card-border rounded-xl divide-y divide-card-border max-h-72 overflow-auto">
        {audit.length === 0 && <div className="px-4 py-6 text-xs text-foreground/40 text-center">暂无审计记录</div>}
        {audit
          .slice()
          .reverse()
          .map((a, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-2 text-xs">
              <span className="text-foreground/40 w-36">{new Date(a.ts).toLocaleString()}</span>
              <span className="w-24 text-brand">{a.op}</span>
              <span className="flex-1 truncate text-foreground/70">
                {a.target || ''} {a.detail ? `· ${a.detail}` : ''} {a.fingerprint ? `· fp:${a.fingerprint}` : ''}
              </span>
            </div>
          ))}
      </div>
    </div>
  )
}
