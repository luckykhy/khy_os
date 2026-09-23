// providers — Provider Card Hub 数据层（DESIGN-ARCH-094 §4）。
//
// 直接读写 dataHome 下 cc_switch.json（与 khy CLI / khyos-desktop keyManager
// 同库，schemaVersion=1 同构，不造第四套存储）。卡片无凭据设计：keyId 仅引用
// api_keys.json 密钥池，明文 key 绝不落卡片文件。
//
// 原子写 + .bak 自愈对齐 services/backend configGuard 语义；激活卡不可删
// （cc-switch「删不掉的当前激活」不变式）。

import { promises as fs, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { API_KEYS_FILE, CC_SWITCH_FILE, AUDIT_FILE } from './types.ts'
import type { Card, CcSwitchDoc, MaskedPoolKey, PoolEntry } from './types.ts'

// ── dataHome 解析（便携安全，镜像 khyos-desktop keyStore 的四级顺序）─────────
//   1. KHY_DATA_HOME env（显式覆盖，测试用）
//   2. KHY_PORTABLE_ROOT / KHYQUANT_PORTABLE_ROOT + '.khy'
//   3. KHYPHUB_REPO_ROOT 或从本模块上溯找 .portable 标记 → '<root>/.khy'
//   4. os.homedir()/.khy 兜底（永不失败）
let _dataHome: string | null = null

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
  const explicitRepo = process.env.KHYPHUB_REPO_ROOT
  if (explicitRepo) {
    _dataHome = path.join(explicitRepo, '.khy')
    return _dataHome
  }
  const repoRoot = _walkForPortableRoot()
  if (repoRoot) {
    _dataHome = path.join(repoRoot, '.khy')
    return _dataHome
  }
  _dataHome = path.join(os.homedir(), '.khy')
  return _dataHome
}

export function _resetDataHomeCache(): void {
  _dataHome = null
}

function _walkForPortableRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i += 1) {
    try {
      if (existsSync(path.join(dir, '.portable'))) return dir
    } catch {
      break
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function fileInDataHome(name: string): string {
  return path.join(getDataHome(), name)
}

// ── 原子写 + .bak 自愈 ───────────────────────────────────────────────────────

let _tmpSeq = 0

export async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${dir}/${path.basename(file)}.tmp-${process.pid}-${_tmpSeq++}`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  // Windows: rename-over may hit EPERM when another handle is briefly holding
  // the target (concurrent readers). Retry with backoff, then fall back to a
  // direct overwrite (atomicity degrades gracefully; .bak remains the
  // self-heal source of truth).
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
  // .bak = 最近一次成功写入（损坏自愈恢复到最新状态，而非上一份）
  try {
    await fs.copyFile(file, `${file}.bak`)
  } catch {
    /* 备份失败不阻塞（自愈源缺失只是降级） */
  }
}

interface SafeReadResult<T> {
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
    try {
      const bak = await fs.readFile(`${file}.bak`, 'utf-8')
      const parsed = JSON.parse(bak) as T
      await atomicWriteJson(file, parsed)
      return { data: parsed, recovered: true }
    } catch {
      return { data: fallback, recovered: false }
    }
  }
}

// ── 密钥脱敏（SSoT 语义与后端 apiKeyPool 对齐：keyId=md5(provider:key).12）────

export function keyIdFor(provider: string, key: string): string {
  return createHash('md5').update(`${provider}:${key}`, 'utf-8').digest('hex').slice(0, 12)
}

export function maskKey(key: string): string {
  if (!key) return '(empty)'
  if (key.length <= 8) return `${key.slice(0, 1)}…${key.slice(-2)}`
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

export function keyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, 8)
}

// ── cc_switch.json 卡片 CRUD ────────────────────────────────────────────────

function emptyDoc(): CcSwitchDoc {
  return { schemaVersion: 1, cards: [], active: {}, failover: {}, apps: {} }
}

export interface ListCardsResult {
  cards: Card[]
  active: Record<string, string>
  failover: Record<string, string[]>
  agentMode: Record<string, { mode: string; cardId: string; ts: string }>
  recovered: boolean
}

export async function loadCcDoc(): Promise<{ doc: CcSwitchDoc; recovered: boolean }> {
  const { data, recovered } = await safeReadJson<CcSwitchDoc>(fileInDataHome(CC_SWITCH_FILE), emptyDoc())
  const doc: CcSwitchDoc = {
    schemaVersion: 1,
    cards: Array.isArray(data.cards) ? data.cards : [],
    active: data.active && typeof data.active === 'object' ? data.active : {},
    failover: data.failover && typeof data.failover === 'object' ? data.failover : {},
    apps: data.apps && typeof data.apps === 'object' ? data.apps : {},
    agentMode: data.agentMode && typeof data.agentMode === 'object' ? data.agentMode : undefined
  }
  return { doc, recovered }
}

async function saveCcDoc(doc: CcSwitchDoc): Promise<void> {
  await atomicWriteJson(fileInDataHome(CC_SWITCH_FILE), doc)
}

export async function listCards(): Promise<ListCardsResult> {
  const { doc, recovered } = await loadCcDoc()
  const known = new Set(doc.cards.map((c) => c.id))
  const failover: Record<string, string[]> = {}
  for (const [app, ids] of Object.entries(doc.failover || {})) {
    failover[app] = (Array.isArray(ids) ? ids : []).filter((id) => known.has(id))
  }
  return { cards: doc.cards, active: doc.active, failover, agentMode: doc.agentMode || {}, recovered }
}

export interface CardResult {
  ok: boolean
  cardId?: string
  error?: string
  activeApps?: string[]
}

export async function addCard(input: {
  name: string
  baseUrl: string
  keyId?: string
  protocol?: Card['protocol']
  wireApi?: Card['wireApi']
  models?: string[]
  defaultModel?: string
  apps?: string[]
}): Promise<CardResult> {
  const name = String(input.name || '').trim()
  const baseUrl = String(input.baseUrl || '').trim()
  if (!name || !baseUrl) return { ok: false, error: '卡片名称与端点必填' }
  const { doc } = await loadCcDoc()
  // 去重：同名同端点视为同一张卡（cc-switch「Universal provider」语义）
  const dup = doc.cards.find((c) => c.name === name && c.baseUrl === baseUrl)
  if (dup) return { ok: true, cardId: dup.id }
  const id = `c_${createHash('md5').update(`${name}:${baseUrl}:${Date.now()}`).digest('hex').slice(0, 10)}`
  const now = new Date().toISOString()
  const models = input.models || []
  doc.cards.push({
    id,
    name,
    baseUrl,
    keyId: input.keyId || '',
    protocol: input.protocol || 'openai',
    wireApi: input.wireApi,
    models,
    defaultModel: input.defaultModel || models[0] || '',
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
): Promise<CardResult> {
  const { doc } = await loadCcDoc()
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

export async function duplicateCard(cardId: string): Promise<CardResult> {
  const { doc } = await loadCcDoc()
  const src = doc.cards.find((c) => c.id === cardId)
  if (!src) return { ok: false, error: '卡片不存在' }
  const id = `c_${createHash('md5').update(`${src.name}:${src.baseUrl}:dup:${Date.now()}`).digest('hex').slice(0, 10)}`
  const now = new Date().toISOString()
  doc.cards.push({
    ...src,
    id,
    name: `${src.name}-copy`,
    enabled: false,
    createdAt: now,
    updatedAt: now
  })
  await saveCcDoc(doc)
  await appendAudit({ op: 'duplicate', target: `card:${id}`, detail: `from ${cardId}` })
  return { ok: true, cardId: id }
}

/** 删除保护：被任一工具激活（active）或 agentMode 绑定的卡不可删（cc-switch 不变式）。 */
export async function removeCard(cardId: string): Promise<CardResult> {
  const { doc } = await loadCcDoc()
  const idx = doc.cards.findIndex((c) => c.id === cardId)
  if (idx < 0) return { ok: false, error: '卡片不存在' }
  const activeApps = Object.entries(doc.active)
    .filter(([, id]) => id === cardId)
    .map(([app]) => app)
  for (const [app, m] of Object.entries(doc.agentMode || {})) {
    if (m?.cardId === cardId && !activeApps.includes(app)) activeApps.push(app)
  }
  if (activeApps.length > 0) {
    return {
      ok: false,
      activeApps,
      error: `该卡正被 ${activeApps.join(' / ')} 激活，先切换到其它卡片再删除`
    }
  }
  doc.cards.splice(idx, 1)
  await saveCcDoc(doc)
  await appendAudit({ op: 'remove', target: `card:${cardId}` })
  return { ok: true }
}

export async function reorderCards(cardId: string, toIndex: number): Promise<CardResult> {
  const { doc } = await loadCcDoc()
  const from = doc.cards.findIndex((c) => c.id === cardId)
  if (from < 0) return { ok: false, error: '卡片不存在' }
  const [card] = doc.cards.splice(from, 1)
  const clamped = Math.max(0, Math.min(toIndex, doc.cards.length))
  doc.cards.splice(clamped, 0, card)
  await saveCcDoc(doc)
  return { ok: true }
}

export async function setActive(app: string, cardId: string): Promise<CardResult> {
  const { doc } = await loadCcDoc()
  if (!doc.cards.some((c) => c.id === cardId)) return { ok: false, error: '卡片不存在' }
  doc.active[app] = cardId
  await saveCcDoc(doc)
  await appendAudit({ op: 'activate', target: app, detail: cardId })
  return { ok: true }
}

export async function clearActive(app: string): Promise<CardResult> {
  const { doc } = await loadCcDoc()
  delete doc.active[app]
  await saveCcDoc(doc)
  return { ok: true }
}

// ── failover 备卡队列（P3：健康探测失败后一键轮换）────────────────────────

export async function setFailover(app: string, cardIds: string[]): Promise<CardResult> {
  const { doc } = await loadCcDoc()
  const known = new Set(doc.cards.map((c) => c.id))
  doc.failover = doc.failover || {}
  doc.failover[app] = (Array.isArray(cardIds) ? cardIds : []).filter((id) => known.has(id))
  await saveCcDoc(doc)
  await appendAudit({ op: 'failover-set', target: app, detail: `${doc.failover[app].length} 张备卡` })
  return { ok: true }
}

export interface RotateResult {
  ok: boolean
  promoted?: string
  retired?: string
  error?: string
}

/** 轮转：队首晋级为 active，原 active 降级到队尾（无 active 时 retired 为空串）。 */
export async function rotateFailover(app: string): Promise<RotateResult> {
  const { doc } = await loadCcDoc()
  const known = new Set(doc.cards.map((c) => c.id))
  const queue = ((doc.failover || {})[app] || []).filter((id) => known.has(id))
  const activeId = doc.active[app] || ''
  if (queue.length === 0) {
    const error = activeId
      ? `无备用卡片：该工具未设置 failover 队列（动作: setFailover 添加备卡 目标: ${app}）`
      : `未激活且无备用卡片：${app} 没有可轮换的卡片`
    return { ok: false, error }
  }
  const promoted = queue[0]
  queue.shift()
  if (activeId) queue.push(activeId)
  doc.failover = doc.failover || {}
  doc.failover[app] = queue
  doc.active[app] = promoted
  await saveCcDoc(doc)
  await appendAudit({ op: 'failover-rotate', target: app, detail: `${activeId || '(none)'} → ${promoted}` })
  return { ok: true, promoted, retired: activeId }
}

// ── api_keys.json 池视图（只读 + 脱敏；写入走 addKey）───────────────────────

type PoolDoc = Record<string, PoolEntry[]>

async function loadPool(): Promise<PoolDoc> {
  const { data } = await safeReadJson<PoolDoc>(fileInDataHome(API_KEYS_FILE), {})
  return data && typeof data === 'object' ? data : {}
}

export interface PoolView {
  providers: Array<{ id: string; keys: MaskedPoolKey[] }>
}

export async function listPoolMasked(): Promise<PoolView> {
  const doc = await loadPool()
  const providers: PoolView['providers'] = []
  for (const [provider, entries] of Object.entries(doc)) {
    const keys = (entries || []).map((e) => ({
      keyId: keyIdFor(provider, e.key),
      label: e.label || '',
      endpoint: e.endpoint || '',
      mask: maskKey(e.key),
      fingerprint: keyFingerprint(e.key)
    }))
    providers.push({ id: provider, keys })
  }
  return { providers }
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
  key: string
  priority?: number
}): Promise<AddKeyResult> {
  const provider = String(input.provider || '').trim().toLowerCase()
  const key = String(input.key || '').trim()
  if (!provider || !key) return { ok: false, error: 'provider 与 key 必填' }
  const doc = await loadPool()
  const entries: PoolEntry[] = Array.isArray(doc[provider]) ? doc[provider] : []
  const dup = entries.find((e) => e.key === key)
  if (dup) {
    dup.endpoint = input.endpoint || dup.endpoint
    dup.label = input.label || dup.label
  } else {
    entries.push({
      key,
      endpoint: input.endpoint || '',
      label: input.label || provider,
      priority: input.priority ?? 0,
      id: keyIdFor(provider, key)
    })
  }
  doc[provider] = entries
  await atomicWriteJson(fileInDataHome(API_KEYS_FILE), doc)
  await appendAudit({ op: 'add', target: provider, fingerprint: keyFingerprint(key) })
  return { ok: true, keyId: keyIdFor(provider, key), provider }
}

// ── 审计（追加式 jsonl，脱敏：只记 fingerprint/目标，不记明文 key）──────────

export async function appendAudit(event: { op: string; target?: string; detail?: string; fingerprint?: string }): Promise<void> {
  try {
    const line = `${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n`
    const file = fileInDataHome(AUDIT_FILE)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.appendFile(file, line, 'utf-8')
  } catch {
    /* 审计失败不阻塞主流程（fail-soft，状态透明：调用方仍拿到结果） */
  }
}
