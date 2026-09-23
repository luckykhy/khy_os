import { useState, useEffect, useCallback } from 'react'
import { GeneralSettings } from './GeneralSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { McpSettings } from './McpSettings'
import { BrowserSettings, CuaSettings } from './BrowserCuaSettings'
import { UsageSettings } from './UsageSettings'
import { OnboardingSettings } from './OnboardingSettings'
import { OnboardingDialog } from './OnboardingDialog'
import { ListSettingsPage } from './ListSettingsPage'
import { IndexSettingsPage } from './IndexSettingsPage'
import { PluginSettings } from './PluginSettings'
import { KeyManagerPage } from '../keyManager/KeyManagerPage'

// ── Nav structure (mirrors ZCode v3.11.2 a11y s-30/s-42, ZC-ALIGN-003 §1-4) ──
// Full-screen replacement layout: left nav (~240px) + right content scroll area.
// Three groups + standalone 引导 + 返回工作区 at top + account row at bottom.

interface NavItem {
  id: string
  label: string
}
interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'basic',
    label: '基础设置',
    items: [
      { id: 'general', label: '常规' },
      { id: 'appearance', label: '外观' },
      { id: 'models', label: '模型设置' },
      { id: 'browser', label: '浏览器控制' },
      { id: 'cua', label: '电脑控制' },
    ],
  },
  {
    id: 'agent',
    label: 'Agent 能力',
    items: [
      { id: 'memory', label: '记忆' },
      { id: 'subagents', label: '子智能体' },
      { id: 'plugins', label: '插件' },
      { id: 'mcp', label: 'MCP 服务器' },
      { id: 'skills', label: '技能' },
      { id: 'commands', label: '命令' },
      { id: 'hooks', label: '钩子' },
    ],
  },
  {
    id: 'data',
    label: '数据与统计',
    items: [
      { id: 'index', label: '索引库' },
      { id: 'usage', label: '使用统计' },
    ],
  },
]

// Page metadata: title + subtitle for the right pane header (from a11y s-30)
const PAGE_META: Record<string, { title: string; subtitle?: string }> = {
  general: { title: '常规' },
  appearance: { title: '外观' },
  models: { title: '模型设置', subtitle: '管理自定义模型供应商，配置后可在聊天时选择使用。' },
  browser: { title: '浏览器控制', subtitle: '配置内置浏览器的行为与安全策略。' },
  cua: { title: '电脑控制', subtitle: '配置 Agent 操作电脑的权限与安全边界。' },
  memory: { title: '记忆', subtitle: '管理 Agent 记忆库，存储跨会话的上下文信息。' },
  subagents: { title: '子智能体', subtitle: '管理可委派的子智能体。' },
  plugins: { title: '插件', subtitle: '启用或停用已安装的插件。插件可打包技能、命令、Hooks 和 MCP 服务器。' },
  mcp: { title: 'MCP 服务器', subtitle: '管理 MCP 服务器，配置后可在对话中使用其工具。' },
  skills: { title: '技能', subtitle: '管理 Agent 技能，扩展其能力范围。' },
  commands: { title: '命令', subtitle: '管理自定义命令，配置后可用 / 触发。' },
  hooks: { title: '钩子', subtitle: '配置 Agent 生命周期事件的处理逻辑。' },
  index: { title: '索引库', subtitle: '管理代码索引库，用于增强 Agent 的代码理解能力。' },
  usage: { title: '使用统计', subtitle: '查看模型用量与 Token 消耗趋势。' },
  onboarding: { title: '引导' },
}

export function SettingsPage() {
  // Deep-link support: #/settings/plugins → start on the 插件 page.
  const [activePage, setActivePage] = useState(() => {
    const suffix = window.location.hash.replace(/^#\/settings\/?/, '')
    return PAGE_META[suffix] ? suffix : 'general'
  })
  // Local-mode account name — same neutral value as the sidebar footer. The old
  // value was the ZCode account observed in the audit screenshots (another
  // product's user data, not ours).
  const [accountName] = useState('本地用户')
  const [settings, setSettings] = useState<Record<string, unknown>>({})

  // Load persisted settings on mount (preload IPC: settings:get)
  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: { getSettings?: () => Promise<Record<string, unknown>> }
    }).__KHYOS__
    api?.getSettings?.().then((s) => setSettings(s || {})).catch(() => {})
  }, [])

  // Persist a single setting key (preload IPC: settings:set)
  const updateSetting = useCallback((key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
    const api = (window as unknown as {
      __KHYOS__?: { setSetting?: (k: string, v: unknown) => Promise<void> }
    }).__KHYOS__
    api?.setSetting?.(key, value).catch(() => {})
  }, [])

  const handleBack = () => {
    window.location.hash = ''
  }

  const meta = PAGE_META[activePage] || { title: activePage }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* OnboardingDialog: mounted once, opens on khy:open-onboarding (D5/s-8).
          打开引导 rows on 常规/引导 pages dispatch that event. */}
      <OnboardingDialog />
      {/* Top bar: ZCode logo + window menu + caption (caption buttons are in TitleBar overlay) */}
      <div className="flex items-center justify-between h-[60px] px-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">KhyOS</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleBack}
            className="px-3 py-1.5 text-sm text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
          >
            返回工作区
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left navigation ── */}
        <nav className="w-[240px] flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
          {/* Top: 返回工作区 */}
          <div className="p-3 border-b border-border">
            <button
              onClick={handleBack}
              className="w-full px-3 py-2 text-sm text-left text-foreground/70 hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors flex items-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              返回工作区
            </button>
          </div>

          {/* Nav groups (scrollable) */}
          <div className="flex-1 overflow-y-auto py-2">
            {NAV_GROUPS.map((group) => (
              <div key={group.id} className="mb-3">
                <div className="px-4 py-1.5 text-xs font-semibold text-foreground/40 uppercase tracking-wider">
                  {group.label}
                </div>
                {group.items.map((item) => (
                  <NavButton
                    key={item.id}
                    label={item.label}
                    active={activePage === item.id}
                    onClick={() => setActivePage(item.id)}
                  />
                ))}
              </div>
            ))}

            {/* Standalone: 引导 (no group header — ZCode a11y s-25 has none) */}
            <NavButton
              label="引导"
              active={activePage === 'onboarding'}
              onClick={() => setActivePage('onboarding')}
            />
          </div>

          {/* Bottom: account chip + 返回工作区 */}
          <div className="border-t border-border p-3 flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-brand/20 flex items-center justify-center text-xs font-semibold text-brand flex-shrink-0">
              {accountName.slice(0, 1).toUpperCase()}
            </div>
            <span className="text-sm font-medium text-foreground truncate flex-1">{accountName}</span>
            <button
              onClick={handleBack}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-foreground/60 hover:text-foreground hover:bg-surface-hover transition-colors flex-shrink-0"
              title="返回工作区"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M8.5 3L4.5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </nav>

        {/* ── Right content area ── */}
        <main className="flex-1 overflow-y-auto">
          {/* Page header — centered column so content doesn't hug the left nav */}
          <div className="px-8 pt-8 pb-2 max-w-3xl mx-auto w-full">
            <h1 className="text-xl font-semibold text-foreground">{meta.title}</h1>
            {meta.subtitle && (
              <p className="text-sm text-foreground/50 mt-1">{meta.subtitle}</p>
            )}
          </div>

          {/* Page content */}
          <div className="px-8 pb-16 max-w-3xl mx-auto w-full">
            {activePage === 'general' && (
              <GeneralSettings settings={settings} onChange={updateSetting} />
            )}
            {activePage === 'appearance' && (
              <AppearanceSettings settings={settings} onChange={updateSetting} />
            )}
            {activePage === 'models' && (
              <div className="border border-card-border rounded-xl overflow-hidden">
                <KeyManagerPage embedded />
              </div>
            )}
            {activePage === 'browser' && (
              <BrowserSettings settings={settings} onChange={updateSetting} />
            )}
            {activePage === 'cua' && (
              <CuaSettings settings={settings} onChange={updateSetting} />
            )}
            {activePage === 'mcp' && <McpSettings />}
            {activePage === 'usage' && <UsageSettings />}
            {activePage === 'onboarding' && (
              <OnboardingSettings settings={settings} onChange={updateSetting} />
            )}
            {/* Pattern B: list pages backed by agentItemStore (P13 real wiring) */}
            {activePage === 'commands' && (
              <ListSettingsPage
                kind="command"
                noun="命令"
                description="新建命令，或从外部 Agent 导入已有命令。"
                contentLabel="命令内容"
                contentPlaceholder="/ 前缀触发的提示词，支持 $ARGUMENTS 占位符"
              />
            )}
            {activePage === 'hooks' && (
              <ListSettingsPage
                kind="hook"
                noun="钩子"
                description="新建钩子，配置 Agent 生命周期事件的处理逻辑。"
                contentLabel="钩子脚本"
                contentPlaceholder="事件名 + 处理命令，例如 PreToolUse: node check.js"
              />
            )}
            {activePage === 'skills' && (
              <ListSettingsPage
                kind="skill"
                noun="技能"
                description="从技能市场浏览并安装技能。"
                contentLabel="技能说明"
                contentPlaceholder="技能的指令内容（SKILL.md 正文）"
              />
            )}
            {activePage === 'subagents' && (
              <ListSettingsPage
                kind="subagent"
                noun="子智能体"
                description="新建子智能体，或从外部 Agent 导入已有配置。"
                contentLabel="配置"
                contentPlaceholder="子智能体的职责描述与提示词"
              />
            )}
            {activePage === 'plugins' && <PluginSettings />}
            {activePage === 'memory' && (
              <ListSettingsPage
                kind="memory"
                noun="记忆"
                description="管理 Agent 记忆库，存储跨会话的上下文信息。"
                contentLabel="记忆内容"
                contentPlaceholder="希望 Agent 跨会话记住的信息"
              />
            )}
            {activePage === 'index' && <IndexSettingsPage />}
          </div>
        </main>
      </div>
    </div>
  )
}

// ── Nav button (matches ZCode left nav item style) ──
function NavButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full px-4 py-2 text-sm text-left transition-colors rounded-lg mx-1 ${
        active
          ? 'bg-selected text-foreground font-medium'
          : 'text-foreground/70 hover:text-foreground hover:bg-surface-hover'
      }`}
      style={{ width: 'calc(100% - 8px)' }}
    >
      {label}
    </button>
  )
}

