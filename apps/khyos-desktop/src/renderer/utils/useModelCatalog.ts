import { useState, useEffect } from 'react'

// 模型/provider 选项（来自后端 providerPresets.getProviderPresets()，经 host
// CH-2 桥转发，P3-7）。provider 级选项 format 同 apiFormat；模型级选项
// id 形如 `<provider>/<model>`。channel 是后端池 key（网关 preferredAdapter
// 认的名字）；channelKnown=false 时（聚合网关等未注册池）不应钉 preferredAdapter。
export interface ModelOption {
  id: string
  label: string
  format: string
  channel?: string
  channelKnown?: boolean
}

interface ModelCatalogState {
  options: ModelOption[]
  loading: boolean
  error: string
}

// 选中模型持久化键（settingsStore，主进程 settings.json 原子写，P3-7②）。
// 存选项 id（`<provider>` 或 `<provider>/<model>`）——跨重启恢复时若该
// provider 已从 presets 消失，调用方回退到首个可用选项，永不写死模型名。
const SETTING_KEY = 'selectedModel'

// 从全量选项表（静态 presets 与动态 adapter.listModels 结果的并集）解析某
// id 的展示标签；未知 id 返回 null（调用方自行兜底为 '选择模型'）。
// P3-7④ 起 App/ModelSelector 共用，替代 App.tsx 里已删除的 GLM 静态默认名。
export function getModelOptionLabel(id: string, options: ModelOption[]): string | null {
  if (!id) return null
  const hit = options.find((o) => o.id === id)
  if (hit) return hit.label
  // provider 级 `<provider>/<model>`：未知 model（动态拉取结果不在表里）→
  // 退化为 provider 标签，避免裸 id 字符串泄漏到 UI。
  if (id.includes('/')) {
    const provider = options.find((o) => o.id === id.slice(0, id.indexOf('/')))
    if (provider) return provider.label
  }
  return null
}

// 持久化模型选中态（P3-7②）：经 settingsStore（main 进程 settings.json）
// 落盘，重启后 loadPersistedModelSelection 恢复。fail-soft：preload 未注入
// 或写入失败静默忽略——选中态丢失不阻断会话。
export function persistModelSelection(id: string): void {
  void (window as unknown as {
    __KHYOS__?: { setSetting?: (k: string, v: unknown) => Promise<void> } }
  ).__KHYOS__?.setSetting?.(SETTING_KEY, id).catch(() => {})
}

// 启动时恢复模型选中态（P3-7②）；settingsStore 不可用时返回 null。
export async function loadPersistedModelSelection(): Promise<string | null> {
  const api = (window as unknown as {
    __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> } }
  ).__KHYOS__
  if (!api?.getSettings) return null
  try {
    const s = await api.getSettings()
    const v = s?.[SETTING_KEY]
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

// 拉取动态模型（P3-7③ 非 React 版）：把 selected provider 的 channel 传入
// listModels(channel)，host 侧经 aiGateway.listModels(channel) 拉取运行时
// 模型（凭据/网络缺失时 best-effort 空数组，不抛错），去重后并入模块级
// 缓存。幂等：已拉过的 channel 直接命中缓存，重复调用零网络开销。
// App.tsx 顶层调用（一次），Composer 经 useModelCatalog() 共享同一缓存表。
const dynamicFetched = new Set<string>()

export async function fetchDynamicModels(adapterKey?: string): Promise<ModelOption[]> {
  const api = (window as unknown as {
    __KHYOS__?: {
      listModels?: (k?: string) => Promise<{ ok: boolean; models?: ModelOption[]; error?: string }>
    }
  }).__KHYOS__
  if (!adapterKey || !api?.listModels || dynamicFetched.has(adapterKey)) return cached ?? []
  dynamicFetched.add(adapterKey)
  try {
    const res = await api.listModels(adapterKey)
    if (res?.ok && Array.isArray(res.models)) {
      const base = cached ?? []
      const seen = new Set(base.map((o) => o.id))
      const extra = res.models.filter((o) => !seen.has(o.id))
      if (extra.length > 0) cached = [...base, ...extra]
    }
  } catch {
    /* fail-soft：动态拉取失败保留静态基线 */
  }
  return cached ?? []
}

// 拉取后端 providerPresets 真源（含预置模型），失败时 fail-soft 返回空。
// 同一模块内只拉一次（模块级缓存），后续调用复用。
let cached: ModelOption[] | null = null

export function useModelCatalog(): ModelCatalogState {
  const [state, setState] = useState<ModelCatalogState>({
    options: cached ?? [],
    loading: cached === null,
    error: '',
  })

  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: {
        listModels?: (adapterKey?: string) => Promise<{
          ok: boolean
          models?: ModelOption[]
          error?: string
        }>
      }
    }).__KHYOS__
    if (!api?.listModels) {
      setState((s) => ({
        ...s,
        loading: false,
        error: '模型列表不可用：preload 未注入 __KHYOS__，请重启应用',
      }))
      return
    }
    if (cached !== null) {
      setState({ options: cached, loading: false, error: '' })
      return
    }
    let cancelled = false
    api.listModels().then((res) => {
      if (cancelled) return
      if (res?.ok && Array.isArray(res.models)) {
        cached = res.models
        setState({ options: res.models, loading: false, error: '' })
      } else {
        setState((s) => ({ ...s, loading: false, error: res?.error || '模型列表读取失败：host 进程无响应，请重启应用' }))
      }
    }).catch(() => {
      if (cancelled) return
      setState((s) => ({ ...s, loading: false, error: '模型列表读取失败：host 进程无响应，请重启应用' }))
    })
    return () => { cancelled = true }
  }, [])

  return state
}

// 把模型选项拆成 provider 一级 + 每个 provider 下的模型二级（label 含
// provider 前缀的归到对应 provider 下，否则 provider 自身即选项）。
export function groupByProvider(options: ModelOption[]): Array<{ provider: ModelOption; models: ModelOption[] }> {
  const providers = new Map<string, ModelOption>()
  const modelsByProvider = new Map<string, ModelOption[]>()
  for (const o of options) {
    if (o.id.includes('/')) {
      const [pid] = o.id.split('/')
      if (!providers.has(pid)) {
        // 动态模型先于 provider 基线到达时（理论上不会——动态结果总是按
        // provider/channel 拉取后并入），补一个最小 provider 占位，
        // 保证二级条目有可归属的一级父项。
        providers.set(pid, { id: pid, label: pid, format: o.format })
      }
      const arr = modelsByProvider.get(pid) ?? []
      arr.push(o)
      modelsByProvider.set(pid, arr)
    } else {
      providers.set(o.id, o)
      if (!modelsByProvider.has(o.id)) modelsByProvider.set(o.id, [])
    }
  }
  return Array.from(providers.entries()).map(([pid, p]) => ({
    provider: p,
    models: modelsByProvider.get(pid) ?? [],
  }))
}
