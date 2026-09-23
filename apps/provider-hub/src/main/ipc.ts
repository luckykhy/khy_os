// ipc — Provider Card Hub IPC handlers（DESIGN-ARCH-094 §5 M1）。
//
// 脱敏不变式（契约 C3）：明文 key 只在 keys:reveal 单一出口（冷却 30s + 审计）；
// 所有 cards:*/tools:*/models:* 返回体不含 key 字段。

import type { IpcMain } from 'electron'
import {
  listCards,
  addCard,
  updateCard,
  duplicateCard,
  removeCard,
  reorderCards,
  setActive,
  clearActive,
  setFailover,
  rotateFailover,
  listPoolMasked,
  addKey,
  keyIdFor,
  maskKey,
  keyFingerprint,
  appendAudit,
  getDataHome
} from './providers.ts'
import { fetchModelCatalog, mergeCatalog, resolveDefault, probeEndpoint } from './modelCatalog.ts'
import { usageSummary } from './usage.ts'
import { detectToolProviders, importFromTool, applyCardToTool, _auditBackendResolution } from './toolWriters.ts'
import { proxyStatus, startProxy } from './proxyStatus.ts'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Card } from './types.ts'

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data }
}

function err(error: string, extra?: Record<string, unknown>): { ok: false; error: string } & Record<string, unknown> {
  return { ok: false, error, ...extra }
}

const _revealWindow = new Map<string, number>()
const REVEAL_COOLDOWN_MS = 30_000

/** 明文 key 单一出口：冷却 30s + 审计（provider_hub_audit.jsonl），绝不进其它通道。 */
async function revealKey(provider: string, keyId: string): Promise<{ ok: boolean; key?: string; error?: string }> {
  const now = Date.now()
  const last = _revealWindow.get(keyId) || 0
  if (now - last < REVEAL_COOLDOWN_MS) {
    await appendAudit({ op: 'reveal-rejected', target: provider, detail: 'cooldown' })
    return { ok: false, error: `reveal 冷却中：请 ${Math.ceil((REVEAL_COOLDOWN_MS - (now - last)) / 1000)}s 后重试` }
  }
  _revealWindow.set(keyId, now)
  try {
    const raw = await fs.readFile(path.join(getDataHome(), 'api_keys.json'), 'utf-8')
    const doc: Record<string, Array<{ key: string }>> = JSON.parse(raw)
    for (const [p, entries] of Object.entries(doc)) {
      for (const e of entries || []) {
        if (keyIdFor(p, e.key) === keyId && p === provider) {
          await appendAudit({ op: 'reveal', target: provider, fingerprint: keyFingerprint(e.key) })
          return { ok: true, key: e.key }
        }
      }
    }
    return { ok: false, error: '密钥不存在（keyId 已变更或条目被移除）' }
  } catch {
    return { ok: false, error: '密钥池读取失败（动作: 检查 api_keys.json 可读性 目标: dataHome）' }
  }
}

export function registerHubIpc(ipc: IpcMain): void {
  _auditBackendResolution().catch(() => {})

  // ── cards（cc_switch.json 同库 CRUD，无凭据设计）─────────────────
  ipc.handle('cards:list', async () => {
    const r = await listCards()
    return ok({ cards: r.cards, active: r.active, agentMode: r.agentMode, recovered: r.recovered })
  })

  ipc.handle('cards:add', async (_e, input: Record<string, unknown>) => {
    const r = await addCard((input || {}) as never)
    return r.ok ? ok({ cardId: r.cardId }) : err(r.error || '卡片添加失败')
  })

  ipc.handle('cards:update', async (_e, cardId: string, patch: Record<string, unknown>) => {
    const r = await updateCard(cardId, (patch || {}) as never)
    return r.ok ? ok({}) : err(r.error || '卡片更新失败')
  })

  ipc.handle('cards:duplicate', async (_e, cardId: string) => {
    const r = await duplicateCard(cardId)
    return r.ok ? ok({ cardId: r.cardId }) : err(r.error || '卡片复制失败')
  })

  ipc.handle('cards:remove', async (_e, cardId: string) => {
    const r = await removeCard(cardId)
    return r.ok ? ok({}) : err(r.error || '卡片删除失败', { activeApps: r.activeApps })
  })

  ipc.handle('cards:reorder', async (_e, cardId: string, toIndex: number) => {
    const r = await reorderCards(cardId, toIndex)
    return r.ok ? ok({}) : err(r.error || '排序失败')
  })

  ipc.handle('cards:set-active', async (_e, app: string, cardId: string) => {
    const r = await setActive(app, cardId)
    return r.ok ? ok({}) : err(r.error || '激活失败')
  })

  ipc.handle('cards:clear-active', async (_e, app: string) => ok(await clearActive(app)))

  // ── failover（P3 备卡队列：健康探测失败后一键轮换）────────────────
  ipc.handle('cards:failover-set', async (_e, app: string, cardIds: string[]) => {
    const r = await setFailover(app, cardIds || [])
    return r.ok ? ok({}) : err(r.error || '备卡队列设置失败')
  })

  ipc.handle('cards:failover-rotate', async (_e, app: string) => {
    const r = await rotateFailover(app)
    return r.ok ? ok({ promoted: r.promoted, retired: r.retired }) : err(r.error || '轮换失败')
  })

  // ── keys（api_keys.json 池；明文单一出口 keys:reveal）──────────
  ipc.handle('keys:list', async () => ok(await listPoolMasked()))

  ipc.handle('keys:add', async (_e, input: { provider: string; label?: string; endpoint?: string; key: string; priority?: number }) => {
    const r = await addKey(input || ({} as never))
    return r.ok ? ok({ keyId: r.keyId, provider: r.provider }) : err(r.error || '密钥添加失败')
  })

  ipc.handle('keys:reveal', async (_e, provider: string, keyId: string) => {
    const r = await revealKey(provider, keyId)
    return r.ok ? ok({ key: r.key }) : err(r.error || 'reveal 失败')
  })

  // ── models（拉取 + 合并存卡）──────────────────────────────────────
  ipc.handle('models:fetch', async (_e, input: { cardId: string }) => {
    const { cards } = await listCards()
    const card = (cards as Card[]).find((c) => c.id === input?.cardId)
    if (!card) return err('卡片不存在：cardId 已失效（动作: 刷新卡片列表 目标: cards）')
    const key = await _resolveKey(card)
    const r = await fetchModelCatalog({ protocol: card.protocol, baseUrl: card.baseUrl, key })
    // 返回体绝不携带明文 key（契约 C3）；mask 供 UI 展示来源
    return ok({ ...r, keyMask: key ? maskKey(key) : '', keyFp: key ? keyFingerprint(key) : '' })
  })

  ipc.handle('models:apply', async (_e, input: { cardId: string; models: string[]; defaultModel?: string }) => {
    const { cards } = await listCards()
    const card = (cards as Card[]).find((c) => c.id === input?.cardId)
    if (!card) return err('卡片不存在')
    const models = mergeCatalog(card.models, input?.models || [])
    const defaultModel = resolveDefault(card.defaultModel, models)
    const r = await updateCard(card.id, { models, defaultModel })
    return r.ok ? ok({ models, defaultModel }) : err(r.error || '模型保存失败')
  })

  // ── tools（工具矩阵：探测/导入/应用，后端 SSoT 为唯一写入者）────
  ipc.handle('tools:matrix', async () => ok(await detectToolProviders()))

  ipc.handle('tools:detect', async (_e, apps?: string[]) => ok(await detectToolProviders(apps)))

  ipc.handle('tools:import', async (_e, input: { app: string; provider: Record<string, unknown> }) => {
    const r = await importFromTool(input?.app || '', input?.provider || {})
    return r.ok ? ok({ cardId: r.cardId }) : err(r.error || '导入失败')
  })

  ipc.handle('tools:apply', async (_e, input: { app: string; cardId: string }) => {
    const { cards } = await listCards()
    const card = (cards as Card[]).find((c) => c.id === input?.cardId)
    if (!card) return err('卡片不存在：cardId 已失效（动作: 刷新卡片列表 目标: cards）')
    const key = await _resolveKey(card)
    const r = await applyCardToTool(input?.app || '', card, { key })
    return r.ok ? ok({ detail: r.detail }) : err(r.error || '应用失败')
  })

  // ── proxy（khy 网关运行时发现）──────────────────────────────────
  ipc.handle('proxy:status', async () => ok(await proxyStatus()))
  ipc.handle('proxy:start', async () => {
    const r = await startProxy()
    return r.ok ? ok({ detail: r.detail }) : err(r.error || '网关启动失败')
  })

  // ── health（卡片端点探测，空闲超时，绝不硬挂）────────────────────
  ipc.handle('health:probe', async (_e, input: { cardId: string }) => {
    const { cards } = await listCards()
    const card = (cards as Card[]).find((c) => c.id === input?.cardId)
    if (!card) return err('卡片不存在')
    const key = await _resolveKey(card)
    const r = await probeEndpoint(card.baseUrl, card.protocol, key)
    // 探测失败且该卡是某工具 active → 提示可走 failover 轮换（不自动切，状态透明）
    if (!r.reachable) {
      r.hint = '端点不可达：若该卡是激活卡，可执行 failover 轮换到下一备卡'
    }
    return ok({ ...r, keyMask: key ? maskKey(key) : '' })
  })

  // ── usage（P3 用量图表：khy SSoT 用量账本按日聚合）──────────────
  ipc.handle('usage:summary', async (_e, days?: number) => ok(await usageSummary(days)))
}

/** keyId → 池内明文 key（仅 main 进程内流转；池条目按 provider 分组扫描）。 */
async function _resolveKey(card: Card): Promise<string> {
  if (!card.keyId) return ''
  try {
    const raw = await fs.readFile(path.join(getDataHome(), 'api_keys.json'), 'utf-8')
    const doc: Record<string, Array<{ key: string }>> = JSON.parse(raw)
    for (const [provider, entries] of Object.entries(doc)) {
      for (const e of entries || []) {
        if (keyIdFor(provider, e.key) === card.keyId) return e.key
      }
    }
  } catch {
    /* 池不可用 → 无 key（模型目录仍可匿名拉取） */
  }
  return ''
}
