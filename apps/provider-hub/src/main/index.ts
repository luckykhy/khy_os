// main 入口 — Electron 窗口 + IPC 注册（DESIGN-ARCH-094 §5 M2）。

import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { registerHubIpc } from './ipc.ts'
import { setupTray } from './tray.ts'

const DEV_RENDERER = process.env.KHYPHUB_DEV_RENDERER === '1'

function preloadPath(): string {
  // electron-vite（type:module）产出 dist/preload/index.mjs；开发态可能是 .js
  const base = path.join(__dirname, '../preload/index')
  if (existsSync(`${base}.mjs`)) return `${base}.mjs`
  return `${base}.js`
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    title: 'KhyOS Provider Hub',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (DEV_RENDERER) {
    // dev: 直接渲染源码（无构建）
    win.loadFile(path.join(__dirname, '../../src/renderer/index.html'))
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  registerHubIpc(ipcMain)
  const win = createWindow()
  setupTray().catch(() => {})
  // 冒烟模式（CI/自动化）：窗口加载成功即退出，15s 未加载判失败
  if (process.env.KHYPHUB_SMOKE === '1') {
    const failTimer = setTimeout(() => {
      console.error('SMOKE FAIL: 窗口 15s 内未完成加载')
      app.exit(1)
    }, 15_000)
    win.webContents.on('did-finish-load', () => {
      console.log('SMOKE OK: 窗口加载完成（preload + renderer + IPC 注册成功）')
      clearTimeout(failTimer)
      setTimeout(() => app.exit(0), 500)
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
