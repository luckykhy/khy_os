import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'path'
import { fork } from 'child_process'
import { createMenu } from './menu'
import { openKeyManagerWindow } from './keyManagerWindow'
import { registerKeyManagerIpc } from './keyManager/ipc'

// Phase 0a + 0b + 0c: 最小主进程 + IPC handler + host 进程
// KeyManager (DESIGN-ARCH-091 P1): standalone key/endpoint manager window

let hostProcess: ReturnType<typeof fork> | null = null

const KEY_MANAGER_STANDALONE = process.argv.includes('--key-manager')

function startHostProcess() {
  const hostPath = path.join(__dirname, '../host/index.js')
  hostProcess = fork(hostPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  hostProcess.stdout?.on('data', (data) => console.log('[host]', data.toString()))
  hostProcess.stderr?.on('data', (data) => console.error('[host]', data.toString()))
  hostProcess.on('message', (msg) => console.log('[host] message:', msg))
  hostProcess.on('exit', (code) => {
    console.log(`[host] 进程退出, code=${code}`)
    hostProcess = null
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1216,
    height: 808,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // dev-server URL from env (electron-vite injects VITE_DEV_SERVER_URL); the
  // port falls back to a variable (zero-hardcoding exemption class)
  const devPort = process.env.VITE_DEV_PORT || '5173'
  const devServerUrl = process.env.VITE_DEV_SERVER_URL || `http://localhost:${devPort}/`
  if (process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === 'development') {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())

  // 窗口控制
  ipcMain.handle('window:minimize', () => win.minimize())
  ipcMain.handle('window:maximize', () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle('window:close', () => win.close())
  ipcMain.handle('app:version', () => app.getVersion())

  // 设置读写（stub）
  ipcMain.handle('settings:get', async () => ({
    locale: 'zh-CN',
    themeMode: 'dark',
    desktopWindowSize: { width: 1216, height: 808, maximized: false }
  }))
  ipcMain.handle('settings:set', async (e, key: string, value: unknown) => {
    console.log(`[settings] set ${key} =`, value)
    return true
  })

  // 主题
  ipcMain.handle('theme:get', async () => 'dark')
  ipcMain.handle('theme:set', async (e, mode: string) => {
    console.log(`[theme] set mode = ${mode}`)
    return true
  })

  // 文件系统
  ipcMain.handle('fs:openDirectory', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('fs:readFile', async (e, filePath: string) => {
    const fs = await import('fs/promises')
    return fs.readFile(filePath, 'utf-8')
  })
  ipcMain.handle('fs:writeFile', async (e, filePath: string, content: string) => {
    const fs = await import('fs/promises')
    await fs.writeFile(filePath, content, 'utf-8')
    return true
  })

  // AI 网关（stub）
  ipcMain.handle('ai:send', async (e, payload: unknown) => {
    console.log('[ai] send', payload)
    return { ok: true, text: 'stub response' }
  })
  ipcMain.handle('ai:stream', async (e, payload: unknown) => {
    console.log('[ai] stream', payload)
    return { ok: true }
  })

  // 会话（stub）
  ipcMain.handle('session:create', async (e, workspacePath: string) => {
    return { id: `sess_${Date.now()}`, workspacePath }
  })
  ipcMain.handle('session:list', async () => [])

  // host 进程状态
  ipcMain.handle('host:status', async () => {
    return { running: !!hostProcess, pid: hostProcess?.pid }
  })

  return win
}

app.whenReady().then(() => {
  // Key/Endpoint Manager IPC (DESIGN-ARCH-091 §6) — global, registered once
  registerKeyManagerIpc(ipcMain)

  if (KEY_MANAGER_STANDALONE) {
    // standalone entry: `npm run dev -- --key-manager` — only the manager
    // window is created, no main window / host process (spec §5.1 入口③)
    openKeyManagerWindow({ standalone: true })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openKeyManagerWindow({ standalone: true })
    })
    return
  }

  startHostProcess()
  const win = createWindow()
  createMenu(win, () => openKeyManagerWindow())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = createWindow()
      createMenu(newWin, () => openKeyManagerWindow())
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
