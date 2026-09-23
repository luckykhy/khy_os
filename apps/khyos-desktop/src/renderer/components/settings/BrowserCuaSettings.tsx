// ── 浏览器控制 settings page (ZC-ALIGN-002 I6, browser 41 keys) ──
// ── 电脑控制 settings page (ZC-ALIGN-002 I11, cuaPermission 28 keys) ──
// 电脑控制页每个控件走真实后端链路：写入设置键 → main 转发 host 进程改写
// 自己的 env（KHY_DESKTOP_CONTROL / KHY_DESKTOP_MAX_ACTUATIONS /
// KHY_COMPUTER_USE_ALLOWED_APPS）→ 后端 desktopControl/safetyGate 每次
// 授权调用重读 env，下一次操作立即生效。fail-closed：缺省 off。
import { useState, useEffect, useCallback } from 'react'

interface SettingsProps {
  settings: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}

interface DesktopGateState {
  mode: string
  budget: string | null
  allowedApps: string
}

type DesktopGateResponse = {
  ok: boolean
  gate?: DesktopGateState | null
  error?: string
}

// ── 浏览器控制 ──
export function BrowserSettings({ settings, onChange }: SettingsProps) {
  return (
    <div className="max-w-3xl">
      <SettingSection title="内置浏览器">
        <ToggleField
          label="启用内置浏览器"
          description="在侧边面板中使用内置浏览器浏览网页，支持 JavaScript 对话框拦截。"
          enabled={settings.browserEnabled !== false}
          onChange={(v) => onChange('browserEnabled', v)}
        />
        <ToggleField
          label="自动拦截弹窗"
          description="自动拦截网页的 alert/confirm/prompt 对话框，转由应用处理。"
          enabled={settings.browserDialogIntercept !== false}
          onChange={(v) => onChange('browserDialogIntercept', v)}
        />
      </SettingSection>

      <SettingSection title="代理">
        <ToggleField
          label="跟随系统代理"
          description="内置浏览器跟随系统代理设置。关闭后使用常规设置中的 HTTP 代理。"
          enabled={settings.browserFollowSystemProxy === true}
          onChange={(v) => onChange('browserFollowSystemProxy', v)}
        />
      </SettingSection>

      <SettingSection title="安全">
        <ToggleField
          label="阻止不安全内容"
          description="阻止混合内容页面中的不安全（HTTP）资源加载。"
          enabled={settings.blockInsecureContent !== false}
          onChange={(v) => onChange('blockInsecureContent', v)}
        />
      </SettingSection>
    </div>
  )
}

// ── 电脑控制 ──
// 后端 safetyGate 授权光谱（off/ask/on/strict）逐档暴露；每次写入经
// settings:set 持久化并由 main 实时推送到 host env。页面同时从 host
// 实读生效状态展示（desktopGateGet），不渲染端自报。
const CUA_MODE_OPTIONS = [
  { value: 'off', label: '关闭（默认）' },
  { value: 'ask', label: '每次操作前确认' },
  { value: 'on', label: '允许（自动执行）' },
  { value: 'strict', label: '严格审批' },
]

function gateModeLabel(mode: string | undefined): string {
  const hit = CUA_MODE_OPTIONS.find((o) => o.value === mode)
  return hit ? `${hit.label}（${hit.value}）` : '关闭（off，fail-closed）'
}

export function CuaSettings({ settings, onChange }: SettingsProps) {
  const [gate, setGate] = useState<DesktopGateState | null>(null)
  const [gateError, setGateError] = useState('')
  const [gateLoading, setGateLoading] = useState(true)

  const loadGate = useCallback(() => {
    const api = (window as unknown as {
      __KHYOS__?: { desktopGateGet?: () => Promise<DesktopGateResponse> }
    }).__KHYOS__
    if (!api?.desktopGateGet) {
      setGateError('安全闸状态不可用：preload 未注入 __KHYOS__，请重启应用')
      setGateLoading(false)
      return
    }
    setGateLoading(true)
    api.desktopGateGet().then((res) => {
      if (res?.ok && res.gate) {
        setGate(res.gate)
        setGateError('')
      } else {
        setGateError(res?.error || '安全闸状态读取失败：host 未返回数据，请重启应用')
      }
      setGateLoading(false)
    }).catch(() => {
      setGateError('安全闸状态读取失败：host 进程无响应，请重启应用')
      setGateLoading(false)
    })
  }, [])

  useEffect(() => { loadGate() }, [loadGate])

  return (
    <div className="max-w-3xl">
      {gateError && (
        <div className="mb-4 px-4 py-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-xl">
          {gateError}
        </div>
      )}

      <SettingSection title="权限总闸">
        <SelectField
          label="电脑控制模式"
          description="后端 safetyGate 授权光谱。关闭（默认）时屏幕捕获与鼠标键盘操作全部硬拒绝；修改后实时写入 host 进程的 KHY_DESKTOP_CONTROL。"
          value={(settings.cuaDesktopControlMode as string) || 'off'}
          onChange={(v) => onChange('cuaDesktopControlMode', v)}
          options={CUA_MODE_OPTIONS}
        />
        <TextField
          label="信任区域白名单"
          description="逗号分隔的应用名。白名单内应用的风险降一档，其余操作仍按模式审批；清空表示不设信任区域。"
          value={(settings.cuaAllowedApps as string) || ''}
          placeholder="例如 记事本,Calculator"
          onChange={(v) => onChange('cuaAllowedApps', v)}
        />
      </SettingSection>

      <SettingSection title="执行安全">
        <TextField
          label="单会话操作数上限"
          description="单个会话的鼠标键盘操作数达到上限后自动熔断吊销，防止失控循环；留空使用后端默认 500。"
          value={(settings.cuaMaxActuations as string) || ''}
          placeholder="500（后端默认）"
          onChange={(v) => onChange('cuaMaxActuations', v)}
        />
      </SettingSection>

      <SettingSection title="后端生效状态（host 实读）">
        <div className="py-4 text-sm text-foreground/70">
          {gateLoading && !gate ? (
            <span>读取 host 安全闸生效状态…</span>
          ) : gate ? (
            <div className="flex flex-col gap-1.5">
              <span>授权模式：{gateModeLabel(gate.mode)}</span>
              <span>单会话操作上限：{gate.budget ? `${gate.budget} 次` : '500 次（后端默认）'}</span>
              <span>信任区域：{gate.allowedApps || '未设置'}</span>
            </div>
          ) : (
            <span>暂无数据</span>
          )}
          <button
            onClick={loadGate}
            className="mt-2 text-xs text-foreground/50 hover:text-foreground transition-colors"
          >
            刷新
          </button>
        </div>
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

// Local draft + commit on blur: typing must not fire a settings write (and a
// host env push) on every keystroke.
function TextField({ label, description, value, placeholder, onChange }: {
  label: string
  description: string
  value: string
  placeholder?: string
  onChange: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <div className="py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="text-xs text-foreground/50 mt-1 leading-relaxed">{description}</div>
        </div>
        <input
          type="text"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { if (draft !== value) onChange(draft) }}
          className="bg-input border border-input-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-input-border-focused min-w-[180px] flex-shrink-0"
        />
      </div>
    </div>
  )
}
