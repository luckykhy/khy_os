// ── 引导 settings page (ZC-ALIGN-003 §1, a11y s-30 引导 section) ──
// Pattern D: minimal content + dialog trigger.
// Two items: 优化体验 toggle + 打开引导 button (reopens onboarding modal).

interface OnboardingSettingsProps {
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

export function OnboardingSettings({ settings, onChange }: OnboardingSettingsProps) {
  return (
    <div className="max-w-3xl">
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
            // OnboardingDialog listens on the window event (same pattern as
            // khy:open-command-center), mounted once by SettingsPage.
            window.dispatchEvent(new Event('khy:open-onboarding'))
          }}
        />
      </SettingSection>
    </div>
  )
}

// ── Shared field components ──

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
