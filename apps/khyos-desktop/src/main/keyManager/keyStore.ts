// keyStore — file layer of the Key/Endpoint Manager (DESIGN-ARCH-091 §4.2).
//
// Owns the three SSoT JSON files under the resolved dataHome (never invents a
// fourth store): api_keys.json (key pool), custom_providers.json (metadata),
// cc_switch.json (credential-free cards). Atomic write + .bak self-heal mirror
// services/backend configGuard semantics; keyId scheme mirrors apiKeyPool
// (md5(provider:key).slice(0,12)) so cross-process references stay valid.
//
// Masking invariant: every function in this module returns masked keys unless
// explicitly documented otherwise (revealKey is the single plaintext seam,
// rate-limited + audited in ipc.ts).

import { promises as fs, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  API_KEYS_FILE,
  AUDIT_FILE,
  CC_SWITCH_FILE,
  CUSTOM_PROVIDERS_FILE,
  ENV_PROVIDER_MAP,
  REVEAL_COOLDOWN_MS
} from './types.ts'
import type {
  Card,
  CcSwitchDoc,
  CustomProvider,
  EnvOverlayView,
  MaskedKey,
  PoolEntry,
  PresetView,
  ProviderView
} from './types.ts'
import { appendAudit } from './audit.ts'

// ── dataHome resolution (portable-safe, mirrors utils/dataHome.js) ──────────
// Resolution order:
//   1. KHY_DATA_HOME env (explicit override, also used by tests)
//   2. portable root (KHY_PORTABLE_ROOT / KHYQUANT_PORTABLE_ROOT) + '.khy'
//   3. walk up from this module for a '.portable' marker → its '.khy'
//   4. os.homedir()/.khy fallback (never fails)
let _dataHome: string | null = null

export function resolveRepoRoot(): string | null {
  const explicit = process.env.KHYOS_DESKTOP_REPO_ROOT
  if (explicit) return explicit
  const here = path.dirname(fileURLToPath(import.meta.url))
  let dir = here
  for (let i = 0; i < 10; i += 1) {
    try {
      if (fsSyncExists(path.join(dir, '.portable'))) return dir
    } catch {
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// sync existence check helper (dataHome resolution is sync by design)
function fsSyncExists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

export function getDataHome(): string {
  if (_dataHome) return _dataHome
  const envHome = process.env.KHY_DATA_HOME
  if (envHome) {
    _dataHome = path.resolve(envHome)
    return _dataHome
  }
  const portableRoot = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT
  if (portableRoot) {
    _dataHome = path.join(portableRoot, '.khy')
    return _dataHome
  }
  const repoRoot = resolveRepoRoot()
  if (repoRoot) {
    _dataHome = path.join(repoRoot, '.khy')
    return _dataHome
  }
  _dataHome = path.join(os.homedir(), '.khy')
  return _dataHome
}

// test seam: reset cached dataHome between tests
export function _resetDataHomeCache(): void {
  _dataHome = null
}

function fileInDataHome(name: string): string {
  return path.join(getDataHome(), name)
}

// public alias used by ipc.ts / agentWriters.ts
export function dataHomeFile(name: string): string {
  return fileInDataHome(name)
}

// ── atomic write + .bak self-heal (configGuard-equivalent semantics) ───────

let _tmpSeq = 0

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  // .bak of the previous content (self-heal source)
  try {
    await fs.copyFile(file, `${file}.bak`)
  } catch {
    /* no previous file yet — nothing to back up */
  }
  const tmp = `${dir}/${path.basename(file)}.tmp-${process.pid}-${_tmpSeq++}`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  // Windows: rename-over may hit EPERM when another handle is briefly holding
  // the target (concurrent .bak copy / readers). Retry with backoff, then
  // fall back to a direct overwrite (the atomicity degrades gracefully; the
  // .bak remains the self-heal source of truth).
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(tmp, file)
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY') throw e
      if (attempt === 4) {
        await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8')
        await fs.unlink(tmp).catch(() => {})
      } else {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
      }
    }
  }
  await tryChmod600(file)
}

async function tryChmod600(file: string): Promise<void> {
  try {
    if (process.platform !== 'win32') await fs.chmod(file, 0o600)
  } catch {
    /* best-effort on all platforms */
  }
}

export interface SafeReadResult<T> {
  data: T
  recovered: boolean
}

export async function safeReadJson<T>(file: string, fallback: T): Promise<SafeReadResult<T>> {
  let raw: string | null = null
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    return { data: fallback, recovered: false }
  }
  try {
    return { data: JSON.parse(raw) as T, recovered: false }
  } catch {
    // corrupt → restore from .bak (direct write; does NOT clobber the .bak
    // with the corrupt content, so repeated heals keep working)
    try {
      const bak = await fs.readFile(`${file}.bak`, 'utf-8')
      const parsed = JSON.parse(bak) as T
      const tmp = `${file}.heal-${process.pid}`
      await fs.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf-8')
      await fs.rename(tmp, file)
      return { data: parsed, recovered: true }
    } catch {
      /* no .bak — keep fallback */
    }
    return { data: fallback, recovered: false }
  }
}

// ── masking (single source of truth, spec §7.1) ────────────────────────────

export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, 8)
}

export function maskKey(key: string): string {
  if (!key) return '(empty)'
  if (key.length <= 8) return `${key.slice(0, 1)}…${key.slice(-2)}`
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

// keyId scheme MUST match services/backend apiKeyPool.js reload():
// md5(`${provider}:${key}`).hex.slice(0,12)
export function keyIdFor(provider: string, key: string): string {
  return createHash('md5').update(`${provider}:${key}`, 'utf-8').digest('hex').slice(0, 12)
}

// ── api_keys.json (pool) ────────────────────────────────────────────────────

type PoolDoc = Record<string, PoolEntry[]>

function emptyPool(): PoolDoc {
  return {}
}

async function loadPool(): Promise<PoolDoc> {
  const { data, recovered } = await safeReadJson<PoolDoc>(fileInDataHome(API_KEYS_FILE), emptyPool())
  if (recovered) appendAudit({ op: 'error', target: API_KEYS_FILE, detail: 'pool .bak 自愈恢复' })
  return data
}

export async function savePool(doc: PoolDoc): Promise<void> {
  await atomicWriteJson(fileInDataHome(API_KEYS_FILE), doc)
}

export interface PoolListResult {
  providers: ProviderView[]
  envOverlay: EnvOverlayView[]
}

// main-process-only plaintext view (health probes need real keys; NEVER
// exported to IPC — see the masking invariant at the top of this file).
export interface PlainEntry {
  provider: string
  key: string
  endpoint: string
  label: string
  disabled?: boolean
}

export async function listPoolEntriesPlain(): Promise<PlainEntry[]> {
  const doc = await loadPool()
  const out: PlainEntry[] = []
  for (const [provider, entries] of Object.entries(doc)) {
    for (const e of entries || []) {
      out.push({ provider, key: e.key, endpoint: e.endpoint || '', label: e.label || provider, disabled: e.disabled })
    }
  }
  return out
}

export async function listPool(): Promise<PoolListResult> {
  const doc = await loadPool()
  const providers: ProviderView[] = []
  for (const [provider, entries] of Object.entries(doc)) {
    const keys: MaskedKey[] = (entries || []).map((e) => ({
      keyId: keyIdFor(provider, e.key),
      label: e.label || '',
      endpoint: e.endpoint || '',
      priority: e.priority ?? 0,
      enabled: !e.disabled,
      source: 'pool',
      mask: maskKey(e.key),
      fingerprint: keyFingerprint(e.key)
    }))
    providers.push({ id: provider, keys })
  }
  const envOverlay: EnvOverlayView[] = Object.entries(ENV_PROVIDER_MAP).map(([provider, m]) => ({
    provider,
    envName: m.keyEnv,
    set: Boolean(process.env[m.keyEnv])
  }))
  return { providers, envOverlay }
}

export interface AddKeyResult {
  ok: boolean
  keyId?: string
  provider?: string
  error?: string
}

export async function addKey(input: {
  provider: string
  label?: string
  endpoint?: string
  key?: string
  priority?: number
}): Promise<AddKeyResult> {
  const provider = String(input.provider || '').trim().toLowerCase()
  if (!provider) return { ok: false, error: 'provider 必填' }
  const key = String(input.key || '').trim()
  const endpoint = String(input.endpoint || '').trim()
  const doc = await loadPool()
  const entries: PoolEntry[] = Array.isArray(doc[provider]) ? doc[provider] : []
  const dup = key ? entries.find((e) => e.key === key) : undefined
  if (dup) {
    dup.endpoint = endpoint || dup.endpoint
    dup.label = input.label || dup.label
    dup.priority = input.priority ?? dup.priority ?? 0
    dup.disabled = false
  } else {
    entries.push({
      key: key || '(endpoint-only)',
      endpoint,
      priority: input.priority ?? 0,
      label: input.label || provider,
      id: key ? keyIdFor(provider, key) : undefined
    })
  }
  doc[provider] = entries
  await savePool(doc)
  const keyId = key ? keyIdFor(provider, key) : ''
  await appendAudit({ op: 'add', target: provider, fingerprint: key ? keyFingerprint(key) : '' })
  return { ok: true, keyId, provider }
}

export interface UpdateKeyResult {
  ok: boolean
  newKeyId?: string
  error?: string
  reattachedCards?: number
}

export async function updateKey(
  provider: string,
  keyId: string,
  patch: { label?: string; endpoint?: string; key?: string; priority?: number }
): Promise<UpdateKeyResult> {
  const doc = await loadPool()
  const entries = doc[provider] || []
  const idx = entries.findIndex((e) => keyIdFor(provider, e.key) === keyId)
  if (idx < 0) return { ok: false, error: '密钥不存在 (keyId 已变更或条目被移除)' }
  const entry = entries[idx]
  if (patch.label !== undefined) entry.label = patch.label
  if (patch.endpoint !== undefined) entry.endpoint = patch.endpoint
  if (patch.priority !== undefined) entry.priority = patch.priority
  let newKeyId = keyId
  if (patch.key !== undefined && patch.key !== entry.key) {
    entry.key = patch.key
    newKeyId = keyIdFor(provider, patch.key)
    // keep card references pointing at the renamed key (credential-free store)
    const cc = await loadCcDoc()
    let reattached = 0
    for (const card of cc.cards) {
      if (card.keyId === keyId) {
        card.keyId = newKeyId
        reattached += 1
      }
    }
    if (reattached > 0) await saveCcDoc(cc)
    const result: UpdateKeyResult = { ok: true, newKeyId, reattachedCards: reattached }
    await appendAudit({ op: 'update', target: provider, fingerprint: keyFingerprint(entry.key) })
    return result
  }
  doc[provider] = entries
  await savePool(doc)
  await appendAudit({ op: 'update', target: provider, fingerprint: keyFingerprint(entry.key) })
  return { ok: true, newKeyId }
}

export interface RemoveKeyResult {
  ok: boolean
  error?: string
  blockedCards?: string[]
}

export async function removeKey(provider: string, keyId: string): Promise<RemoveKeyResult> {
  const doc = await loadPool()
  const entries = doc[provider] || []
  const idx = entries.findIndex((e) => keyIdFor(provider, e.key) === keyId)
  if (idx < 0) return { ok: false, error: '密钥不存在' }
  const cc = await loadCcDoc()
  const blocked = cc.cards.filter((c) => c.keyId === keyId && c.enabled).map((c) => c.id)
  if (blocked.length > 0) {
    return {
      ok: false,
      error: `被 ${blocked.length} 张启用卡片引用，先移除或换绑卡片`,
      blockedCards: blocked
    }
  }
  entries.splice(idx, 1)
  if (entries.length === 0) delete doc[provider]
  else doc[provider] = entries
  await savePool(doc)
  const fp = keyFingerprint(entries[idx]?.key || '')
  await appendAudit({ op: 'remove', target: provider, fingerprint: fp })
  return { ok: true }
}

export async function toggleKey(provider: string, keyId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const doc = await loadPool()
  const entries = doc[provider] || []
  const idx = entries.findIndex((e) => keyIdFor(provider, e.key) === keyId)
  if (idx < 0) return { ok: false, error: '密钥不存在' }
  entries[idx].disabled = !enabled
  doc[provider] = entries
  await savePool(doc)
  await appendAudit({ op: 'toggle', target: provider, detail: enabled ? 'enable' : 'disable' })
  return { ok: true }
}

const _revealWindow = new Map<string, number>()

export interface RevealResult {
  ok: boolean
  key?: string
  error?: string
}

// The single plaintext seam: rate-limited (REVEAL_COOLDOWN_MS per key) and
// audited. Rate-limit decisions are enforced HERE so no IPC layer can bypass.
export async function revealKey(provider: string, keyId: string): Promise<RevealResult> {
  const now = Date.now()
  const last = _revealWindow.get(keyId) || 0
  if (now - last < REVEAL_COOLDOWN_MS) {
    await appendAudit({ op: 'reveal-rejected', target: provider, detail: 'cooldown' })
    return { ok: false, error: `reveal 冷却中：请 ${Math.ceil((REVEAL_COOLDOWN_MS - (now - last)) / 1000)}s 后重试` }
  }
  _revealWindow.set(keyId, now)
  const doc = await loadPool()
  const entry = (doc[provider] || []).find((e) => keyIdFor(provider, e.key) === keyId)
  if (!entry) return { ok: false, error: '密钥不存在' }
  await appendAudit({ op: 'reveal', target: provider, fingerprint: keyFingerprint(entry.key) })
  return { ok: true, key: entry.key }
}

export function _resetRevealWindow(): void {
  _revealWindow.clear()
}

// ── custom_providers.json (metadata only; keys live in the pool) ───────────

export async function listCustomProviders(): Promise<CustomProvider[]> {
  const { data } = await safeReadJson<CustomProvider[]>(fileInDataHome(CUSTOM_PROVIDERS_FILE), [])
  return Array.isArray(data) ? data : []
}

export async function addCustomProvider(p: CustomProvider): Promise<{ ok: boolean }> {
  const list = await listCustomProviders()
  const exists = list.some((x) => x.id === p.id)
  if (exists) list.splice(list.findIndex((x) => x.id === p.id), 1)
  list.push(p)
  await atomicWriteJson(fileInDataHome(CUSTOM_PROVIDERS_FILE), list)
  await appendAudit({ op: 'add', target: `custom:${p.id}` })
  return { ok: true }
}

export async function removeCustomProvider(id: string): Promise<{ ok: boolean }> {
  const list = await listCustomProviders()
  const next = list.filter((x) => x.id !== id)
  await atomicWriteJson(fileInDataHome(CUSTOM_PROVIDERS_FILE), next)
  await appendAudit({ op: 'remove', target: `custom:${id}` })
  return { ok: true }
}

// ── cc_switch.json (cards, credential-free) ─────────────────────────────────

function emptyCc(): CcSwitchDoc {
  return { schemaVersion: 1, cards: [], active: {}, apps: {} }
}

export async function loadCcDoc(): Promise<CcSwitchDoc> {
  const { data, recovered } = await safeReadJson<CcSwitchDoc>(fileInDataHome(CC_SWITCH_FILE), emptyCc())
  const doc: CcSwitchDoc = {
    schemaVersion: 1,
    cards: Array.isArray(data.cards) ? data.cards : [],
    active: data.active && typeof data.active === 'object' ? data.active : {},
    apps: data.apps && typeof data.apps === 'object' ? data.apps : {},
    agentMode: data.agentMode && typeof data.agentMode === 'object' ? data.agentMode : undefined
  }
  if (recovered) appendAudit({ op: 'error', target: CC_SWITCH_FILE, detail: 'cards .bak 自愈恢复' })
  return doc
}

export async function saveCcDoc(doc: CcSwitchDoc): Promise<void> {
  await atomicWriteJson(fileInDataHome(CC_SWITCH_FILE), doc)
}

export interface AddCardResult {
  ok: boolean
  cardId?: string
  error?: string
}

export async function addCard(input: {
  name: string
  baseUrl: string
  keyId: string
  protocol: Card['protocol']
  wireApi?: 'chat' | 'responses'
  models?: string[]
  defaultModel?: string
  apps?: string[]
}): Promise<AddCardResult> {
  const name = String(input.name || '').trim()
  const baseUrl = String(input.baseUrl || '').trim()
  if (!name || !baseUrl) return { ok: false, error: '卡片名称与端点必填' }
  const doc = await loadCcDoc()
  const id = `c_${createHash('md5').update(`${name}:${baseUrl}:${Date.now()}`).digest('hex').slice(0, 10)}`
  const now = new Date().toISOString()
  doc.cards.push({
    id,
    name,
    baseUrl,
    keyId: input.keyId || '',
    protocol: input.protocol || 'openai',
    wireApi: input.wireApi,
    models: input.models || [],
    defaultModel: input.defaultModel || input.models?.[0] || '',
    apps: input.apps || [],
    enabled: true,
    createdAt: now,
    updatedAt: now
  })
  await saveCcDoc(doc)
  await appendAudit({ op: 'add', target: `card:${id}` })
  return { ok: true, cardId: id }
}

export async function updateCard(
  cardId: string,
  patch: Partial<Pick<Card, 'name' | 'baseUrl' | 'keyId' | 'protocol' | 'wireApi' | 'models' | 'defaultModel' | 'apps' | 'enabled'>>
): Promise<{ ok: boolean; error?: string }> {
  const doc = await loadCcDoc()
  const card = doc.cards.find((c) => c.id === cardId)
  if (!card) return { ok: false, error: '卡片不存在' }
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (card as unknown as Record<string, unknown>)[k] = v
  }
  card.updatedAt = new Date().toISOString()
  await saveCcDoc(doc)
  await appendAudit({ op: 'update', target: `card:${cardId}` })
  return { ok: true }
}

export async function removeCard(cardId: string): Promise<{ ok: boolean; error?: string }> {
  const doc = await loadCcDoc()
  const idx = doc.cards.findIndex((c) => c.id === cardId)
  if (idx < 0) return { ok: false, error: '卡片不存在' }
  doc.cards.splice(idx, 1)
  for (const [app, activeId] of Object.entries(doc.active)) {
    if (activeId === cardId) delete doc.active[app]
  }
  if (doc.agentMode) {
    for (const [app, m] of Object.entries(doc.agentMode)) {
      if (m.cardId === cardId) delete doc.agentMode[app]
    }
  }
  await saveCcDoc(doc)
  await appendAudit({ op: 'remove', target: `card:${cardId}` })
  return { ok: true }
}

// ── markdown import (docs/opencode-provider-keys.md shape, spec §9) ────────

export interface ImportResult {
  added: number
  skipped: { name: string; reason: string }[]
}

// Parse "## N. Name" provider sections with | API Key | / | Base URL | rows
// (the docs/opencode-provider-keys.md shape, values may be backtick-wrapped).
// Rejects placeholder values ('<...>', 'public', '{env:...}') — they are not
// keys, they are documentation (spec §9 拒收占位值).
export async function importMarkdown(markdown: string): Promise<ImportResult> {
  const result: ImportResult = { added: 0, skipped: [] }
  const sections = markdown.split(/^##\s+/m).slice(1)
  for (const sec of sections) {
    const nameLine = sec.split('\n')[0] || ''
    const name = nameLine.replace(/^\d+\.\s*/, '').trim()
    if (!name) continue
    const cell = (label: string): string => {
      const m = sec.match(new RegExp(`\\|\\s*${label}\\s*\\|\\s*([^|]+)\\|`))
      return m ? m[1].trim().replace(/^`|`$/g, '') : ''
    }
    const key = cell('API Key')
    const endpoint = cell('Base URL')
    if (!key || !endpoint) {
      result.skipped.push({ name, reason: '缺少 API Key 或 Base URL 行' })
      continue
    }
    if (/^<.*>$/.test(key) || key === 'public' || key.startsWith('{env:')) {
      result.skipped.push({ name, reason: '占位值/环境引用，非真实密钥，拒收' })
      continue
    }
    const r = await addKey({ provider: slug(name), label: name, endpoint, key, priority: 0 })
    if (r.ok) result.added += 1
    else result.skipped.push({ name, reason: r.error || '写入失败' })
  }
  if (result.added > 0) await appendAudit({ op: 'import', detail: `${result.added} 条入库` })
  return result
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ── /models auto-fetch (spec §8b.2 模型可得性) ─────────────────────────────

export interface FetchModelsResult {
  ok: boolean
  verified: boolean
  models: string[]
  error?: string
}

// OpenAI-compatible endpoints expose GET {base}/models. Other protocols have
// no free model directory → verified:false (manual entry, never blocks save).
export async function fetchModels(
  endpoint: string,
  protocol: string,
  key: string,
  timeoutMs = 10_000
): Promise<FetchModelsResult> {
  if (protocol !== 'openai') {
    return { ok: true, verified: false, models: [], error: '该协议无公开模型目录，请手工填写模型 id' }
  }
  const base = String(endpoint || '').trim().replace(/\/v1\/?$/, '')
  const url = `${base}/v1/models`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: key ? { authorization: `Bearer ${key}` } : {}
    })
    if (res.status === 401 || res.status === 403) {
      return { ok: true, verified: false, models: [], error: '鉴权失败 (401/403)，端点可达但未验证' }
    }
    if (!res.ok) {
      return { ok: true, verified: false, models: [], error: `模型目录不可用 (${res.status})，可手工填写` }
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> }
    const models = (body.data || []).map((m) => m.id)
    return { ok: true, verified: true, models }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: true, verified: false, models: [], error: `端点不可达 (${msg.slice(0, 80)})，可手工填写` }
  } finally {
    clearTimeout(timer)
  }
}

// ── endpoint reachability validate (spec §5.2 T2: any HTTP answer = reachable)

export interface ValidateEndpointResult {
  ok: boolean
  reachable: boolean
  status?: number
  latencyMs: number
  error?: string
}

export async function validateEndpoint(
  endpoint: string,
  protocol: string,
  key: string,
  timeoutMs = 3_000
): Promise<ValidateEndpointResult> {
  const base = String(endpoint || '').trim().replace(/\/v1\/?$/, '')
  const url = `${base}/v1/models`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  const authHeaders: Record<string, string> = {}
  if (key) {
    if (protocol === 'anthropic') authHeaders['x-api-key'] = key
    else authHeaders.authorization = `Bearer ${key}`
  }
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: authHeaders
    })
    return { ok: true, reachable: true, status: res.status, latencyMs: Date.now() - t0 }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: true, reachable: false, latencyMs: Date.now() - t0, error: msg.slice(0, 80) }
  } finally {
    clearTimeout(timer)
  }
}

// ── audit file path (for tests + MANIFEST) ─────────────────────────────────

export function auditFilePath(): string {
  return fileInDataHome(AUDIT_FILE)
}

// ── preset catalog: backend SSoT first, built-in fallback (spec §4.3) ──────

// Degraded-mode fallback catalog ONLY (used when the backend
// providerPresets.js SSoT is unresolvable). The full catalog — including
// local endpoints (Ollama etc., which carry env-overridable default ports)
// — lives in services/backend/src/services/gateway/providerPresets.js. This
// fallback deliberately pins only the port-less public cloud endpoints so it
// can never silently fork the backend's defaults (repo rule 1).
const BUILTIN_PRESETS: Omit<PresetView, 'source'>[] = [
  { id: 'openai', label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai', defaultModel: 'gpt-4o-mini', keyField: 'authorization_bearer' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic', defaultModel: 'claude-sonnet-4-5', keyField: 'x-api-key' },
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiFormat: 'gemini', defaultModel: 'gemini-2.5-pro', keyField: 'x-goog-api-key' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiFormat: 'openai', defaultModel: 'deepseek-chat', keyField: 'authorization_bearer' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiFormat: 'openai', defaultModel: '', keyField: 'authorization_bearer' }
]

let _presetCache: { at: number; presets: PresetView[]; source: PresetView['source'] } | null = null

export async function loadPresets(force = false): Promise<PresetView[]> {
  if (!force && _presetCache && Date.now() - _presetCache.at < 300_000) return _presetCache.presets
  // Prefer the backend SSoT (services/backend/src/services/gateway/providerPresets.js)
  try {
    const { resolveBackendServicesRoot } = await import('./agentWriters.ts')
    const root = resolveBackendServicesRoot()
    if (root) {
      const { createRequire } = await import('node:module')
      const req = createRequire(path.join(root, 'noop.js'))
      const presets = req(path.join(root, 'gateway/providerPresets.js')).getProviderPresets()
      if (Array.isArray(presets) && presets.length > 0) {
        const mapped: PresetView[] = presets.map((p: PresetView) => ({
          id: p.id,
          label: p.label || p.id,
          baseUrl: p.baseUrl || '',
          apiFormat: p.apiFormat || 'openai',
          defaultModel: p.defaultModel || '',
          keyField: p.keyField || 'authorization_bearer',
          source: 'backend'
        }))
        _presetCache = { at: Date.now(), presets: mapped, source: 'backend' }
        return mapped
      }
    }
  } catch {
    /* fall through to built-in fallback */
  }
  _presetCache = { at: Date.now(), presets: BUILTIN_PRESETS.map((p) => ({ ...p, source: 'builtin-fallback' })), source: 'builtin-fallback' }
  return _presetCache.presets
}

export function _resetPresetCache(): void {
  _presetCache = null
}
