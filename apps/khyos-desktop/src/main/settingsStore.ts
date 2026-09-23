// settingsStore — file-backed settings persistence for the main process.
//
// Stores all app settings (locale, theme, data path, toggles, proxy, terminal,
// etc.) in a single settings.json under the BASE dataHome (env/portable/repo/
// homedir chain from keyStore — never the dataPath-diverted effective home:
// settings.json holds the dataPath pointer itself, so it must stay findable at
// boot before the effective home is known). Atomic write + defaults merge; read
// is cached in-memory after first load and invalidated on write.
//
// This replaces the stub handlers in index.ts (ZC-ALIGN-003: "backend wired").

import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { baseHomeFile, SETTINGS_FILE } from './keyManager/keyStore'

function settingsPath(): string {
  // Base home, NOT the dataPath-diverted effective home (see file header):
  // settings.json holds the dataPath pointer itself, so it must stay findable
  // at boot before the effective home is known.
  return baseHomeFile(SETTINGS_FILE)
}

async function ensureDir(): Promise<void> {
  const dir = path.dirname(settingsPath())
  if (!existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true })
  }
}

// Default settings — mirrors the stub return + ZCode v3.11.2 a11y defaults
const DEFAULTS: Record<string, unknown> = {
  locale: 'system',
  theme: 'dark',
  dataPath: '',
  archiveRetention: '7d',
  autoArchive: true,
  groupFileChanges: true,
  groupTerminalCommands: true,
  groupExploreTools: true,
  showTodo: false,
  showReasoning: true,
  keepFullModelIO: false,
  autoContinueQuestions: true,
  interactionBehavior: 'queue',
  preventIdleSleep: false,
  hideToTray: false,
  notificationSound: true,
  taskNotifications: true,
  autoUpdate: false,
  prereleaseUpdates: false,
  hardwareAcceleration: true,
  customCert: '',
  noProxy: '',
  httpProxy: '',
  enhancedFindGrep: false,
  terminalShell: 'auto',
  terminalFont: '',
  inheritTerminalProfile: true,
  optInExperience: false,
  // Appearance: message body font size consumed via --khy-message-font-size
  // CSS var on <html> (MarkdownRenderer); CUA dispatch interval in ms.
  messageFontSize: '14',
  cuaActionInterval: '500',
  // Model selection (P3-7②): option id (`<provider>` or `<provider>/<model>`)
  // persisted by the renderer via setSetting; empty string = no selection yet.
  selectedModel: '',
  // Workspace root chosen via 窗口菜单 → 打开工作区 / 侧栏 添加项目. Empty
  // string = no explicit choice yet, main falls back to process.cwd()
  // (getWorkspaceRoot in index.ts). Single source for the workspace chip, the
  // file tree and workspace:listFiles — one value, no divergent copies.
  desktopWorkspacePath: '',
  // 最近打开的工作空间（[DESIGN-ARCH-125] P-02）：MRU 候选集，上限 8。
  // 它**不是**第二个真源 —— 「当前是哪个工作空间」仍只由 desktopWorkspacePath
  // 回答，本字段只回答「可以切到哪几个」，供卡片/标题栏的选择器列出最近目录，
  // 免去每次切换都弹系统目录框。读取侧（workspace:list）会过滤掉已不存在的
  // 路径：列出来的项必须真的能切过去，不做死链陈列。
  desktopRecentWorkspaces: [],
  // Agent 模式（Composer 工具行「切换模式」选择器，i18n mode.label.glm.*）：
  // 'confirm' | 'autoEdit' | 'plan' | 'fullAccess'
  // P3-9①：默认对齐 ZCode 实测「完全访问」（mode.label.glm.yolo）；
  // 用户显式切换后经 setSetting 落盘覆盖此默认值。
  desktopAgentMode: 'fullAccess',
  // Editor binary for 在编辑器中打开 (e.g. "code"). Empty = fall back to
  // KHY_EDITOR env; both empty → the action reports how to configure it.
  desktopEditor: '',
  // Window geometry
  desktopWindowSize: { width: 1216, height: 808, maximized: false },
}

let cache: Record<string, unknown> | null = null

export async function getSettingsStore(): Promise<Record<string, unknown>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    // Merge: defaults ← stored (stored wins)
    cache = { ...DEFAULTS, ...parsed }
  } catch {
    // File missing or invalid → use defaults
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const current = await getSettingsStore()
  current[key] = value
  cache = current
  await ensureDir()
  // Atomic write: write to .tmp then rename
  const tmpPath = settingsPath() + '.tmp'
  await fs.writeFile(tmpPath, JSON.stringify(current, null, 2), 'utf-8')
  await fs.rename(tmpPath, settingsPath())
}

export async function getTheme(): Promise<string> {
  const settings = await getSettingsStore()
  return (settings.theme as string) || 'dark'
}

export async function setTheme(mode: string): Promise<void> {
  await setSetting('theme', mode)
}
