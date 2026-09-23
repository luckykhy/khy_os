import { useState, useEffect } from 'react'
import { applyTheme, applyMessageFontSize } from '../../theme/theme'

// ── 外观 settings page (ZC-ALIGN-002 I 区, account menu 界面主题/界面缩放 子菜单) ──
// Theme switching via window.__KHYOS__.setTheme IPC (preload already exposes this).
// a11y evidence: account menu s-44 界面主题 radio (系统默认/深色✓/浅色),
// s-46 界面缩放 (放大/缩小/实际大小 Ctrl+0 disabled).

interface AppearanceSettingsProps {
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

export function AppearanceSettings({ settings, onChange }: AppearanceSettingsProps) {
  const [theme, setTheme] = useState('system')

  // Load current theme on mount
  useEffect(() => {
    const api = (window as unknown as {
      __KHYOS__?: { getTheme?: () => Promise<string> }
    }).__KHYOS__
    api?.getTheme?.().then((t) => setTheme(t || 'system')).catch(() => {})
  }, [])

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme)
    // 立即应用到 DOM（预览），同时持久化到主进程 settings.json。
    // 主进程随后广播 theme:changed，App.tsx 的订阅会再次 applyTheme（幂等）。
    applyTheme(newTheme)
    const api = (window as unknown as {
      __KHYOS__?: { setTheme?: (mode: string) => Promise<void> }
    }).__KHYOS__
    api?.setTheme?.(newTheme).catch(() => {})
    onChange('theme', newTheme)
  }

  return (
    <div className="max-w-3xl">
      {/* ── 主题 ── */}
      <SettingSection title="主题">
        <RadioField
          label="界面主题"
          description="选择应用外观主题。系统默认跟随操作系统深浅色设置。"
          value={theme}
          options={[
            { value: 'system', label: '系统默认' },
            { value: 'dark', label: '深色主题' },
            { value: 'light', label: '浅色主题' },
          ]}
          onChange={handleThemeChange}
        />
      </SettingSection>

      {/* ── 缩放 ── */}
      <SettingSection title="缩放">
        <ActionField
          label="界面缩放"
          description="使用快捷键 Ctrl++ 放大、Ctrl+- 缩小、Ctrl+0 恢复实际大小。"
          buttonText="实际大小"
          onClick={() => {
            // Reset to 100% via zoom:set IPC (main clamps + applies to sender)
            const api = (window as unknown as {
              __KHYOS__?: { setZoomFactor?: (factor: number) => Promise<number> }
            }).__KHYOS__
            api?.setZoomFactor?.(1).catch(() => {})
          }}
        />
      </SettingSection>

      {/* ── 代码高亮 ── */}
      <SettingSection title="代码高亮">
        <ToggleField
          label="代码块语法高亮"
          description="在消息流中对代码块启用 Shiki 语法高亮。"
          enabled={settings.codeHighlight !== false}
          onChange={(v) => onChange('codeHighlight', v)}
        />
        <ToggleField
          label="行号显示"
          description="在代码块中显示行号。"
          enabled={settings.codeLineNumbers === true}
          onChange={(v) => onChange('codeLineNumbers', v)}
        />
      </SettingSection>

      {/* ── 字体 ── */}
      <SettingSection title="字体">
        <SelectField
          label="消息字体大小"
          description="调整消息流正文的字体大小。"
          value={(settings.messageFontSize as string) || '14'}
          onChange={(v) => {
            // Persist via settings:set + apply immediately as the
            // --khy-message-font-size CSS var (consumed by MarkdownRenderer)
            onChange('messageFontSize', v)
            applyMessageFontSize(v)
          }}
          options={[
            { value: '13', label: '小' },
            { value: '14', label: '中' },
            { value: '15', label: '大' },
            { value: '16', label: '更大' },
          ]}
        />
      </SettingSection>
    </div>
  )
}

// ── Reusable field components (shared pattern with GeneralSettings) ──

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

function SelectField({ label, description, value, onChange, options }: {
  label: string
  description: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="flex items-center justify-between py-4 gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-foreground/50 mt-1 leading-relaxed">{description}</div>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-input-border-focused min-w-[140px] flex-shrink-0"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  )
}

function RadioField({ label, description, value, onChange, options }: {
  label: string
  description: string
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="py-4">
      <div className="text-sm font-medium text-foreground mb-1">{label}</div>
      <div className="text-xs text-foreground/50 mb-3 leading-relaxed">{description}</div>
      <div className="flex flex-col gap-2">
        {options.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-hover cursor-pointer transition-colors"
          >
            <input
              type="radio"
              name={label}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              className="w-4 h-4 accent-brand"
            />
            <span className="text-sm text-foreground">{opt.label}</span>
            {value === opt.value && (
              <span className="text-xs text-brand">✓</span>
            )}
          </label>
        ))}
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
