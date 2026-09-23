// tray — 系统托盘快捷切换（DESIGN-ARCH-094 P3，cc-switch 托盘语义）。
//
// 每个工具一个子菜单：当前激活卡打勾 + 全部卡片可点即切换 + 「failover 轮换」
// 条目。托盘图标为运行时生成的 16×16 位图（零美术资产、零硬编码端点）。

import { Tray, Menu, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { listCards, setActive, clearActive, rotateFailover } from './providers.ts'

const TOOLS = ['claude-code', 'opencode', 'zcode', 'codex', 'command-code', 'ycode']

/** 运行时生成 16×16 单色图标（RGBA 位图，避开美术资产依赖）。 */
function buildIcon(): Electron.NativeImage {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4
      const onBorder = x === 0 || y === 0 || x === size - 1 || y === size - 1
      buf[i] = onBorder ? 0x4f : 0x1c
      buf[i + 1] = onBorder ? 0x8c : 0x20
      buf[i + 2] = onBorder ? 0xff : 0x29
      buf[i + 3] = 255
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

export async function setupTray(): Promise<Tray | null> {
  let tray: Tray
  try {
    tray = new Tray(buildIcon())
  } catch {
    return null // 无托盘环境（Linux 无 appindicator 等）→ fail-soft
  }
  tray.setToolTip('KhyOS Provider Hub')
  await rebuildTrayMenu(tray)
  return tray
}

/** 重建托盘菜单（每次操作后调用，保证激活态/队列状态实时）。 */
export async function rebuildTrayMenu(tray: Tray): Promise<void> {
  const { cards, active, failover } = await listCards()
  const items: MenuItemConstructorOptions[] = []
  for (const tool of TOOLS) {
    const activeId = active[tool] || ''
    const activeName = cards.find((c) => c.id === activeId)?.name || ''
    const cardItems: MenuItemConstructorOptions[] = cards.map((card) => ({
      label: card.name,
      type: 'checkbox' as const,
      checked: activeId === card.id,
      click: async () => {
        if (activeId === card.id) await clearActive(tool)
        else await setActive(tool, card.id)
        await rebuildTrayMenu(tray)
      }
    }))
    const queue = failover[tool] || []
    const rotateItem: MenuItemConstructorOptions = {
      label: `failover 轮换（${queue.length} 张备卡）`,
      enabled: queue.length > 0,
      click: async () => {
        await rotateFailover(tool)
        await rebuildTrayMenu(tray)
      }
    }
    items.push({
      label: `${tool}${activeId ? ` · ${activeName || activeId}` : ' · (未激活)'}`,
      submenu: [...cardItems, { type: 'separator' as const }, rotateItem]
    })
  }
  tray.setContextMenu(Menu.buildFromTemplate(items))
}
