// keyManagerWindow — the standalone Key/Endpoint Manager window
// (DESIGN-ARCH-091 §5.1 入口③: `--key-manager` 独立启动 + 菜单入口).
//
// 1080×720 (min 880×560), frameless like the main window, same preload.
// The renderer loads #/key-manager and renders the full-screen manager view.

import { BrowserWindow, app } from 'electron'
import path from 'path'

export interface KeyManagerWindowOptions {
  standalone?: boolean
}

export function openKeyManagerWindow(opts: KeyManagerWindowOptions = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 560,
    frame: false,
    show: false,
    title: 'KhyOS 密钥与端点管理',
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
  const useDev = Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.NODE_ENV === 'development'
  if (useDev) {
    win.loadURL(`${devServerUrl}#/key-manager`)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
    // packaged build: force the manager hash once the renderer is up
    win.webContents.once('did-stop-loading', () => {
      win.webContents.executeJavaScript(`location.hash = 'key-manager'`).catch(() => {})
    })
  }

  win.once('ready-to-show', () => win.show())

  if (opts.standalone) {
    // standalone entry: single-window app; closing the manager quits
    win.on('closed', () => {
      if (BrowserWindow.getAllWindows().length === 0) app.quit()
    })
  }
  return win
}
