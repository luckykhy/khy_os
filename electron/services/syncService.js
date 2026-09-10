const { WebSocket } = require('ws');

let ws = null;
const state = {
  connected: false,
  url: null,
  lastMessage: null,
  reconnectAttempts: 0,
};

function sendToRenderer(channel, msg) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, msg);
  }
}

const syncService = {
  async connect(url) {
    if (!url) {
      throw new Error('连接失败：缺少同步服务器地址');
    }
    if (ws) {
      ws.close();
      ws = null;
    }

    return new Promise((resolve, reject) => {
      const connectionTimeout = setTimeout(() => {
        if (!state.connected) {
          try { ws?.close(); } catch { /* ignore */ }
          ws = null;
          reject(new Error(`连接超时 (${url})：同步服务器无响应`));
        }
      }, 10000);

      try {
        ws = new WebSocket(url);

        ws.on('open', () => {
          clearTimeout(connectionTimeout);
          state.connected = true;
          state.url = url;
          state.reconnectAttempts = 0;
          resolve({ success: true, url });
        });

        ws.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString('utf-8'));
            state.lastMessage = msg;
            sendToRenderer('sync:message', msg);
          } catch {
            // Non-JSON message — forward as raw text.
            sendToRenderer('sync:message', { type: 'raw', data: raw.toString('utf-8') });
          }
        });

        ws.on('close', () => {
          state.connected = false;
          ws = null;
        });

        ws.on('error', (err) => {
          clearTimeout(connectionTimeout);
          state.connected = false;
          ws = null;
          reject(new Error(`同步连接错误：${err.message}`));
        });
      } catch (err) {
        clearTimeout(connectionTimeout);
        reject(new Error(`创建 WebSocket 失败：${err.message}`));
      }
    });
  },

  async disconnect() {
    if (!ws) {
      return { success: true, wasConnected: false };
    }
    try {
      ws.close();
    } catch {
      // Already closing.
    }
    ws = null;
    state.connected = false;
    state.url = null;
    return { success: true };
  },

  getState() {
    return {
      connected: state.connected,
      url: state.url,
      lastMessage: state.lastMessage,
    };
  },

  send(message) {
    if (!ws || !state.connected) {
      throw new Error('发送失败：未连接到同步服务器');
    }
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    ws.send(payload);
    return { success: true };
  },
};

module.exports = syncService;
