// preload — contextBridge 白名单（DESIGN-ARCH-094 §5 M2）。
// 渲染进程只能看到 window.khyHub；脱敏不变式：除 keys.reveal 外无任何明文
// key 出口（由各通道 handler 保证，契约 C3）。

import { contextBridge, ipcRenderer } from 'electron'

const hub = {
  cards: {
    list: () => ipcRenderer.invoke('cards:list'),
    add: (input: Record<string, unknown>) => ipcRenderer.invoke('cards:add', input),
    update: (cardId: string, patch: Record<string, unknown>) => ipcRenderer.invoke('cards:update', cardId, patch),
    duplicate: (cardId: string) => ipcRenderer.invoke('cards:duplicate', cardId),
    remove: (cardId: string) => ipcRenderer.invoke('cards:remove', cardId),
    reorder: (cardId: string, toIndex: number) => ipcRenderer.invoke('cards:reorder', cardId, toIndex),
    setActive: (app: string, cardId: string) => ipcRenderer.invoke('cards:set-active', app, cardId),
    clearActive: (app: string) => ipcRenderer.invoke('cards:clear-active', app),
    setFailover: (app: string, cardIds: string[]) => ipcRenderer.invoke('cards:failover-set', app, cardIds),
    rotateFailover: (app: string) => ipcRenderer.invoke('cards:failover-rotate', app)
  },
  keys: {
    list: () => ipcRenderer.invoke('keys:list'),
    add: (input: Record<string, unknown>) => ipcRenderer.invoke('keys:add', input),
    reveal: (provider: string, keyId: string) => ipcRenderer.invoke('keys:reveal', provider, keyId)
  },
  models: {
    fetch: (cardId: string) => ipcRenderer.invoke('models:fetch', { cardId }),
    apply: (cardId: string, models: string[], defaultModel?: string) =>
      ipcRenderer.invoke('models:apply', { cardId, models, defaultModel })
  },
  tools: {
    matrix: () => ipcRenderer.invoke('tools:matrix'),
    detect: (apps?: string[]) => ipcRenderer.invoke('tools:detect', apps),
    importCard: (app: string, provider: Record<string, unknown>) => ipcRenderer.invoke('tools:import', { app, provider }),
    apply: (app: string, cardId: string) => ipcRenderer.invoke('tools:apply', { app, cardId })
  },
  proxy: {
    status: () => ipcRenderer.invoke('proxy:status'),
    start: () => ipcRenderer.invoke('proxy:start')
  },
  health: {
    probe: (cardId: string) => ipcRenderer.invoke('health:probe', { cardId })
  },
  usage: {
    summary: (days?: number) => ipcRenderer.invoke('usage:summary', days)
  }
}

contextBridge.exposeInMainWorld('khyHub', hub)

export type KhyHub = typeof hub
