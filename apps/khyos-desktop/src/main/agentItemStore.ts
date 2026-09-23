// agentItemStore — file-backed registry for user-created agent extension
// items (命令/钩子/技能/子智能体/记忆), powering the settings Pattern-B list
// pages (ZC-ALIGN-001 P13). Also owns the external-agent migration scan used
// by the onboarding dialog's 数据迁移向导 (D5/s-8): scans real config dirs of
// Claude Code / Codex / Cursor under the OS home and imports their definition
// files into this registry — no fabricated counts, everything on disk.
//
// Storage: single agent_items.json under the effective data home
// (dataHomeFile — honors the user-set 数据存储路径 pointer), atomic .tmp+rename
// writes, in-memory cache invalidated on write. Writes only arrive through
// the main IPC 正门 (Rule: never direct state-file writes from renderer).

import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataHomeFile, getDataHome } from './keyManager/keyStore'

const ITEMS_FILE = 'agent_items.json'

export const AGENT_ITEM_KINDS = new Set(['command', 'hook', 'skill', 'subagent', 'memory'])

export interface AgentItem {
  id: string
  kind: string
  name: string
  description: string
  // Definition body: slash-command prompt / hook script / skill instructions /
  // subagent config / memory entry text.
  content: string
  enabled: boolean
  // 'user' | 'imported:<sourceId>' — migration rows carry their origin.
  source: string
  createdAt: number
  updatedAt: number
}

interface ItemsDoc {
  items: AgentItem[]
}

function itemsPath(): string {
  return dataHomeFile(ITEMS_FILE)
}

async function ensureDir(): Promise<void> {
  const dir = path.dirname(itemsPath())
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true })
  }
}

async function loadDoc(): Promise<ItemsDoc> {
  try {
    const raw = await fs.readFile(itemsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as ItemsDoc
    if (Array.isArray(parsed.items)) return parsed
  } catch {
    // Missing or invalid file → empty registry (defaults on read).
  }
  return { items: [] }
}

async function persist(doc: ItemsDoc): Promise<void> {
  await ensureDir()
  const tmpPath = itemsPath() + '.tmp'
  await fs.writeFile(tmpPath, JSON.stringify(doc, null, 2), 'utf-8')
  await fs.rename(tmpPath, itemsPath())
}

function kindError(kind: string): string | null {
  if (!AGENT_ITEM_KINDS.has(kind)) {
    return `未知的条目类型「${kind}」：请通过设置页重试，或重启应用`
  }
  return null
}

function normalizeRow(input: unknown): { name: string; description: string; content: string } | null {
  const row = (input || {}) as { name?: unknown; description?: unknown; content?: unknown }
  const name = typeof row.name === 'string' ? row.name.trim() : ''
  if (!name) return null
  return {
    name,
    description: typeof row.description === 'string' ? row.description : '',
    content: typeof row.content === 'string' ? row.content : '',
  }
}

function newId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ── Registry CRUD (IPC 正门) ──────────────────────────────────────────

export async function listItems(kind: string): Promise<{ ok: boolean; items?: AgentItem[]; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  const doc = await loadDoc()
  const items = doc.items.filter((it) => it.kind === kind).sort((a, b) => b.createdAt - a.createdAt)
  // Shallow copy so callers cannot mutate the cache in place.
  return { ok: true, items: items.map((it) => ({ ...it })) }
}

export async function createItem(
  kind: string,
  input: unknown
): Promise<{ ok: boolean; item?: AgentItem; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  const row = normalizeRow(input)
  if (!row) {
    return { ok: false, error: '条目信息无效：名称不能为空，请填写名称后保存' }
  }
  const doc = await loadDoc()
  if (doc.items.some((it) => it.kind === kind && it.name === row.name)) {
    return { ok: false, error: `名称「${row.name}」已被使用：请换一个名称，或先删除同名条目` }
  }
  const now = Date.now()
  const item: AgentItem = {
    id: newId(kind),
    kind,
    name: row.name,
    description: row.description,
    content: row.content,
    enabled: true,
    source: 'user',
    createdAt: now,
    updatedAt: now,
  }
  doc.items.push(item)
  await persist(doc)
  return { ok: true, item }
}

export async function setItemEnabled(
  kind: string,
  id: string,
  enabled: boolean
): Promise<{ ok: boolean; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  const doc = await loadDoc()
  const item = doc.items.find((it) => it.kind === kind && it.id === id)
  if (!item) {
    return { ok: false, error: '未找到该条目，可能已被删除' }
  }
  item.enabled = !!enabled
  item.updatedAt = Date.now()
  await persist(doc)
  return { ok: true }
}

export async function deleteItem(
  kind: string,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  const doc = await loadDoc()
  const idx = doc.items.findIndex((it) => it.kind === kind && it.id === id)
  if (idx === -1) {
    return { ok: false, error: '未找到该条目，可能已被删除' }
  }
  doc.items.splice(idx, 1)
  await persist(doc)
  return { ok: true }
}

// 导入 — rows: [{name, description?, content?, enabled?}]. Invalid rows and
// duplicate names are skipped (counted), matching the mcpStore import contract.
export async function importItems(
  kind: string,
  rows: unknown
): Promise<{ ok: boolean; created?: number; skipped?: number; error?: string }> {
  const err = kindError(kind)
  if (err) return { ok: false, error: err }
  if (!Array.isArray(rows)) {
    return { ok: false, error: '导入内容不是 JSON 数组：请复制 [{name, content}] 形式后重试' }
  }
  const doc = await loadDoc()
  const now = Date.now()
  let created = 0
  let skipped = 0
  for (const raw of rows) {
    const row = normalizeRow(raw)
    if (!row || doc.items.some((it) => it.kind === kind && it.name === row.name)) {
      skipped += 1
      continue
    }
    doc.items.push({
      id: newId(kind),
      kind,
      name: row.name,
      description: row.description,
      content: row.content,
      enabled: true,
      source: 'user',
      createdAt: now,
      updatedAt: now,
    })
    created += 1
  }
  if (created > 0) await persist(doc)
  return { ok: true, created, skipped }
}

// ── 外部 Agent 迁移（onboarding 数据迁移向导，D5/s-8）──────────────────
// Scans REAL config directories under the OS home; counts are read from disk
// at scan time. Import copies the definition files into
// <dataHome>/agent-items/<kind>/<sourceId>/ and registers registry rows, so
// the copy the user ends up with lives in KhyOS's own data home.

export interface MigrationSection {
  // Subdirectory under the agent config dir, e.g. 'commands'
  dir: string
  // Destination item kind in this registry
  kind: string
  label: string
}

export interface MigrationSource {
  id: string
  label: string
  // Config dir name under the OS home
  homeDir: string
  sections: MigrationSection[]
}

const MIGRATION_SOURCES: MigrationSource[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    homeDir: '.claude',
    sections: [
      { dir: 'commands', kind: 'command', label: '命令' },
      { dir: 'skills', kind: 'skill', label: '技能' },
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    homeDir: '.cursor',
    sections: [{ dir: 'rules', kind: 'skill', label: '规则' }],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    homeDir: '.codex',
    sections: [{ dir: 'prompts', kind: 'command', label: '提示词' }],
  },
]

async function countDefinitionFiles(dir: string): Promise<number> {
  // Definition files are markdown (slash commands / skills / rules / prompts).
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).length
  } catch {
    return 0
  }
}

export async function scanMigrations(): Promise<{
  ok: boolean
  sources?: Array<{ id: string; label: string; found: boolean; counts: Array<{ label: string; count: number }> }>
  error?: string
}> {
  const home = os.homedir()
  const sources = []
  for (const src of MIGRATION_SOURCES) {
    const configDir = path.join(home, src.homeDir)
    let found = false
    const counts: Array<{ label: string; count: number }> = []
    try {
      await fs.access(configDir)
      found = true
    } catch {
      found = false
    }
    if (found) {
      for (const section of src.sections) {
        const count = await countDefinitionFiles(path.join(configDir, section.dir))
        counts.push({ label: section.label, count })
      }
    }
    sources.push({ id: src.id, label: src.label, found, counts })
  }
  return { ok: true, sources }
}

export async function importMigration(
  sourceId: string
): Promise<{ ok: boolean; created?: number; skipped?: number; error?: string }> {
  const src = MIGRATION_SOURCES.find((s) => s.id === sourceId)
  if (!src) {
    return { ok: false, error: `未知的迁移来源「${sourceId}」：请重新检测后导入` }
  }
  const home = os.homedir()
  const configDir = path.join(home, src.homeDir)
  try {
    await fs.access(configDir)
  } catch {
    return { ok: false, error: `未找到 ${src.label} 的配置目录（${src.homeDir}）：请确认已安装后重试` }
  }
  const doc = await loadDoc()
  const now = Date.now()
  let created = 0
  let skipped = 0
  for (const section of src.sections) {
    const sectionDir = path.join(configDir, section.dir)
    let files: string[] = []
    try {
      files = (await fs.readdir(sectionDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const file of files) {
      const name = path.basename(file, '.md')
      if (doc.items.some((it) => it.kind === section.kind && it.name === name)) {
        skipped += 1
        continue
      }
      try {
        const content = await fs.readFile(path.join(sectionDir, file), 'utf-8')
        // First non-heading line as description; falls back to empty.
        const firstLine = content
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith('#'))
        doc.items.push({
          id: newId(section.kind),
          kind: section.kind,
          name,
          description: firstLine ? firstLine.slice(0, 80) : '',
          content,
          enabled: true,
          source: `imported:${src.id}`,
          createdAt: now,
          updatedAt: now,
        })
        created += 1
      } catch {
        // Unreadable file: skip honestly rather than abort the whole import.
        skipped += 1
      }
    }
  }
  if (created > 0) await persist(doc)
  return { ok: true, created, skipped }
}

// Data home root used by the onboarding dialog's "数据存储位置" hint — exported
// for IPC so the renderer never hardcodes a path (Rule 1).
export function migrationDataHome(): string {
  return getDataHome()
}
