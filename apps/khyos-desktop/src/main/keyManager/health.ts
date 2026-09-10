// health — key health probing (DESIGN-ARCH-091 §5.2 T4 / §7.4).
//
// Classification:
//   2xx/404/405 → 'ok'        (endpoint answers; 404 on /models = reachable)
//   401/403     → 'auth'      (key invalid/expired — Rule 2.2 error template)
//   429         → 'rate'
//   5xx         → 'upstream'
//   timeout     → 'timeout'   (10s per item — short I/O exception class,
//                              rule 3: NO whole-batch hard kill; concurrency 4,
//                              a stuck item never blocks the rest)

import { PROBE_CONCURRENCY, PROBE_TIMEOUT_MS } from './types.ts'
import type { HealthResult } from './types.ts'

export interface ProbeTarget {
  keyId: string
  provider: string
  endpoint: string
  key: string
  protocol?: string
}

export interface ProbeProgress {
  done: number
  total: number
  label: string
}

function classify(status: number): HealthResult['status'] {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate'
  if (status >= 500) return 'upstream'
  return 'ok' // 404/405/other 4xx: the endpoint is up
}

const STATUS_HINT: Record<HealthResult['status'], string> = {
  ok: '可用',
  auth: '认证失败 (401/403)：密钥无效或过期，请在 Provider 页更新',
  rate: '限流 (429)：请求过多，稍后重试',
  upstream: '上游异常 (5xx)：模型服务暂不可用，请稍后重试',
  timeout: '请求超时：网络或服务响应慢，请稍后重试',
  reachable: '端点可达'
}

export function statusHint(status: HealthResult['status']): string {
  return STATUS_HINT[status]
}

// host[:port] of an endpoint for progress labels (action+target+progress, rule 2)
function shortHost(endpoint: string): string {
  try {
    const u = new URL(String(endpoint || '').replace(/\/v1\/?$/, '') || 'http://(empty)')
    return u.host
  } catch {
    return '(invalid endpoint)'
  }
}

export async function probeOne(t: ProbeTarget, timeoutMs = PROBE_TIMEOUT_MS): Promise<HealthResult> {
  const base = String(t.endpoint || '').trim().replace(/\/v1\/?$/, '')
  const url = `${base}/v1/models`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  const headers: Record<string, string> = {}
  if (t.key) {
    if (t.protocol === 'anthropic') headers['x-api-key'] = t.key
    else headers.authorization = `Bearer ${t.key}`
  }
  try {
    const res = await fetch(url, { method: 'GET', signal: ctrl.signal, headers })
    const status = classify(res.status)
    return {
      keyId: t.keyId,
      provider: t.provider,
      endpoint: t.endpoint,
      status,
      detail: statusHint(status),
      latencyMs: Date.now() - t0
    }
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError'
    return {
      keyId: t.keyId,
      provider: t.provider,
      endpoint: t.endpoint,
      status: aborted ? 'timeout' : 'upstream',
      detail: aborted ? STATUS_HINT.timeout : '网络连接失败：请检查网络代理设置',
      latencyMs: Date.now() - t0
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface ProbeAllOptions {
  onProgress?: (p: ProbeProgress) => void
  concurrency?: number
  timeoutMs?: number
}

// Concurrency-limited fan-out. Each item has its own independent short I/O
// timeout; the batch itself has NO wall-clock kill (rule 3).
export async function probeAll(targets: ProbeTarget[], opts: ProbeAllOptions = {}): Promise<HealthResult[]> {
  const limit = opts.concurrency || PROBE_CONCURRENCY
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS
  const results: HealthResult[] = new Array(targets.length)
  let next = 0
  let done = 0
  async function worker(): Promise<void> {
    while (next < targets.length) {
      const idx = next
      next += 1
      const t = targets[idx]
      results[idx] = await probeOne(t, timeoutMs)
      done += 1
      opts.onProgress?.({
        done,
        total: targets.length,
        label: `探测 ${done}/${targets.length}：${t.provider} (${shortHost(t.endpoint)})`
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, () => worker()))
  return results
}
