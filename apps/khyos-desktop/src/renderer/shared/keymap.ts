// keymap.ts — pure leaf (zero IO, deterministic, never throws).
//
// 目的：把桌面端「按键 → 动作名」这条决策收敛成**单一真源**，供三处派生：
//   1. 全局输入链（App.tsx 的 keydown、AppLayout 的面板快捷键）
//   2. 命令面板右侧的键位徽标（CommandCenter）
//   3. 窗口菜单项右侧的键位提示（TitleBar）
//
// 此前同一个 'Ctrl+O' 字符串在 main/menu.ts、CommandCenter、TitleBar 各写一遍，
// 改一处漏两处 —— 结果命令面板理直气壮地展示着 Ctrl+N / Ctrl+O，按下却没有任何
// 反应（menu.ts 根本没有被任何文件引入，主进程还 Menu.setApplicationMenu(null)
// 把原生菜单摘了）。[DESIGN-ARCH-125] P-03 把这张表立起来当唯一真源。
//
// 范式与 TUI 侧 services/backend/src/cli/tui/chatChords.js 对齐：叶子只做
// 「按键 → 动作名」纯映射，**绝不执行动作**（打开选择器 / 切换面板都涉及 React
// 状态与 IPC 副作用，留在各自的薄壳里）。
//
// 位置说明：放在 renderer/shared 而不是 src/shared —— 后者被 tsconfig.node.json
// 的 include 覆盖（主进程/preload 工程，产物进 dist-ts），而本叶子只服务渲染层，
// 主进程与 preload 都不 import 它。放进 src/shared 会让渲染层的每次新增都依赖
// node 工程先重新构建。
//
// 诚实边界：这张表**只登记已接线的动作**。没接线的能力不进表 —— 命令面板按本表
// 渲染徽标，表里没有就不显示键位；能力本身没接线就不渲染那条命令。
// 不为「看起来完整」补空壳键位（违诚实红线）。

export type DesktopAction =
  | 'newTask'
  | 'openWorkspace'
  | 'commandCenter'
  | 'cycleThoughtLevel'
  | 'openSettings'
  | 'toggleSidePane'
  | 'toggleTerminal'

export interface KeyBinding {
  action: DesktopAction
  /** 展示用键位字符串 —— 窗口菜单与命令面板的徽标都从这里取，不各自手写 */
  keys: string
  /** 匹配用：主键（小写）+ 修饰位 */
  key: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  /** 人类可读动作名（命令面板/帮助用） */
  label: string
}

export const KEY_BINDINGS: KeyBinding[] = [
  { action: 'newTask', keys: 'Ctrl+N', key: 'n', ctrl: true, label: '新建任务' },
  { action: 'openWorkspace', keys: 'Ctrl+O', key: 'o', ctrl: true, label: '打开工作区' },
  { action: 'commandCenter', keys: 'Ctrl+K', key: 'k', ctrl: true, label: '命令面板' },
  { action: 'cycleThoughtLevel', keys: 'Ctrl+T', key: 't', ctrl: true, label: '思考强度' },
  { action: 'openSettings', keys: 'Ctrl+,', key: ',', ctrl: true, label: '设置' },
  { action: 'toggleSidePane', keys: 'Ctrl+Alt+B', key: 'b', ctrl: true, alt: true, label: '切换面板' },
  { action: 'toggleTerminal', keys: 'Ctrl+J', key: 'j', ctrl: true, label: '切换终端' },
]

export interface KeyboardLike {
  key?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/**
 * 把一次按键解析成动作名（纯映射，绝不执行、绝不抛异常）。
 * @returns 命中的动作名；否则 null（含缺参、带表外修饰位的组合）。
 */
export function resolveDesktopAction(ev?: KeyboardLike | null): DesktopAction | null {
  if (!ev || typeof ev !== 'object') return null
  const rawKey = typeof ev.key === 'string' ? ev.key.toLowerCase() : ''
  if (!rawKey) return null
  // 本表不绑定 Cmd/Meta 组合（桌面端是 Windows 优先的无边框 + 自绘标题栏形态），
  // 带 meta 直接不认，避免在 macOS 上误吞系统快捷键。
  if (ev.metaKey) return null
  const ctrl = !!ev.ctrlKey
  const alt = !!ev.altKey
  const shift = !!ev.shiftKey
  for (const binding of KEY_BINDINGS) {
    if (binding.key !== rawKey) continue
    // 修饰位必须**精确**匹配：Ctrl+Shift+K 不该被 Ctrl+K 吞掉。
    if (!!binding.ctrl !== ctrl) continue
    if (!!binding.alt !== alt) continue
    if (!!binding.shift !== shift) continue
    return binding.action
  }
  return null
}

/** 取某动作的展示键位。无绑定返回空串，调用方据此不渲染徽标（不显示假快捷键）。 */
export function keyLabelFor(action: DesktopAction): string {
  const hit = KEY_BINDINGS.find((b) => b.action === action)
  return hit ? hit.keys : ''
}
