const http = require('http');
const { randomUUID } = require('crypto');

let server = null;
const connectedDevices = new Map();

function getServerUrl(port) {
  return `http://0.0.0.0:${port}`;
}

const connectionServer = {
  start(port = 0) {
    if (server) {
      return { success: true, port: server.address().port, alreadyRunning: true };
    }

    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.url === '/pair' && req.method === 'POST') {
          const bodyChunks = [];
          req.on('data', (chunk) => bodyChunks.push(chunk));
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(bodyChunks).toString('utf-8'));
              const deviceId = randomUUID();
              connectedDevices.set(deviceId, {
                id: deviceId,
                name: body.deviceName || '未知设备',
                platform: body.platform || 'unknown',
                pairedAt: Date.now(),
              });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ deviceId, status: 'paired' }));
            } catch {
              res.writeHead(400);
              res.end(JSON.stringify({ error: '无效的请求数据' }));
            }
          });
          return;
        }

        if (req.url === '/devices' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ devices: Array.from(connectedDevices.values()) }));
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ error: '未找到' }));
      });

      server.listen(port, '0.0.0.0', () => {
        const actualPort = server.address().port;
        resolve({ success: true, port: actualPort, url: getServerUrl(actualPort) });
      });

      server.on('error', (err) => {
        server = null;
        reject(new Error(`启动连接服务器失败：${err.message}`));
      });
    });
  },

  stop() {
    if (!server) {
      return { success: true, wasRunning: false };
    }
    server.close();
    server = null;
    connectedDevices.clear();
    return { success: true };
  },

  getDevices() {
    return Array.from(connectedDevices.values());
  },

  disconnect(deviceId) {
    if (!connectedDevices.has(deviceId)) {
      throw new Error(`设备不存在：${deviceId}`);
    }
    connectedDevices.delete(deviceId);
    return { success: true, deviceId };
  },
};

module.exports = connectionServer;
