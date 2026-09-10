const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');

const authService = require('./services/authService');
const sessionService = require('./services/sessionService');
const messageService = require('./services/messageService');
const fileService = require('./services/fileService');
const terminalService = require('./services/terminalService');
const backendService = require('./services/backendService');
const aiGateway = require('./services/aiGatewayService');
const syncService = require('./services/syncService');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // In dev mode load from Vite dev server; in production load built files.
  if (process.env.ELECTRON_DEV === '1') {
    const devPort = process.env.AI_FRONTEND_PORT || 8090;
    mainWindow.loadURL(`http://localhost:${devPort}`);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function getMainWindow() {
  return mainWindow;
}

function registerIpcHandlers() {
  // ── Auth ──────────────────────────────────────────────
  ipcMain.handle('auth:login', (_, credentials) => authService.login(credentials));
  ipcMain.handle('auth:logout', () => authService.logout());
  ipcMain.handle('auth:state', () => authService.getState());
  ipcMain.handle('auth:refresh', () => authService.refreshToken());
  ipcMain.handle('auth:oauthLogin', (_, providerId) => authService.oauthLogin(providerId));
  ipcMain.handle('auth:apiKeyLogin', (_, data) => authService.apiKeyLogin(data));
  ipcMain.handle('auth:getProviders', () => authService.getProviders());
  ipcMain.handle('auth:skipLogin', () => authService.skipLogin());

  // ── Sessions ──────────────────────────────────────────
  ipcMain.handle('sessions:list', (_, limit) => sessionService.list(limit));
  ipcMain.handle('sessions:create', (_, data) => sessionService.create(data));
  ipcMain.handle('sessions:get', (_, id) => sessionService.get(id));
  ipcMain.handle('sessions:update', (_, id, data) => sessionService.update(id, data));
  ipcMain.handle('sessions:delete', (_, id) => sessionService.delete(id));
  ipcMain.handle('sessions:fork', (_, id, index) => sessionService.fork(id, index));

  // ── Messages ──────────────────────────────────────────
  ipcMain.handle('messages:send', (_, data) => messageService.send(data));
  ipcMain.handle('messages:feedback', (_, data) => messageService.feedback(data));
  ipcMain.handle('messages:regenerate', (_, id) => messageService.regenerate(id));

  // ── Files ─────────────────────────────────────────────
  ipcMain.handle('files:read', (_, filePath) => fileService.read(filePath));
  ipcMain.handle('files:write', (_, filePath, data) => fileService.write(filePath, data));
  ipcMain.handle('files:list', (_, filePath) => fileService.list(filePath));
  ipcMain.handle('files:tree', (_, filePath) => fileService.tree(filePath));

  // ── Terminal ──────────────────────────────────────────
  ipcMain.handle('terminal:create', (_, options) => terminalService.create(options));
  ipcMain.handle('terminal:write', (_, id, data) => terminalService.write(id, data));
  ipcMain.handle('terminal:resize', (_, id, cols, rows) => terminalService.resize(id, cols, rows));
  ipcMain.handle('terminal:kill', (_, id) => terminalService.kill(id));

  // ── Backend service ────────────────────────────────────
  ipcMain.handle('services:status', () => backendService.getStatus());
  ipcMain.handle('services:startBackend', () => backendService.start());
  ipcMain.handle('services:stopBackend', () => backendService.stop());

  // ── AI gateway ────────────────────────────────────────
  ipcMain.handle('ai:generate', (_, data) => aiGateway.generate(data));
  ipcMain.handle('ai:stream', (_, data, callbackId) => aiGateway.stream(data, callbackId, getMainWindow()));

  // ── Sync ──────────────────────────────────────────────
  ipcMain.handle('sync:connect', (_, url) => syncService.connect(url));
  ipcMain.handle('sync:disconnect', () => syncService.disconnect());
  ipcMain.handle('sync:state', () => syncService.getState());

  // ── Clipboard ─────────────────────────────────────────
  ipcMain.handle('clipboard:writeText', (_, text) => clipboard.writeText(text));
  ipcMain.handle('clipboard:readText', () => clipboard.readText());
  ipcMain.handle('clipboard:writeHTML', (_, html) => clipboard.writeHTML(html));
}

module.exports = { getMainWindow };
