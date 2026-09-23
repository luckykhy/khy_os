// modelCatalog — 卡片模型目录拉取与合并（DESIGN-ARCH-094 §4/§5 M1）。
//
// 按卡片协议路由「拉取模型」请求；空闲超时（AbortController）绝不硬挂
// （工程规则 3）；fail-soft 永不抛；结果与错误消息绝不含明文 key（脱敏
// 不变式，契约 C3/C8）。合并语义：已有条目不覆盖（cc-switch 回填保护）。

export interface FetchCatalogInput {
  protocol: string
  baseUrl: string
  key?: string
}

export interface FetchResult {
  ok: boolean
  /** 模型目录是否被真实验证（false 时可手工填写，不阻塞保存） */
  verified: boolean
  models: string[]
  latencyMs?: number
  error?: string
}

export interface FetchOptions {
  /** 测试/代理注入点：默认 globalThis.fetch */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  /** 空闲超时（毫秒）：响应头/流未推进即中止，规则 3 */
  timeoutMs?: number
}

function normalizeBase(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/v1\/?$/, '').replace(/\/+$/, '')
}

export async function fetchModelCatalog(card: FetchCatalogInput, opts: FetchOptions = {}): Promise<FetchResult> {
  const protocol = String(card.protocol || '').toLowerCase()
  const fetchImpl = opts.fetchImpl || ((url: string, init?: RequestInit) => fetch(url, init))
  const timeoutMs = opts.timeoutMs ?? 15_000
  const base = normalizeBase(card.baseUrl)
  const t0 = Date.now()

  if (protocol === 'gemini') {
    return {
      ok: true,
      verified: false,
      models: [],
      error: '该协议无公开模型目录，请手工填写模型 id'
    }
  }

  const isAnthropic = protocol === 'anthropic'
  const url = isAnthropic ? `${base}/v1/models` : `${base}/v1/models`
  const headers: Record<string, string> = {}
  if (isAnthropic) {
    if (card.key) headers['x-api-key'] = card.key
    headers['anthropic-version'] = '2023-06-01'
  } else if (card.key) {
    headers.authorization = `Bearer ${card.key}`
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: ctrl.signal, headers })
    if (res.status === 401 || res.status === 403) {
      return {
        ok: true,
        verified: false,
        models: [],
        latencyMs: Date.now() - t0,
        error: `鉴权失败 (${res.status})：API key 无效或过期，请运行 khy gateway config 更新密钥或重新填入`
      }
    }
    if (!res.ok) {
      return {
        ok: true,
        verified: false,
        models: [],
        latencyMs: Date.now() - t0,
        error: `模型目录不可用 (${res.status})：上游服务暂不可用，请稍后重试或手工填写模型 id`
      }
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> }
    const models = (body.data || []).map((m) => String(m.id)).filter(Boolean)
    return { ok: true, verified: true, models, latencyMs: Date.now() - t0 }
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError' || ctrl.signal.aborted
    const msg = e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)
    return {
      ok: true,
      verified: false,
      models: [],
      latencyMs: Date.now() - t0,
      error: aborted
        ? `端点不可达（空闲 ${timeoutMs}ms 超时）：模型服务未响应，请重试或切换卡片`
        : `端点不可达 (${msg})：请检查网络/代理设置，或手工填写模型 id`
    }
  } finally {
    clearTimeout(timer)
  }
}

// 合并：已有条目顺序保留（不覆盖），新模型追加；模型 id 大小写敏感。
export function mergeCatalog(existing: string[], fetched: string[]): string[] {
  const out = [...(existing || [])]
  for (const m of fetched || []) {
    if (m && !out.includes(m)) out.push(m)
  }
  return out
}

// 默认模型：既有默认仍在目录中则保留，否则取目录首个（手工目录可为空）。
export function resolveDefault(existingDefault: string | undefined, models: string[]): string {
  const def = existingDefault || ''
  if (def && models.includes(def)) return def
  return models[0] || ''
}

// 端点可达性探测（健康徽标：任何 HTTP 应答 = 可达，规则 2.2 具体化）。
export interface ProbeResult {
  reachable: boolean
  status?: number
  latencyMs: number
  error?: string
  /** 探测失败时的可行动提示（如 failover 轮换建议），由调用方附加 */
  hint?: string
}

export async function probeEndpoint(
  endpoint: string,
  protocol: string,
  key: string,
  timeoutMs = 5_000
): Promise<ProbeResult> {
  const isAnthropic = String(protocol || '').toLowerCase() === 'anthropic'
  const base = normalizeBase(endpoint)
  const url = `${base}/v1/models`
  const headers: Record<string, string> = {}
  if (key) {
    if (isAnthropic) headers['x-api-key'] = key
    else headers.authorization = `Bearer ${key}`
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, headers })
    return { reachable: true, status: res.status, latencyMs: Date.now() - t0 }
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)
    return { reachable: false, latencyMs: Date.now() - t0, error: msg }
  } finally {
    clearTimeout(timer)
  }
}
