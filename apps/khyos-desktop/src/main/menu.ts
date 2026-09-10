import { Menu, BrowserWindow, app, shell } from 'electron'

export function createMenu(mainWindow: BrowserWindow, onOpenKeyManager?: () => void) {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // 工具菜单（DESIGN-ARCH-091 §5.1 入口①：密钥与端点管理）
    {
      label: '工具',
      submenu: [
        {
          label: '密钥与端点管理',
          accelerator: 'Ctrl+Shift+K',
          click: () => onOpenKeyManager?.()
        }
      ]
    },
    // 文件菜单
    {
      label: '文件',
      submenu: [
        {
          label: '新建任务',
          accelerator: 'Ctrl+N',
          click: () => mainWindow.webContents.send('menu:new-task')
        },
        {
          label: '打开工作区',
          accelerator: 'Ctrl+O',
          click: () => mainWindow.webContents.send('menu:open-workspace')
        },
        { type: 'separator' },
        {
          label: '关闭窗口',
          accelerator: 'Ctrl+W',
          click: () => mainWindow.close()
        }
      ]
    },
    // 视图菜单
    {
      label: '视图',
      submenu: [
        {
          label: '切换全屏',
          accelerator: 'F11',
          click: () => mainWindow.setFullScreen(!mainWindow.isFullScreen())
        },
        { type: 'separator' },
        {
          label: '放大',
          accelerator: 'Ctrl+=',
          click: () => {
            const zoom = mainWindow.webContents.getZoomFactor()
            mainWindow.webContents.setZoomFactor(zoom + 0.1)
          }
        },
        {
          label: '缩小',
          accelerator: 'Ctrl+-',
          click: () => {
            const zoom = mainWindow.webContents.getZoomFactor()
            mainWindow.webContents.setZoomFactor(zoom - 0.1)
          }
        },
        {
          label: '实际大小',
          accelerator: 'Ctrl+0',
          click: () => mainWindow.webContents.setZoomFactor(1.0)
        }
      ]
    },
    // 窗口菜单
    {
      label: '窗口',
      submenu: [
        {
          label: '最小化',
          accelerator: 'Ctrl+M',
          click: () => mainWindow.minimize()
        },
        {
          label: '最大化',
          click: () => {
            if (mainWindow.isMaximized()) mainWindow.unmaximize()
            else mainWindow.maximize()
          }
        }
      ]
    },
    // 帮助菜单
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 KhyOS Desktop',
          click: () => mainWindow.webContents.send('menu:about')
        },
        {
          label: '检查更新',
          click: () => mainWindow.webContents.send('menu:check-update')
        },
        {
          label: '问题反馈',
          click: () => shell.openExternal('https://khyquant.top/feedback')
        },
        { type: 'separator' },
        {
          label: '导出日志',
          click: () => mainWindow.webContents.send('menu:export-logs')
        },
        {
          label: '进程监视器',
          click: () => mainWindow.webContents.send('menu:process-monitor')
        },
        {
          label: '开始性能录制',
          click: () => mainWindow.webContents.send('menu:start-recording')
        },
        {
          label: '停止性能录制',
          click: () => mainWindow.webContents.send('menu:stop-recording')
        },
        { type: 'separator' },
        {
          label: '切换开发者工具',
          accelerator: 'F12',
          click: () => mainWindow.webContents.toggleDevTools()
        },
        {
          label: '抓取 Agent stdio 通信',
          click: () => mainWindow.webContents.send('menu:toggle-stdio-tap')
        },
        { type: 'separator' },
        {
          label: '清除所有数据',
          click: () => mainWindow.webContents.send('menu:clear-data')
        }
      ]
    }
  ]

  // macOS 添加应用菜单
  if (isMac) {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const }
      ]
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
