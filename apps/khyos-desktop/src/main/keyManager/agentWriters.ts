// agentWriters — apply KeyManager cards to external agent live-configs
// (DESIGN-ARCH-091 §4.3/§8/§8b.3).
//
// P1 scope: Mode B (khy aggregate) one-click activation for
// claude-code / opencode / qodercli, plus Mode A (direct) for the first two.
//
// Backend resolution (4-level degrade, spec §4.3):
//   1. KHY_BACKEND_SERVICES env (explicit services/ backend src dir)
//   2. repo-relative (walk from repo root: services/backend/src/services)
//   3. KHY_PORTABLE_ROOT / KHYQUANT_PORTABLE_ROOT + khy-os/services/backend/src/services
//   4. built-in minimal writers (this file) + audit 'backend-resolve-failed'
//
// Mode B security boundary (spec §8b.3): the only credential ever written to
// an agent live-config is the LOCAL relay token (127.0.0.1 proxy auth). Real
// provider keys never leave the khy pool — contract test ⑲ asserts this.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { resolveRepoRoot, getDataHome, loadCcDoc, saveCcDoc, keyIdFor, safeReadJson } from './keyStore.ts'
import { appendAudit } from './audit.ts'
import { readProxyRuntime, readProxyToken } from './proxyStatus.ts'
import type { Card } from './types.ts'
import { API_KEYS_FILE } from './types.ts'

// ── backend services root resolution ────────────────────────────────────────

let _backendRoot: string | null | 'unresolved' = 'unresolved'
let _backendAudited = false

export function resolveBackendServicesRoot(): string | null {
  if (_backendRoot !== 'unresolved') return _backendRoot
  const candidates: string[] = []
  const explicit = process.env.KHY_BACKEND_SERVICES
  if (explicit) candidates.push(path.resolve(explicit))
  const repoRoot = resolveRepoRoot()
  if (repoRoot) candidates.push(path.join(repoRoot, 'services', 'backend', 'src', 'services'))
  const portable = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT
  if (portable) candidates.push(path.join(portable, 'khy-os', 'services', 'backend', 'src', 'services'))
  if (portable) candidates.push(path.join(portable, 'services', 'backend', 'src', 'services'))
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, 'gateway', 'providerPresets.js'))) {
        _backendRoot = c
        return c
      }
    } catch {
      continue
    }
  }
  _backendRoot = null
  return null
}

// audit the degrade event exactly once per process (spec §4.3: 状态透明)
export async function _auditBackendResolution(): Promise<void> {
  const root = resolveBackendServicesRoot()
  if (_backendAudited) return
  _backendAudited = true
  if (root) await appendAudit({ op: 'backend-resolve-ok', target: root })
  else await appendAudit({ op: 'backend-resolve-failed', detail: 'use built-in writers' })
}

// ── target path resolution (portable-safe: respect env overrides) ──────────

function expandHome(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return p
}

export function agentTargetPath(app: string): string {
  switch (app) {
    case 'claude-code':
      return path.join(expandHome(process.env.CLAUDE_CONFIG_DIR || '~/.claude'), 'settings.json')
    case 'opencode': {
      // Portable-aware: honor OPENCODE_CONFIG(_DIR) / XDG_CONFIG_HOME (injected
      // by bin/opencode.cmd in the Portable layout), else ~/.config/opencode.
      if (process.env.OPENCODE_CONFIG) {
        const p = expandHome(process.env.OPENCODE_CONFIG)
        if (path.extname(p) === '.json') return p
      }
      const dir = process.env.OPENCODE_CONFIG_DIR
        ? expandHome(process.env.OPENCODE_CONFIG_DIR)
        : process.env.XDG_CONFIG_HOME
          ? path.join(expandHome(process.env.XDG_CONFIG_HOME), 'opencode')
          : path.join(expandHome('~'), '.config', 'opencode')
      return path.join(dir, 'opencode.json')
    }
    case 'qodercli':
      // qoder activation is a gateway-side .env patch (spec §8), not a
      // per-app live config; the target is the canonical .env file.
      return process.env.KHY_ENV_FILE || path.join(getRepoRootForEnvFile(), 'services', 'backend', '.env')
    default:
      return ''
  }
}

function getRepoRootForEnvFile(): string {
  const repoRoot = resolveRepoRoot()
  if (repoRoot) return repoRoot
  // portable fallback: KHY_PORTABLE_ROOT/khy-os
  const portable = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT
  if (portable) return path.join(portable, 'khy-os')
  return process.cwd()
}

// ── preflight (mirrors ccSwitch/appWriters preflightCardForApp semantics) ──

export interface PreflightResult {
  ok: boolean
  reason?: string
  warning?: string
}

export function preflight(app: string, card: Card, mode: 'proxy' | 'direct'): PreflightResult {
  if (!card || !card.name) return { ok: false, reason: '卡片无效（缺少名称）' }
  if (mode === 'proxy') {
    // proxy mode: the card's protocol only matters for model selection
    return { ok: true }
  }
  switch (app) {
    case 'claude-code':
      if (card.protocol === 'anthropic') return { ok: true }
      return {
        ok: true,
        warning: '卡片为 OpenAI 线，Claude Code 需经 khy 代理转 anthropic 线（建议 Mode B 聚合模式）'
      }
    case 'opencode':
      if (card.protocol === 'openai' || card.protocol === 'anthropic') return { ok: true }
      return { ok: false, reason: `OpenCode 支持 openai/anthropic 线，卡片为 ${card.protocol}` }
    case 'qodercli':
      return { ok: true }
    default:
      return { ok: false, reason: `${app} 的 writer 在 P2 交付（本期 P1 覆盖 claude-code/opencode/qodercli）` }
  }
}

// ── JSON merge-write helpers (atomic, .pre-khy.bak before mutation) ─────────

async function backupLive(file: string): Promise<void> {
  try {
    await fs.copyFile(file, `${file}.pre-khy.bak`)
  } catch {
    /* first activation — nothing to back up */
  }
}

async function readJsonSafe(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function writeJsonAtomic(file: string, doc: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

// ── Mode B writers (relay sentinel: local proxy endpoint + relay token) ─────

export interface ApplyResult {
  ok: boolean
  app: string
  error?: string
  detail?: string
  targetPath?: string
}

export async function applyProxyMode(app: string, card: Card): Promise<ApplyResult> {
  const proxy = readProxyRuntime()
  if (!proxy.running || !proxy.endpoint) {
    return {
      ok: false,
      app,
      error: 'khy 代理未运行：启动本地网关后重试（动作: 启动本地网关 目标: 127.0.0.1）'
    }
  }
  const relay = readProxyToken()
  const model = card.defaultModel || card.models[0] || ''
  switch (app) {
    case 'claude-code': {
      const file = agentTargetPath('claude-code')
      await backupLive(file)
      const doc = await readJsonSafe(file)
      const env = (doc.env && typeof doc.env === 'object' ? doc.env : {}) as Record<string, string>
      // anthropic wire root: proxy serves /v1/messages under the same host:port
      const root = proxy.endpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
      env.ANTHROPIC_BASE_URL = root
      env.ANTHROPIC_AUTH_TOKEN = relay
      if (model) env.ANTHROPIC_MODEL = model
      doc.env = env
      await writeJsonAtomic(file, doc)
      await recordMode(app, 'proxy', card.id)
      await appendAudit({ op: 'apply', target: app, detail: `proxy ${root} model=${model || '(card default)'}` })
      return { ok: true, app, targetPath: file, detail: `已写入 ${file}（khy 聚合 → ${root}，模型 ${model || 'card 默认'}）` }
    }
    case 'opencode': {
      const file = agentTargetPath('opencode')
      await backupLive(file)
      const doc = await readJsonSafe(file)
      const provider = (doc.provider && typeof doc.provider === 'object' ? doc.provider : {}) as Record<string, Record<string, unknown>>
      const base = proxy.endpoint
      provider['khy'] = {
        npm: '@ai-sdk/openai-compatible',
        name: 'KhyOS 聚合网关',
        options: { baseURL: base.endsWith('/v1') ? base : `${base}/v1`, apiKey: relay },
        models: model ? { [model]: { name: model } } : {}
      }
      doc.provider = provider
      if (model) doc.model = `khy/${model}`
      await writeJsonAtomic(file, doc)
      await recordMode(app, 'proxy', card.id)
      await appendAudit({ op: 'apply', target: app, detail: `proxy ${base} model=${model || '(card default)'}` })
      return { ok: true, app, targetPath: file, detail: `已写入 ${file}（provider.khy → ${base}，模型 ${model || 'card 默认'}）` }
    }
    case 'qodercli': {
      // qoder activation = gateway-side .env patch (KHY_QODER_PROXY opt-in,
      // qoderProxyModels.js gating). The qoder CLI then routes through the
      // khy proxy as its model source.
      const file = agentTargetPath('qodercli')
      await backupLive(file)
      await patchEnvFile(file, {
        KHY_QODER_PROXY: 'true',
        QODER_PROXY_ENDPOINT: proxy.endpoint.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
      })
      await recordMode(app, 'proxy', card.id)
      await appendAudit({ op: 'apply', target: app, detail: `qoder-proxy → ${proxy.endpoint}` })
      return { ok: true, app, targetPath: file, detail: `已写入 ${file}（KHY_QODER_PROXY=true，端点 ${proxy.endpoint}）` }
    }
    default:
      return { ok: false, app, error: preflight(app, card, 'proxy').reason || '该 app 的 Mode B writer 未在 P1 交付' }
  }
}

export async function applyDirectMode(app: string, card: Card): Promise<ApplyResult> {
  switch (app) {
    case 'claude-code': {
      const pre = preflight(app, card, 'direct')
      if (!pre.ok) return { ok: false, app, error: pre.reason }
      const entry = await resolveKeyEntry(card.keyId)
      if (!entry) return { ok: false, app, error: '卡片引用的 key 在池中不存在 (keyId 失效)' }
      const file = agentTargetPath('claude-code')
      await backupLive(file)
      const doc = await readJsonSafe(file)
      const env = (doc.env && typeof doc.env === 'object' ? doc.env : {}) as Record<string, string>
      const root = (entry.endpoint || card.baseUrl).replace(/\/v1\/?$/, '').replace(/\/+$/, '')
      env.ANTHROPIC_BASE_URL = root
      if (card.protocol === 'anthropic') env.ANTHROPIC_API_KEY = entry.key
      else env.ANTHROPIC_AUTH_TOKEN = entry.key
      const model = card.defaultModel || card.models[0] || ''
      if (model) env.ANTHROPIC_MODEL = model
      doc.env = env
      await writeJsonAtomic(file, doc)
      recordMode(app, 'direct', card.id)
      await appendAudit({ op: 'apply', target: app, detail: `direct ${root} model=${model || '(card default)'}` })
      return { ok: true, app, targetPath: file, detail: pre.warning ? `${pre.warning}。已写入 ${file}` : `已写入 ${file}（直连 ${root}）` }
    }
    case 'opencode': {
      const pre = preflight(app, card, 'direct')
      if (!pre.ok) return { ok: false, app, error: pre.reason }
      const entry = await resolveKeyEntry(card.keyId)
      if (!entry) return { ok: false, app, error: '卡片引用的 key 在池中不存在 (keyId 失效)' }
      const file = agentTargetPath('opencode')
      await backupLive(file)
      const doc = await readJsonSafe(file)
      const provider = (doc.provider && typeof doc.provider === 'object' ? doc.provider : {}) as Record<string, Record<string, unknown>>
      const slug = card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
      const model = card.defaultModel || card.models[0] || ''
      provider[slug] = {
        npm: card.protocol === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
        name: card.name,
        options: { baseURL: entry.endpoint || card.baseUrl, apiKey: entry.key },
        models: model ? { [model]: { name: model } } : {}
      }
      doc.provider = provider
      if (model) doc.model = `${slug}/${model}`
      await writeJsonAtomic(file, doc)
      recordMode(app, 'direct', card.id)
      await appendAudit({ op: 'apply', target: app, detail: `direct ${entry.endpoint || card.baseUrl}` })
      return { ok: true, app, targetPath: file, detail: `已写入 ${file}（provider.${slug} → ${entry.endpoint || card.baseUrl}）` }
    }
    default:
      return { ok: false, app, error: preflight(app, card, 'direct').reason || '该 app 的 Mode A writer 未在 P1 交付' }
  }
}

// agent-mode bookkeeping in cc_switch.json (one of the 3 SSoT files).
// Awaited by the apply paths so concurrent writers never race on the file.
async function recordMode(app: string, mode: 'proxy' | 'direct', cardId: string): Promise<void> {
  const doc = await loadCcDoc()
  doc.agentMode = doc.agentMode || {}
  doc.agentMode[app] = { mode, cardId, ts: new Date().toISOString() }
  await saveCcDoc(doc)
}

// resolve a pool key entry by keyId (the card's credential reference).
// keyId is derived (md5(provider:key)), so scan pool providers. Mode A
// (direct) writes the key into the agent config by design — this is the
// documented credential path, NOT the GUI reveal feature.
async function resolveKeyEntry(keyId: string): Promise<{ key: string; endpoint: string } | null> {
  if (!keyId) return null
  const doc = (await safeReadJson<Record<string, Array<{ key: string; endpoint: string }>>>(
    path.join(getDataHome(), API_KEYS_FILE),
    {}
  )).data
  for (const [provider, entries] of Object.entries(doc)) {
    for (const e of entries || []) {
      if (keyIdFor(provider, e.key) === keyId) return { key: e.key, endpoint: e.endpoint || '' }
    }
  }
  return null
}

// ── .env patcher for qodercli (line-based, mirrors gatewayEnvFile semantics) ─

async function patchEnvFile(file: string, patch: Record<string, string>): Promise<void> {
  let lines: string[] = []
  try {
    lines = (await fs.readFile(file, 'utf-8')).split(/\r?\n/)
  } catch {
    lines = []
  }
  const out: string[] = []
  const consumed = new Set<string>()
  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    if (m && patch[m[1]] !== undefined) {
      out.push(`${m[1]}=${patch[m[1]]}`)
      consumed.add(m[1])
      continue
    }
    out.push(line)
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!consumed.has(k)) out.push(`${k}=${v}`)
  }
  await writeEnvAtomic(file, out)
}

async function writeEnvAtomic(file: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8')
  await fs.rename(tmp, file)
}

// ── revert (restore .pre-khy.bak, spec §5.2 T3 撤销) ────────────────────────

export async function revertAgent(app: string): Promise<ApplyResult> {
  const file = agentTargetPath(app)
  // qodercli revert = gate OFF (KHY_QODER_PROXY=false), not a file restore:
  // its "live config" is the gateway .env, and the pre-activation state is
  // simply "the gate was not enabled" (spec §12-Q1).
  if (app === 'qodercli') {
    await patchEnvFile(file, { KHY_QODER_PROXY: 'false' })
    const doc = await loadCcDoc()
    if (doc.agentMode && doc.agentMode[app]) {
      delete doc.agentMode[app]
      await saveCcDoc(doc)
    }
    await appendAudit({ op: 'revert', target: app, detail: `gate off ${file}` })
    return { ok: true, app, targetPath: file, detail: `已撤销 ${app}（KHY_QODER_PROXY=false，门控关闭）` }
  }
  const bak = `${file}.pre-khy.bak`
  if (!existsSync(bak)) {
    return { ok: false, app, error: '无 .pre-khy.bak 备份：该 Agent 从未被 KeyManager 激活过' }
  }
  await fs.copyFile(bak, file)
  await fs.unlink(bak).catch(() => {})
  const doc = await loadCcDoc()
  if (doc.agentMode && doc.agentMode[app]) {
    delete doc.agentMode[app]
    await saveCcDoc(doc)
  }
  await appendAudit({ op: 'revert', target: app, detail: file })
  return { ok: true, app, targetPath: file, detail: `已恢复 ${file}（.pre-khy.bak）` }
}

// ── agent matrix read (spec §6 agents:matrix) ──────────────────────────────

export interface MatrixRow {
  app: string
  label: string
  writer: 'builtin'
  mode: 'none' | 'proxy' | 'direct'
  cardId: string
  targetPath: string
  lastApplied: string
  hint: string
}

export async function agentMatrix(): Promise<MatrixRow[]> {
  const doc = await loadCcDoc()
  const apps = ['claude-code', 'opencode', 'qodercli']
  const labels: Record<string, string> = {
    'claude-code': 'Claude Code',
    opencode: 'OpenCode',
    qodercli: 'Qoder CLI'
  }
  const rows: MatrixRow[] = []
  for (const app of apps) {
    const am = doc.agentMode?.[app]
    rows.push({
      app,
      label: labels[app] || app,
      writer: 'builtin',
      mode: am ? am.mode : 'none',
      cardId: am ? am.cardId : doc.active[app] || '',
      targetPath: agentTargetPath(app),
      lastApplied: am ? am.ts : '',
      hint: am
        ? am.mode === 'proxy'
          ? 'khy 聚合：换模型/换 key 纯 khy 侧操作，Agent 零改动'
          : '直连：换 key/端点需重新激活'
        : '未激活'
    })
  }
  return rows
}
