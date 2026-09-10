import { contextBridge, ipcRenderer } from 'electron'

// Phase 0b: 暴露首批 20 个高频 RPC 方法（stub 实现）

const api = {
  // 窗口控制
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),

  // 设置读写
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),

  // 主题
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (mode: string) => ipcRenderer.invoke('theme:set', mode),

  // 文件系统
  openDirectoryPicker: () => ipcRenderer.invoke('fs:openDirectory'),
  readFile: (path: string) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path: string, content: string) => ipcRenderer.invoke('fs:writeFile', path, content),

  // AI 网关
  aiSend: (payload: unknown) => ipcRenderer.invoke('ai:send', payload),
  aiStream: (payload: unknown) => ipcRenderer.invoke('ai:stream', payload),

  // 会话
  createSession: (workspacePath: string) => ipcRenderer.invoke('session:create', workspacePath),
  listSessions: () => ipcRenderer.invoke('session:list'),

  // 平台信息
  getPlatform: () => process.platform,

  // 版本
  getVersion: () => ipcRenderer.invoke('app:version'),
}

contextBridge.exposeInMainWorld('__KHYOS__', api)
