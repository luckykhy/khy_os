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

  // ── 密钥与端点管理 (DESIGN-ARCH-091 §6, P1) ──
  // keys
  keysList: () => ipcRenderer.invoke('keys:list'),
  keysAdd: (input: Record<string, unknown>) => ipcRenderer.invoke('keys:add', input),
  keysUpdate: (provider: string, keyId: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke('keys:update', provider, keyId, patch),
  keysRemove: (provider: string, keyId: string) => ipcRenderer.invoke('keys:remove', provider, keyId),
  keysToggle: (provider: string, keyId: string, enabled: boolean) =>
    ipcRenderer.invoke('keys:toggle', provider, keyId, enabled),
  keysReveal: (provider: string, keyId: string) => ipcRenderer.invoke('keys:reveal', provider, keyId),
  keysImport: () => ipcRenderer.invoke('keys:import'),
  // providers (custom metadata)
  providersList: () => ipcRenderer.invoke('providers:list'),
  providersAdd: (p: Record<string, unknown>) => ipcRenderer.invoke('providers:add', p),
  providersRemove: (id: string) => ipcRenderer.invoke('providers:remove', id),
  // endpoints / models
  endpointsPresets: () => ipcRenderer.invoke('endpoints:presets'),
  endpointsValidate: (input: { endpoint: string; protocol?: string; key?: string }) =>
    ipcRenderer.invoke('endpoints:validate', input),
  modelsFetch: (input: { endpoint: string; protocol?: string; key?: string }) =>
    ipcRenderer.invoke('models:fetch', input),
  // cards (credential-free)
  cardsList: () => ipcRenderer.invoke('cards:list'),
  cardsAdd: (input: Record<string, unknown>) => ipcRenderer.invoke('cards:add', input),
  cardsUpdate: (cardId: string, patch: Record<string, unknown>) =>
    ipcRenderer.invoke('cards:update', cardId, patch),
  cardsRemove: (cardId: string) => ipcRenderer.invoke('cards:remove', cardId),
  // agents (Mode B 一键激活)
  agentsMatrix: () => ipcRenderer.invoke('agents:matrix'),
  agentsApply: (input: { app: string; cardId: string; mode: 'proxy' | 'direct' }) =>
    ipcRenderer.invoke('agents:apply', input),
  agentsRevert: (app: string) => ipcRenderer.invoke('agents:revert', app),
  // proxy
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxyStart: () => ipcRenderer.invoke('proxy:start'),
  // health / audit
  healthProbe: (input?: { keyId?: string }) => ipcRenderer.invoke('health:probe', input || {}),
  healthAuditList: (limit?: number) => ipcRenderer.invoke('health:audit-list', limit),
  healthAuditExport: (dest: string) => ipcRenderer.invoke('health:audit-export', dest)
}

contextBridge.exposeInMainWorld('__KHYOS__', api)

