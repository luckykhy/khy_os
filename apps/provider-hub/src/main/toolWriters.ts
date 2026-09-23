// toolWriters — Provider Card Hub 的工具矩阵写入层（DESIGN-ARCH-094 §4/§5 M1）。
//
// 四级 backend 解析（与 khyos-desktop agentWriters 同构，降级可审计）：
//   1. KHY_BACKEND_SERVICES env（显式指向 services/backend/src/services）
//   2. 便携根 KHY_PORTABLE_ROOT / KHYQUANT_PORTABLE_ROOT 下的 khy-os 或直挂布局
//   3. 从本模块上溯 .portable 标记 → 仓库根 + services/backend/src/services
//   4. 未解析 → 内置降级：全部操作 fail-soft 报错 + 审计 'backend-resolve-failed'
//
// 解析成功时直接 require 后端 SSoT（ccSwitch/appWriters 等），工具写入语义
// （preflight / zcode 登录门 / 协议约束）以后端为唯一真源，本模块不复制。

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendAudit } from './providers.ts'
import type { Card } from './types.ts'

type BackendModule = {
  applyCardToApp: (card: unknown, app: string, opts?: Record<string, unknown>) => Promise<{ success: boolean; error?: string; detail?: unknown }>
  detectCardInApp: (app: string) => { success: boolean; providers: Array<Record<string, unknown>>; error?: string }
  preflightCardForApp: (card: unknown, app: string) => { ok: boolean; reason?: string; warning?: string }
}

let _root: string | null | undefined
let _backend: BackendModule | null | undefined
let _auditDone = false

/** 四级 backend 解析（结果缓存；env 变化需重启进程——状态透明，不静默热切）。 */
export function resolveBackendServicesRoot(): string | null {
  if (_root !== undefined) return _root
  const candidates: string[] = []
  const explicit = process.env.KHY_BACKEND_SERVICES
  if (explicit) candidates.push(path.resolve(explicit))
  const portable = process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT
  if (portable) {
    candidates.push(path.join(portable, 'khy-os', 'services', 'backend', 'src', 'services'))
    candidates.push(path.join(portable, 'services', 'backend', 'src', 'services'))
  }
  const walked = _walkRepoRoot()
  if (walked) candidates.push(path.join(walked, 'services', 'backend', 'src', 'services'))
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, 'gateway', 'providerPresets.js'))) {
        _root = c
        return c
      }
    } catch {
      continue
    }
  }
  _root = null
  return null
}

function _walkRepoRoot(): string | null {
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
  // 非便携安装：上溯找 services/backend/src/services 本身
  dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'services', 'backend', 'src', 'services', 'gateway', 'providerPresets.js'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function loadBackend(): BackendModule | null {
  if (_backend !== undefined) return _backend
  const root = resolveBackendServicesRoot()
  if (!root) return null
  try {
    const req = createRequire(path.join(root, 'noop.js'))
    const aw = req(path.join(root, 'domain', 'config', 'ccSwitch', 'appWriters.js'))
    _backend = {
      applyCardToApp: aw.applyCardToApp,
      detectCardInApp: aw.detectCardInApp,
      preflightCardForApp: aw.preflightCardForApp
    }
  } catch {
    _backend = null
  }
  return _backend
}

/** 一次性审计 backend 解析结果（fail-soft，绝不阻塞启动）。 */
export async function _auditBackendResolution(): Promise<void> {
  if (_auditDone) return
  _auditDone = true
  const root = resolveBackendServicesRoot()
  if (root) await appendAudit({ op: 'backend-resolve-ok', target: root })
  else await appendAudit({ op: 'backend-resolve-failed', detail: 'use built-in writers' })
}

function _notResolvable(action: string): string {
  return `${action}失败：khy 后端服务未解析（动作: 设置 env KHY_BACKEND_SERVICES 指向 services/backend/src/services，或安装 khy-os 后重试）`
}

export interface ToolProviderView {
  app: string
  success: boolean
  providers: Array<Record<string, unknown>>
  error?: string
}

/** 扫描各工具 live 配置（一键导入的数据源；后端 detectCardInApp 反向探测）。 */
export async function detectToolProviders(apps?: string[]): Promise<{ ok: boolean; results: ToolProviderView[]; error?: string }> {
  const backend = loadBackend()
  if (!backend) return { ok: false, results: [], error: _notResolvable('工具探测') }
  const known = apps && apps.length ? apps : ['claude-code', 'opencode', 'zcode', 'codex', 'command-code', 'ycode']
  const results: ToolProviderView[] = []
  for (const app of known) {
    try {
      const r = backend.detectCardInApp(app)
      results.push({
        app,
        success: Boolean(r.success),
        providers: Array.isArray(r.providers) ? r.providers : [],
        error: r.error
      })
    } catch (e) {
      results.push({ app, success: false, providers: [], error: String((e as Error).message || e) })
    }
  }
  return { ok: true, results }
}

/** 从工具探测结果导入卡片（无凭据：keyId 留空，用户稍后在池里绑定）。 */
export async function importFromTool(
  app: string,
  view: Record<string, unknown>
): Promise<{ ok: boolean; cardId?: string; error?: string }> {
  const { addCard } = await import('./providers.ts')
  const name = String(view.name || view.id || app)
  const baseUrl = String(view.endpoint || '')
  if (!baseUrl) return { ok: false, error: '探测结果缺少端点，无法导入（动作: 检查该工具配置 目标: live config）' }
  // 协议推断：zcode kind 优先；claude-code 默认 anthropic 线
  const kind = String(view.kind || '')
  let protocol = 'openai'
  if (kind === 'anthropic') protocol = 'anthropic'
  else if (kind === 'openai') protocol = 'openai'
  else if (kind === 'openai-compatible') protocol = 'openai'
  else if (kind === 'openai_responses') protocol = 'openai_responses'
  if (!kind && app === 'claude-code') protocol = 'anthropic'
  const models = Array.isArray(view.models) ? view.models.map(String) : []
  const r = await addCard({
    name,
    baseUrl,
    protocol,
    keyId: '',
    models,
    defaultModel: String(view.defaultModel || models[0] || '')
  })
  if (!r.ok) return r
  await appendAudit({ op: 'import', target: `${app}:${name}`, detail: `card:${r.cardId}` })
  return { ok: true, cardId: r.cardId }
}

/** 把卡片应用到工具 live 配置（写必走正门：后端 appWriters 是唯一写入者）。 */
export async function applyCardToTool(
  app: string,
  card: Card,
  opts?: { key?: string }
): Promise<{ ok: boolean; error?: string; detail?: unknown }> {
  const backend = loadBackend()
  if (!backend) return { ok: false, error: _notResolvable('应用卡片到工具') }
  try {
    const result = await backend.applyCardToApp(card, app, { key: opts?.key })
    if (!result.success) {
      return { ok: false, error: result.error || '应用失败（详见后端 preflight 校验）' }
    }
    await appendAudit({ op: 'apply', target: app, detail: `card:${card.id}` })
    return { ok: true, detail: result.detail }
  } catch (e) {
    return { ok: false, error: `应用失败 (${String((e as Error).message || e).slice(0, 120)})：请检查该工具配置路径后重试` }
  }
}
