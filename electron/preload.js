const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  auth: {
    login: (credentials) => ipcRenderer.invoke('auth:login', credentials),
    logout: () => ipcRenderer.invoke('auth:logout'),
    state: () => ipcRenderer.invoke('auth:state'),
    refresh: () => ipcRenderer.invoke('auth:refresh'),
    oauthLogin: (providerId) => ipcRenderer.invoke('auth:oauthLogin', providerId),
    apiKeyLogin: (data) => ipcRenderer.invoke('auth:apiKeyLogin', data),
    getProviders: () => ipcRenderer.invoke('auth:getProviders'),
    skipLogin: () => ipcRenderer.invoke('auth:skipLogin'),
  },
  sessions: {
    list: (limit) => ipcRenderer.invoke('sessions:list', limit),
    create: (data) => ipcRenderer.invoke('sessions:create', data),
    get: (id) => ipcRenderer.invoke('sessions:get', id),
    update: (id, data) => ipcRenderer.invoke('sessions:update', id, data),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id),
    fork: (id, index) => ipcRenderer.invoke('sessions:fork', id, index),
  },
  messages: {
    send: (data) => ipcRenderer.invoke('messages:send', data),
    feedback: (data) => ipcRenderer.invoke('messages:feedback', data),
    regenerate: (id) => ipcRenderer.invoke('messages:regenerate', id),
  },
  files: {
    read: (path) => ipcRenderer.invoke('files:read', path),
    write: (path, data) => ipcRenderer.invoke('files:write', path, data),
    list: (path) => ipcRenderer.invoke('files:list', path),
    tree: (path) => ipcRenderer.invoke('files:tree', path),
  },
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal:create', options),
    write: (id, data) => ipcRenderer.invoke('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onData: (callback) => {
      const handler = (_, id, data) => callback(id, data);
      ipcRenderer.on('terminal:data', handler);
      return () => ipcRenderer.removeListener('terminal:data', handler);
    },
    onExit: (callback) => {
      const handler = (_, id, code) => callback(id, code);
      ipcRenderer.on('terminal:exit', handler);
      return () => ipcRenderer.removeListener('terminal:exit', handler);
    },
  },
  services: {
    status: () => ipcRenderer.invoke('services:status'),
    startBackend: () => ipcRenderer.invoke('services:startBackend'),
    stopBackend: () => ipcRenderer.invoke('services:stopBackend'),
  },
  ai: {
    generate: (data) => ipcRenderer.invoke('ai:generate', data),
    stream: (data, onChunk) => {
      const id = Date.now().toString();
      ipcRenderer.invoke('ai:stream', data, id);
      const handler = (_, chunk) => onChunk(chunk);
      ipcRenderer.on(`ai:chunk:${id}`, handler);
      return () => ipcRenderer.removeListener(`ai:chunk:${id}`, handler);
    },
  },
  sync: {
    connect: (url) => ipcRenderer.invoke('sync:connect', url),
    disconnect: () => ipcRenderer.invoke('sync:disconnect'),
    state: () => ipcRenderer.invoke('sync:state'),
    onMessage: (callback) => {
      const handler = (_, msg) => callback(msg);
      ipcRenderer.on('sync:message', handler);
      return () => ipcRenderer.removeListener('sync:message', handler);
    },
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeHTML: (html) => ipcRenderer.invoke('clipboard:writeHTML', html),
  },
});
