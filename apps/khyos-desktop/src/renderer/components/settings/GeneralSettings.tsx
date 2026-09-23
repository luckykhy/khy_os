import { useState, useCallback, useEffect } from 'react'

// ── General settings page (ZC-ALIGN-003 §3, a11y s-7 全 28 项) ──
// All item labels/descriptions match ZCode v3.11.2 a11y text exactly.
// State persists via parent's settings/onChange → preload IPC settings:set.

interface GeneralSettingsProps {
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

export function GeneralSettings({ settings, onChange }: GeneralSettingsProps) {
  return (
    <div className="max-w-3xl">
      {/* ── 引导 (ZCode s-7: first section on the General page) ── */}
      <SettingSection title="引导">
        <ToggleField
          label="优化体验"
          description="允许我们将你的对话内容用于优化 Agent 的使用体验。我们保障你的数据隐私安全。"
          enabled={settings.optInExperience === true}
          onChange={(v) => onChange('optInExperience', v)}
        />
        <ActionField
          label="打开引导"
          description="重新打开引导弹窗，查看迁移选项并导入设置。"
          buttonText="打开引导"
          onClick={() => {
            // Same OnboardingDialog event as the 引导 page (D5/s-8 spec).
            window.dispatchEvent(new Event('khy:open-onboarding'))
          }}
        />
      </SettingSection>

      {/* ── 数据 ── */}
      <SettingSection title="数据">
        <PathField
          label="数据存储路径"
          description="应用数据的根目录（默认为用户主目录），修改后会将现有数据复制到新位置。路径后缀 .khy 不可更改。"
          value={(settings.dataPath as string) || ''}
          placeholder="默认：用户主目录"
          onChange={(v) => onChange('dataPath', v)}
        />
        <SelectField
          label="归档保留时长"
          description="任务最后更新时间早于该时长后，才会进入自动归档候选。"
          value={(settings.archiveRetention as string) || '7d'}
          disabled={settings.autoArchive === false}
          onChange={(v) => onChange('archiveRetention', v)}
          options={[
            { value: '7d', label: '7 天后归档' },
            { value: '30d', label: '30 天后归档' },
          ]}
        />
        <ToggleField
          label="自动归档旧任务"
          description="定时扫描最近打开过的工作区，将已完成、无未读、未置顶且超过保留期的任务自动归档。"
          enabled={settings.autoArchive !== false}
          onChange={(v) => onChange('autoArchive', v)}
        />
      </SettingSection>

      {/* ── 消息流分组 ── */}
      <SettingSection title="消息流分组">
        <ToggleField
          label="分组文件更改"
          description="将连续的 Write、Edit 和 ApplyPatch 调用聚合为 Changes 分组。"
          enabled={settings.groupFileChanges !== false}
          onChange={(v) => onChange('groupFileChanges', v)}
        />
        <ToggleField
          label="分组终端命令"
          description="将连续的非只读 Shell 命令聚合为 Terminal 分组。"
          enabled={settings.groupTerminalCommands !== false}
          onChange={(v) => onChange('groupTerminalCommands', v)}
        />
        <ToggleField
          label="分组探索工具"
          description="将连续的读取和搜索工具聚合为 Explore 分组。"
          enabled={settings.groupExploreTools !== false}
          onChange={(v) => onChange('groupExploreTools', v)}
        />
      </SettingSection>

      {/* ── 消息流显示 ── */}
      <SettingSection title="消息流显示">
        <ToggleField
          label="显示待办"
          description="在消息流中展示 Todo 工具卡片。"
          enabled={settings.showTodo === true}
          onChange={(v) => onChange('showTodo', v)}
        />
        <ToggleField
          label="显示思考过程"
          description="在消息流中展示完整的模型思考内容；关闭时每轮仍展示第一次思考。"
          enabled={settings.showReasoning !== false}
          onChange={(v) => onChange('showReasoning', v)}
        />
        <ToggleField
          label="完整保留模型 I/O"
          description="保留完整的模型请求和响应，不自动压缩、限制大小或删除旧记录。"
          enabled={settings.keepFullModelIO === true}
          onChange={(v) => onChange('keepFullModelIO', v)}
        />
        <ToggleField
          label="提问自动继续"
          description="开启后，Agent 提问 5 分钟未回答会自动继续；关闭后，当前和后续提问会一直等待你的回答。"
          enabled={settings.autoContinueQuestions !== false}
          onChange={(v) => onChange('autoContinueQuestions', v)}
        />
        <SelectField
          label="交互行为"
          description="在 KhyOS 运行时将后续操作加入队列，或引导至下一轮工具调用后运行。"
          value={(settings.interactionBehavior as string) || 'queue'}
          onChange={(v) => onChange('interactionBehavior', v)}
          options={[
            { value: 'queue', label: '队列' },
            { value: 'guide', label: '引导' },
          ]}
        />
      </SettingSection>

      {/* ── 系统行为 ── */}
      <SettingSection title="系统行为">
        <ToggleField
          label="保持电脑运行"
          description="打开后阻止系统因空闲进入休眠（仍可手动睡眠/合盖休眠）。桌面端全局生效。"
          enabled={settings.preventIdleSleep === true}
          onChange={(v) => onChange('preventIdleSleep', v)}
        />
        <ToggleField
          label="关闭窗口时隐藏到托盘"
          description="仅 Windows 生效。点击关闭按钮或关闭窗口快捷键时隐藏窗口，托盘中的退出仍会完全退出应用。"
          enabled={settings.hideToTray === true}
          onChange={(v) => onChange('hideToTray', v)}
        />
        <ToggleField
          label="通知声音"
          description="通知开启后，可单独关闭任务通知提示音。"
          enabled={settings.notificationSound !== false}
          onChange={(v) => onChange('notificationSound', v)}
        />
        <ToggleField
          label="任务通知"
          description="任务完成、失败或需要确认时发送桌面通知。"
          enabled={settings.taskNotifications !== false}
          onChange={(v) => onChange('taskNotifications', v)}
        />
      </SettingSection>

      {/* ── 更新 ── */}
      <SettingSection title="更新">
        <ToggleField
          label="自动下载并安装更新"
          description="开启后检测到更新会自动开始下载；下载完成后，如有任务正在运行，重启更新前仍会要求确认。"
          enabled={settings.autoUpdate === true}
          onChange={(v) => onChange('autoUpdate', v)}
        />
        <ToggleField
          label="接受提前收到预览版更新"
          description="开启后将最快、提前体验新功能和改进版本，关闭后将随着版本发布节奏获得版本推送更新。"
          enabled={settings.prereleaseUpdates === false}
          onChange={(v) => onChange('prereleaseUpdates', v)}
        />
        <ToggleField
          label="Chrome 硬件加速"
          description="关闭后可规避部分显卡或驱动导致的白屏、闪退、渲染异常。修改后需重启应用生效。"
          enabled={settings.hardwareAcceleration !== false}
          onChange={(v) => onChange('hardwareAcceleration', v)}
        />
      </SettingSection>

      {/* ── 网络与证书 ── */}
      <SettingSection title="网络与证书">
        <SaveField
          label="自定义证书"
          description="可选。填写 PEM 根证书路径后，会作为 NODE_EXTRA_CA_CERTS 注入模型、MCP 与命令工具，并用于渲染层证书校验。修改后需重启应用生效。"
          value={(settings.customCert as string) || ''}
          placeholder="例如 /Users/name/certs/root-ca.pem"
          onChange={(v) => onChange('customCert', v)}
        />
        <SaveField
          label="不使用代理的地址"
          description="匹配这些主机的请求将直连，不经过 HTTP 代理。多个规则用英文逗号分隔。修改后需重启应用生效。"
          value={(settings.noProxy as string) || ''}
          placeholder="例如 localhost,127.0.0.1,::1,.example.com,*.corp.com"
          onChange={(v) => onChange('noProxy', v)}
        />
        <SaveField
          label="HTTP 代理"
          description="模型、MCP、命令工具与应用渲染层的出口流量将经此代理，不读取系统环境变量。留空时这些流量直连，内置浏览器则跟随系统代理设置。修改后需重启应用生效。"
          value={(settings.httpProxy as string) || ''}
          placeholder="留空则内置浏览器跟随系统代理，例如 http://127.0.0.1:7890"
          onChange={(v) => onChange('httpProxy', v)}
        />
      </SettingSection>

      {/* ── 终端 ── */}
      <SettingSection title="终端">
        <ToggleField
          label="增强 Find 和 Grep"
          description="在新建会话或应用重启后恢复的会话中使用增强 Find 和 Grep。当前会话保持现有设置；Windows 的 Find 保持不变。"
          enabled={settings.enhancedFindGrep === true}
          onChange={(v) => onChange('enhancedFindGrep', v)}
        />
        <SelectField
          label="集成终端 Shell"
          description="仅新会话生效。Windows 下 Bash 工具用此 shell；自动优先 Git Bash，找不到回退 cmd.exe。"
          value={(settings.terminalShell as string) || 'auto'}
          onChange={(v) => onChange('terminalShell', v)}
          options={[
            { value: 'auto', label: '自动选择' },
            { value: 'bash', label: 'Git Bash' },
            { value: 'cmd', label: 'cmd.exe' },
          ]}
        />
        <SaveField
          label="终端字体"
          description="留空时自动探测系统终端配置；填写后作为 KhyOS 终端的字体覆盖。"
          value={(settings.terminalFont as string) || ''}
          placeholder="留空自动继承，例如 MesloLGS NF, monospace"
          onChange={(v) => onChange('terminalFont', v)}
        />
        <ToggleField
          label="继承系统终端 Profile"
          description="启动内置终端时尽量继承登录 shell 环境、代理、Kube 变量和本机终端字体。"
          enabled={settings.inheritTerminalProfile !== false}
          onChange={(v) => onChange('inheritTerminalProfile', v)}
        />
      </SettingSection>

      {/* ── 语言 ── */}
      <SettingSection title="语言">
        <SelectField
          label="界面语言"
          description="选择应用 UI 的显示语言。"
          value={(settings.locale as string) || 'system'}
          onChange={(v) => onChange('locale', v)}
          // Persist only: no en bundle exists yet (i18n has zh-CN only), so
          // switching language here saves the preference without rerendering.
          options={[
            { value: 'system', label: '系统默认' },
            { value: 'en', label: 'English' },
            { value: 'zh-CN', label: '中文简体' },
          ]}
        />
      </SettingSection>
    </div>
  )
}

// ── Reusable field components (match ZCode settings row layout) ──

function SettingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h3 className="text-sm font-medium text-foreground mb-3 px-1">{title}</h3>
      <div className="bg-card border border-card-border rounded-xl px-5 divide-y divide-card-border">
        {children}
      </div>
    </div>
  )
}

function ToggleField({ label, description, enabled, onChange }: {
  label: string
  description: string
  enabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between py-4 gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-foreground/50 mt-1 leading-relaxed">{description}</div>
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${
          enabled ? 'bg-brand' : 'bg-foreground/20'
        }`}
        role="switch"
        aria-checked={enabled}
      >
        <span
          className={`absolute left-1 top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
            enabled ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

function SelectField({ label, description, value, onChange, options, disabled }: {
  label: string
  description: string
  value: string
  onChange?: (v: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between py-4 gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-foreground/50 mt-1 leading-relaxed">{description}</div>
      </div>
      <select
        value={value}
        onChange={disabled ? undefined : (e) => onChange?.(e.target.value)}
        disabled={disabled}
        className="bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-input-border-focused min-w-[140px] flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}

function SaveField({ label, description, value, placeholder, onChange }: {
  label: string
  description: string
  value: string
  placeholder: string
  onChange: (v: string) => void
}) {
  const [localValue, setLocalValue] = useState(value)
  const [dirty, setDirty] = useState(false)

  const handleChange = (v: string) => {
    setLocalValue(v)
    setDirty(v !== value)
  }

  const handleSave = () => {
    onChange(localValue)
    setDirty(false)
  }

  return (
    <div className="py-4">
      <div className="text-sm font-medium text-foreground mb-1">{label}</div>
      <div className="text-xs text-foreground/50 mb-3 leading-relaxed">{description}</div>
      <div className="flex gap-2">
        <input
          type="text"
          value={localValue}
          placeholder={placeholder}
          onChange={(e) => handleChange(e.target.value)}
          className="flex-1 bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
        />
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="px-4 py-2 text-sm font-medium rounded-lg transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed bg-brand/10 text-brand hover:bg-brand/20"
        >
          保存
        </button>
      </div>
    </div>
  )
}

function PathField({ label, description, value, placeholder, onChange }: {
  label: string
  description: string
  value: string
  placeholder: string
  onChange: (v: string) => void
}) {
  const [localValue, setLocalValue] = useState(value)
  const [dirty, setDirty] = useState(false)

  // Sync when the persisted value changes from outside (e.g. parent reload)
  useEffect(() => {
    setLocalValue(value)
    setDirty(false)
  }, [value])

  const handlePick = useCallback(() => {
    const api = (window as unknown as {
      __KHYOS__?: { openDirectoryPicker?: () => Promise<string> }
    }).__KHYOS__
    api?.openDirectoryPicker?.().then((dir) => {
      if (dir) {
        setLocalValue(dir)
        setDirty(dir !== value)
      }
    }).catch(() => {})
  }, [value])

  const handleSave = () => {
    // Data-path changes go through the migration IPC (copy data + write
    // pointer), not the plain settings:set — see main settings:setDataPath.
    const api = (window as unknown as {
      __KHYOS__?: { setDataPath?: (p: string) => Promise<{ ok: boolean; error?: string }> }
    }).__KHYOS__
    api?.setDataPath?.(localValue).then((res) => {
      if (res?.ok) {
        onChange(localValue)
        setDirty(false)
      } else {
        // Migration failed: keep dirty so the 保存 button stays retryable
        setDirty(true)
      }
    }).catch(() => {
      setDirty(true)
    })
  }

  return (
    <div className="py-4">
      <div className="text-sm font-medium text-foreground mb-1">{label}</div>
      <div className="text-xs text-foreground/50 mb-3 leading-relaxed">{description}</div>
      <div className="flex gap-2">
        <input
          type="text"
          value={localValue}
          placeholder={placeholder}
          onChange={(e) => {
            setLocalValue(e.target.value)
            setDirty(e.target.value !== value)
          }}
          className="flex-1 bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground/40 focus:outline-none focus:border-input-border-focused"
        />
        <button
          onClick={handlePick}
          className="px-4 py-2 text-sm font-medium rounded-lg transition-colors flex-shrink-0 border border-card-border text-foreground/70 hover:text-foreground hover:bg-surface-hover"
        >
          选择文件夹
        </button>
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="px-4 py-2 text-sm font-medium rounded-lg transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed bg-brand/10 text-brand hover:bg-brand/20"
        >
          保存
        </button>
      </div>
    </div>
  )
}

function ActionField({ label, description, buttonText, onClick }: {
  label: string
  description: string
  buttonText: string
  onClick: () => void
}) {
  return (
    <div className="flex items-center justify-between py-4 gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-foreground/50 mt-1 leading-relaxed">{description}</div>
      </div>
      <button
        onClick={onClick}
        className="px-4 py-2 text-sm font-medium rounded-lg transition-colors flex-shrink-0 border border-card-border text-foreground/70 hover:text-foreground hover:bg-surface-hover"
      >
        {buttonText}
      </button>
    </div>
  )
}
