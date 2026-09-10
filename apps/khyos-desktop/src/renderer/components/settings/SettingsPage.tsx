import { useState } from 'react'
import { KeyManagerPage } from '../keyManager/KeyManagerPage'

interface SettingGroup {
  id: string
  label: string
  icon: string
}

const SETTING_GROUPS: SettingGroup[] = [
  { id: 'general', label: '通用', icon: '⚙️' },
  { id: 'models', label: '模型配置', icon: '🧠' },
  { id: 'providers', label: 'Provider 管理', icon: '🔌' },
  { id: 'permissions', label: '权限控制', icon: '🔒' },
  { id: 'plugins', label: '插件管理', icon: '🧩' },
  { id: 'skills', label: '技能', icon: '⚡' },
  { id: 'subagents', label: '子智能体', icon: '🤖' },
  { id: 'mcp', label: 'MCP', icon: '🔗' },
  { id: 'browser', label: '浏览器控制', icon: '🌐' },
  { id: 'automations', label: '自动化', icon: '⏰' },
  { id: 'usage', label: '用量统计', icon: '📊' },
  { id: 'feedback', label: '用户反馈与支持', icon: '💬' },
]

function Toggle({ enabled, onChange, label, description }: { enabled: boolean; onChange: (v: boolean) => void; label: string; description?: string }) {
  return (
    <div className="flex items-center justify-between py-4">
      <div className="flex-1 mr-4">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="text-xs text-foreground/50 mt-1">{description}</div>}
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${
          enabled ? 'bg-brand' : 'bg-foreground/20'
        }`}
      >
        <span
          className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  )
}

function Select({ value, onChange, label, description, options }: { value: string; onChange: (v: string) => void; label: string; description?: string; options: { value: string; label: string }[] }) {
  return (
    <div className="flex items-center justify-between py-4">
      <div className="flex-1 mr-4">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && <div className="text-xs text-foreground/50 mt-1">{description}</div>}
      </div>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-input-border-focused min-w-[120px]"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h3 className="text-sm font-semibold text-foreground/70 uppercase tracking-wider mb-3 px-1">{title}</h3>
      <div className="bg-card border border-card-border rounded-xl px-5 divide-y divide-card-border">
        {children}
      </div>
    </div>
  )
}

function PermissionRow({ toolName, riskLevel, description, override, onOverride }: {
  toolName: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  description: string
  override?: 'allow' | 'ask' | 'deny'
  onOverride: (decision: 'allow' | 'ask' | 'deny') => void
}) {
  const riskColors = {
    low: 'text-success',
    medium: 'text-warning',
    high: 'text-destructive',
    critical: 'text-destructive',
  }

  return (
    <div className="flex items-center justify-between py-4">
      <div className="flex-1 mr-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{toolName}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded ${riskColors[riskLevel]} bg-current/10`}>
            {riskLevel}
          </span>
        </div>
        {description && <div className="text-xs text-foreground/50 mt-1">{description}</div>}
      </div>
      <div className="flex items-center gap-1">
        {(['allow', 'ask', 'deny'] as const).map(decision => (
          <button
            key={decision}
            onClick={() => onOverride(decision)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              override === decision
                ? decision === 'allow' ? 'bg-success/20 text-success'
                  : decision === 'deny' ? 'bg-destructive/20 text-destructive'
                  : 'bg-brand/20 text-brand'
                : 'text-foreground/50 hover:text-foreground hover:bg-surface-hover'
            }`}
          >
            {decision === 'allow' ? '允许' : decision === 'ask' ? '询问' : '拒绝'}
          </button>
        ))}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const [activeGroup, setActiveGroup] = useState('general')
  const [theme, setTheme] = useState('dark')
  const [reasoning, setReasoning] = useState(true)
  const [streaming, setStreaming] = useState(true)
  const [autoCompact, setAutoCompact] = useState(true)
  const [thoughtLevel, setThoughtLevel] = useState('max')
  const [contextWindow, setContextWindow] = useState('128000')
  const [autoAccept, setAutoAccept] = useState(false)
  const [confirmHighRisk, setConfirmHighRisk] = useState(true)
  const [toolOverrides, setToolOverrides] = useState<Record<string, 'allow' | 'ask' | 'deny'>>({})

  const tools = [
    { name: 'read', riskLevel: 'low' as const, description: '读取文件内容' },
    { name: 'write', riskLevel: 'high' as const, description: '写入或创建文件' },
    { name: 'edit', riskLevel: 'medium' as const, description: '编辑现有文件' },
    { name: 'bash', riskLevel: 'critical' as const, description: '执行终端命令' },
    { name: 'grep', riskLevel: 'low' as const, description: '搜索文件内容' },
    { name: 'glob', riskLevel: 'low' as const, description: '查找文件' },
    { name: 'websearch', riskLevel: 'medium' as const, description: '联网搜索' },
    { name: 'webfetch', riskLevel: 'medium' as const, description: '抓取网页内容' },
  ]

  return (
    <div className="flex h-full">
      {/* 左侧导航 */}
      <div className="w-56 border-r border-border py-4 overflow-auto flex-shrink-0">
        <div className="px-4 mb-4">
          <input
            type="text"
            placeholder="搜索设置..."
            className="w-full bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
          />
        </div>
        {SETTING_GROUPS.map(group => (
          <button
            key={group.id}
            onClick={() => setActiveGroup(group.id)}
            className={`w-full px-4 py-2.5 text-sm text-left flex items-center gap-3 transition-colors ${
              activeGroup === group.id
                ? 'bg-selected text-brand font-medium'
                : 'text-foreground/70 hover:text-foreground hover:bg-surface-hover'
            }`}
          >
            <span className="text-base">{group.icon}</span>
            <span>{group.label}</span>
          </button>
        ))}
      </div>

      {/* 右侧内容 */}
      <div className="flex-1 overflow-auto p-8">
        <h2 className="text-xl font-bold text-foreground mb-1">
          {SETTING_GROUPS.find(g => g.id === activeGroup)?.label}
        </h2>
        <p className="text-sm text-foreground/50 mb-8">
          管理你的偏好与配置
        </p>

        {activeGroup === 'general' && (
          <div>
            <SettingSection title="外观">
              <Select
                label="主题"
                description="选择应用外观主题"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'light', label: '浅色' },
                  { value: 'dark', label: '暗色' },
                  { value: 'system', label: '跟随系统' },
                ]}
              />
            </SettingSection>

            <SettingSection title="对话">
              <Toggle
                label="显示思考轨迹"
                description="在消息中显示模型的思考过程"
                enabled={reasoning}
                onChange={setReasoning}
              />
              <Toggle
                label="流式输出"
                description="实时显示模型生成的内容"
                enabled={streaming}
                onChange={setStreaming}
              />
              <Toggle
                label="自动压缩上下文"
                description="当对话过长时自动压缩历史消息"
                enabled={autoCompact}
                onChange={setAutoCompact}
              />
              <Select
                label="思考强度"
                description="控制模型思考的深度"
                value={thoughtLevel}
                onChange={setThoughtLevel}
                options={[
                  { value: 'off', label: '关闭' },
                  { value: 'low', label: '低' },
                  { value: 'high', label: '高' },
                  { value: 'max', label: '最高' },
                ]}
              />
            </SettingSection>

            <SettingSection title="上下文">
              <Select
                label="上下文窗口"
                description="单次对话的最大 token 数"
                value={contextWindow}
                onChange={setContextWindow}
                options={[
                  { value: '32000', label: '32K' },
                  { value: '64000', label: '64K' },
                  { value: '128000', label: '128K' },
                  { value: '200000', label: '200K' },
                ]}
              />
            </SettingSection>
          </div>
        )}

        {activeGroup === 'permissions' && (
          <div>
            <SettingSection title="执行模式">
              <div className="py-4">
                <p className="text-sm text-foreground/60 mb-4">控制 Agent 执行工具时的权限策略</p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { id: 'default', label: '默认模式', desc: '高风险操作前询问' },
                    { id: 'plan', label: '计划模式', desc: '先计划后执行' },
                    { id: 'acceptEdits', label: '自动接受编辑', desc: '自动接受文件编辑' },
                    { id: 'dontAsk', label: '静默模式', desc: '跳过常规确认' },
                    { id: 'bypassPermissions', label: '跳过权限检查', desc: '跳过所有权限（危险）' },
                  ].map(mode => (
                    <button
                      key={mode.id}
                      className={`p-4 rounded-xl border text-left transition-all ${
                        autoAccept ? 'border-brand/30 bg-brand/5' : 'border-card-border hover:border-brand/30 hover:bg-surface-hover'
                      }`}
                    >
                      <div className="text-sm font-semibold text-foreground">{mode.label}</div>
                      <div className="text-xs text-foreground/50 mt-1">{mode.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </SettingSection>

            <SettingSection title="工具权限">
              <div className="py-2">
                <p className="text-xs text-foreground/40 px-1 pb-3">为每个工具设置独立的权限策略</p>
              </div>
              {tools.map(tool => (
                <PermissionRow
                  key={tool.name}
                  toolName={tool.name}
                  riskLevel={tool.riskLevel}
                  description={tool.description}
                  override={toolOverrides[tool.name]}
                  onOverride={(decision) => {
                    setToolOverrides(prev => {
                      const next = { ...prev }
                      if (decision === 'ask') delete next[tool.name]
                      else next[tool.name] = decision
                      return next
                    })
                  }}
                />
              ))}
            </SettingSection>

            <SettingSection title="安全">
              <Toggle
                label="高风险操作确认"
                description="执行写入、删除等高风险操作前要求确认"
                enabled={confirmHighRisk}
                onChange={setConfirmHighRisk}
              />
              <Toggle
                label="自动接受低风险操作"
                description="自动接受读取、搜索等低风险操作"
                enabled={autoAccept}
                onChange={setAutoAccept}
              />
            </SettingSection>
          </div>
        )}

        {activeGroup === 'models' && (
          <div>
            <SettingSection title="模型配置">
              <div className="py-4">
                <p className="text-sm text-foreground/60 mb-4">配置 AI 模型通道与 API Key</p>
                <div className="space-y-3">
                  {[
                    { name: 'Claude', icon: '🧠', status: '未配置' },
                    { name: 'GPT', icon: '⚡', status: '未配置' },
                    { name: 'Gemini', icon: '💎', status: '未配置' },
                    { name: 'GLM', icon: '🔮', status: '已配置' },
                  ].map(model => (
                    <div key={model.name} className="flex items-center justify-between p-4 bg-input rounded-xl border border-card-border">
                      <div className="flex items-center gap-3">
                        <span className="w-10 h-10 rounded-xl bg-card flex items-center justify-center text-lg border border-card-border">
                          {model.icon}
                        </span>
                        <div>
                          <div className="text-sm font-semibold text-foreground">{model.name}</div>
                          <div className={`text-xs ${model.status === '已配置' ? 'text-success' : 'text-foreground/40'}`}>
                            {model.status}
                          </div>
                        </div>
                      </div>
                      <button className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                        model.status === '已配置'
                          ? 'text-foreground/60 border border-card-border hover:bg-surface-hover'
                          : 'text-brand border border-brand/30 hover:bg-brand/10'
                      }`}>
                        {model.status === '已配置' ? '修改' : '配置'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </SettingSection>
          </div>
        )}

        {activeGroup === 'providers' && (
          <div>
            <p className="text-sm text-foreground/50 mb-4">
              密钥与端点中心管理：一处配置，全 Agent 点击激活即用（DESIGN-ARCH-091）。
            </p>
            <div className="border border-card-border rounded-xl overflow-hidden">
              <KeyManagerPage embedded />
            </div>
          </div>
        )}

        {activeGroup !== 'general' && activeGroup !== 'models' && activeGroup !== 'permissions' && activeGroup !== 'providers' && (
          <div className="bg-card border border-card-border rounded-xl p-12 text-center">
            <span className="text-5xl block mb-4">
              {SETTING_GROUPS.find(g => g.id === activeGroup)?.icon}
            </span>
            <h3 className="text-lg font-semibold text-foreground mb-2">
              {SETTING_GROUPS.find(g => g.id === activeGroup)?.label}
            </h3>
            <p className="text-sm text-foreground/50">
              设置项将在后续 Phase 完善
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
