// pluginStore — file-backed plugin registry for the main process, powering
// the settings 插件 page (ZC-ALIGN-003 §2). Mirrors automationStore: JSON file
// under the BASE data home, atomic .tmp+rename writes, defaults on read,
// in-memory cache invalidated on write.
//
// Model follows ZCode's plugin shape (settings.plugins.* i18n evidence):
//   { id, name, version, description, source: 'builtin' | marketplace name,
//     enabled, installedAt, installPath, updateAvailable,
//     components: { skills, commands, hooks, mcp, agents, lsp } }
//
// Builtin plugins are seeded on first load (marketplace-installed entries come
// from plugins.json itself). 卸载 removes the registry entry; toggling only
// flips enabled — both through the main IPC 正门 (Rule: writes never go direct
// to the state file).

import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { baseHomeFile } from './keyManager/keyStore'

const PLUGINS_FILE = 'plugins.json'

export interface PluginComponents {
  skills: number
  commands: number
  hooks: number
  mcp: number
  agents: number
  lsp: number
}

export interface Plugin {
  id: string
  name: string
  version: string
  description: string
  // 'builtin' → settings.plugins.source.builtin; otherwise the marketplace
  // name, rendered as 从 {marketplace} 安装 (settings.plugins.source.fromMarketplace)
  source: string
  enabled: boolean
  installedAt: number
  installPath: string
  updateAvailable?: boolean
  components: PluginComponents
}

function pluginsPath(): string {
  return baseHomeFile(PLUGINS_FILE)
}

async function ensureDir(): Promise<void> {
  const dir = path.dirname(pluginsPath())
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true })
  }
}

// ── Builtin plugin seeds (ZCode ships these; the registry persists them so
// the 已安装 tab lists real entries even before any marketplace install). ──

// Install paths are derived from the resolved data home — never a machine-
// local absolute literal (Rule 1). They point at <dataHome>/plugins/<id>.
function builtinInstallPath(id: string): string {
  return path.join(path.dirname(pluginsPath()), 'plugins', id)
}

function builtinSeeds(): Plugin[] {
  const now = Date.now()
  const mk = (
    id: string,
    name: string,
    version: string,
    description: string,
    components: Partial<PluginComponents>
  ): Plugin => ({
    id,
    name,
    version,
    description,
    source: 'builtin',
    enabled: true,
    installedAt: now,
    installPath: builtinInstallPath(id),
    components: {
      skills: components.skills ?? 0,
      commands: components.commands ?? 0,
      hooks: components.hooks ?? 0,
      mcp: components.mcp ?? 0,
      agents: components.agents ?? 0,
      lsp: components.lsp ?? 0,
    },
  })
  return [
    mk('zcode-anthropic', 'zcode-anthropic', '1.0.4', 'ZCode 官方插件，提供基础能力与默认配置。', {
      commands: 14,
      agents: 1,
    }),
    mk('khyos-quant', 'khyos-quant', '1.2.0', 'KhyOS 内置的 khyquant 量化终端能力包：行情命令、回测工具与 MCP 服务器。', {
      skills: 3,
      commands: 8,
      hooks: 1,
      mcp: 1,
    }),
    mk('khyos-docs', 'khyos-docs', '0.9.1', '仓库文档导航技能：按 docs/ 两轴规范检索设计文档。', {
      skills: 1,
      commands: 2,
    }),
  ]
}

let cache: Plugin[] | null = null

async function load(): Promise<Plugin[]> {
  if (cache) return cache
  let stored: Plugin[] = []
  try {
    const raw = await fs.readFile(pluginsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as { plugins?: Plugin[] }
    if (Array.isArray(parsed.plugins)) stored = parsed.plugins
  } catch {
    stored = []
  }
  // Seed builtins: any builtin id missing from the stored file is (re)added —
  // uninstall of a builtin is recorded by a tombstone so it stays removed.
  const seen = new Set(stored.filter((p) => p.source === 'builtin').map((p) => p.id))
  const tombstones = new Set(
    stored.filter((p) => p.source === '__uninstalled__' && (p as unknown as { builtinId?: string }).builtinId)
      .map((p) => (p as unknown as { builtinId?: string }).builtinId as string)
  )
  const result = [...stored.filter((p) => p.source !== '__uninstalled__')]
  for (const seed of builtinSeeds()) {
    if (!seen.has(seed.id) && !tombstones.has(seed.id)) result.push(seed)
  }
  cache = result
  return cache
}

async function persist(list: Plugin[]): Promise<void> {
  await ensureDir()
  const tmpPath = pluginsPath() + '.tmp'
  await fs.writeFile(tmpPath, JSON.stringify({ plugins: list }, null, 2), 'utf-8')
  await fs.rename(tmpPath, pluginsPath())
  cache = list
}

function normalizeComponents(input: unknown): PluginComponents {
  const c = (input || {}) as Record<string, unknown>
  const num = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
  }
  return {
    skills: num(c.skills),
    commands: num(c.commands),
    hooks: num(c.hooks),
    mcp: num(c.mcp),
    agents: num(c.agents),
    lsp: num(c.lsp),
  }
}

// Marketplace install path (发现 tab → 安装): registers a plugin entry under
// <dataHome>/plugins/<id> with the marketplace name as its source.
export async function installPlugin(input: {
  id?: string
  name?: string
  version?: string
  description?: string
  marketplace?: string
  components?: unknown
}): Promise<{ ok: boolean; plugin?: Plugin; error?: string }> {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!id || !name) {
    return { ok: false, error: '插件信息无效：缺少插件 ID 或名称，请重新选择后安装' }
  }
  const marketplace = typeof input.marketplace === 'string' && input.marketplace.trim() ? input.marketplace.trim() : '官方市场'
  const list = await load()
  if (list.some((p) => p.id === id)) {
    return { ok: false, error: '插件已存在：请先卸载同名插件，或直接使用已安装版本' }
  }
  const plugin: Plugin = {
    id,
    name,
    version: typeof input.version === 'string' && input.version.trim() ? input.version.trim() : '0.1.0',
    description: typeof input.description === 'string' ? input.description : '',
    source: marketplace,
    enabled: true,
    installedAt: Date.now(),
    installPath: builtinInstallPath(id),
    components: normalizeComponents(input.components),
  }
  list.push(plugin)
  await persist(list)
  return { ok: true, plugin }
}

export async function getPlugins(): Promise<Plugin[]> {
  // Shallow copy so callers cannot mutate the cache in place.
  return [...(await load())]
}

// 启用/停用 toggle — the only state the settings page flips per row.
export async function setPluginEnabled(
  id: string,
  enabled: boolean
): Promise<{ ok: boolean; plugin?: Plugin; error?: string }> {
  const list = await load()
  const p = list.find((x) => x.id === id)
  if (!p) {
    return { ok: false, error: '未找到该插件，可能已被卸载' }
  }
  p.enabled = !!enabled
  await persist(list)
  return { ok: true, plugin: p }
}

// 卸载 — ZCode settings.plugins.uninstall.confirmDescription: removes the
// plugin's cached files, data directory and saved configuration. The registry
// entry itself is removed; builtins leave a tombstone so the seed logic does
// not resurrect them on next load.
export async function uninstallPlugin(id: string): Promise<{ ok: boolean; error?: string }> {
  const list = await load()
  const idx = list.findIndex((x) => x.id === id)
  if (idx === -1) {
    return { ok: false, error: '未找到该插件，可能已被卸载' }
  }
  const target = list[idx]
  list.splice(idx, 1)
  if (target.source === 'builtin') {
    list.push({ ...target, source: '__uninstalled__', enabled: false } as Plugin)
  }
  // Best-effort data-directory removal; a missing dir is success, not an error.
  try {
    await fs.rm(target.installPath, { recursive: true, force: true })
  } catch {
    // Registry removal already succeeded — filesystem cleanup failure must not
    // resurrect the entry. ZCode keeps the same contract (uninstall always
    // unregisters even if cache cleanup lags).
  }
  await persist(list)
  return { ok: true }
}

// 检查更新 — flips updateAvailable on plugins whose latest version differs.
// Without a live marketplace protocol the probe compares against the same
// version (so: none available) unless an env override supplies newer versions
// for testing; the IPC surface matches ZCode's checkForUpdates button anyway.
export async function checkPluginUpdates(): Promise<{ ok: boolean; count: number; error?: string }> {
  const list = await load()
  let count = 0
  const newer: Record<string, string> = (() => {
    try {
      return JSON.parse(process.env.KHY_PLUGIN_UPDATES || '{}') as Record<string, string>
    } catch {
      return {}
    }
  })()
  for (const p of list) {
    const latest = newer[p.id]
    if (latest && latest !== p.version) {
      p.updateAvailable = true
      count += 1
    } else {
      p.updateAvailable = false
    }
  }
  await persist(list)
  return { ok: true, count }
}
