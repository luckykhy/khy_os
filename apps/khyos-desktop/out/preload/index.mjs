import { contextBridge, ipcRenderer } from "electron";
const api = {
  // 窗口控制
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window:maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  // 设置读写
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSetting: (key, value) => ipcRenderer.invoke("settings:set", key, value),
  // 主题
  getTheme: () => ipcRenderer.invoke("theme:get"),
  setTheme: (mode) => ipcRenderer.invoke("theme:set", mode),
  // 文件系统
  openDirectoryPicker: () => ipcRenderer.invoke("fs:openDirectory"),
  readFile: (path) => ipcRenderer.invoke("fs:readFile", path),
  writeFile: (path, content) => ipcRenderer.invoke("fs:writeFile", path, content),
  // AI 网关
  aiSend: (payload) => ipcRenderer.invoke("ai:send", payload),
  aiStream: (payload) => ipcRenderer.invoke("ai:stream", payload),
  // 会话
  createSession: (workspacePath) => ipcRenderer.invoke("session:create", workspacePath),
  listSessions: () => ipcRenderer.invoke("session:list"),
  // 平台信息
  getPlatform: () => process.platform,
  // 版本
  getVersion: () => ipcRenderer.invoke("app:version")
};
contextBridge.exposeInMainWorld("__KHYOS__", api);
