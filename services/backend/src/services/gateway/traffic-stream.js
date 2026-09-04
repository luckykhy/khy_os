'use strict';

/**
 * trafficStream.js — 流量实时 WebSocket 推送服务。
 *
 * 将 traffic-logger 的 'traffic' 事件桥接到 WebSocket，
 * 让前端 TrafficMonitor 面板能实时显示 AI 调用流量。
 *
 * 设计原则：
 *   - 订阅 traffic-logger 事件，零轮询
 *   - 支持多客户端广播
 *   - 自动心跳检测，断连清理
 *   - 门控 KHY_TRAFFIC_WS 默认开
 *
 * @module gateway/traffic-stream
 */

const { WebSocketServer } = require('ws');
const url = require('url');

// ── 配置常量 ────────────────────────────────────────────────────
const WS_PATH = '/ws/traffic';
const HEARTBEAT_INTERVAL = 30_000; // 30s 心跳
const MAX_CLIENTS = 50; // 最大并发客户端数

// ════════════════════════════════════════════════════════════════
// TrafficStream 类
// ════════════════════════════════════════════════════════════════
class TrafficStream {
  /**
   * @param {object} [opts]
   * @param {object} opts.trafficLogger — traffic-logger 单例
   * @param {number} [opts.port] — WebSocket 端口（默认复用 HTTP 服务器）
   * @param {boolean} [opts.enabled=true] — 门控
   */
  constructor(opts = {}) {
    if (!opts.trafficLogger) {
      throw new Error('trafficLogger is required');
    }
    this._logger = opts.trafficLogger;
    this._enabled = opts.enabled !== false;
    this._wss = null;
    this._clients = new Set();
    this._heartbeatTimer = null;
    this._loggerBound = this._handleTraffic.bind(this);
  }

  // ── 启动 WebSocket 服务 ───────────────────────────────────────
  /**
   * 附加到现有 HTTP 服务器（推荐）。
   * @param {http.Server} server — Node.js HTTP 服务器
   */
  attachToServer(server) {
    if (!this._enabled) {
      return;
    }
    if (this._wss) {
      return; // 已启动
    }

    this._wss = new WebSocketServer({
      server,
      path: WS_PATH,
      maxPayload: 1024 * 1024, // 1MB
    });

    this._wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this._wss.on('error', (err) => {
      // 不抛出，仅记录
      try {
        const { logger } = require('../../utils/logger');
        logger?.warn?.(`[traffic-ws] server error: ${err.message}`);
      } catch {
        /* fail-soft */
      }
    });

    // 订阅流量事件
    this._logger.on('traffic', this._loggerBound);

    // 启动心跳
    this._startHeartbeat();
  }

  // ── 独立端口模式（无 HTTP 服务器时）──────────────────────────
  /**
   * 在独立端口启动 WebSocket 服务器。
   * @param {number} port — 监听端口
   * @returns {Promise<http.Server>}
   */
  startStandalone(port) {
    if (!this._enabled) {
      return Promise.resolve(null);
    }
    const http = require('http');
    const server = http.createServer();
    this.attachToServer(server);
    return new Promise((resolve, reject) => {
      server.listen(port, () => resolve(server));
      server.on('error', reject);
    });
  }

  // ── 停止服务 ──────────────────────────────────────────────────
  stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._logger) {
      this._logger.removeListener('traffic', this._loggerBound);
    }
    for (const ws of this._clients) {
      try {
        ws.terminate();
      } catch {
        /* best effort */
      }
    }
    this._clients.clear();
    if (this._wss) {
      this._wss.close();
      this._wss = null;
    }
  }

  // ── 广播消息 ──────────────────────────────────────────────────
  broadcast(type, payload) {
    if (!this._enabled || this._clients.size === 0) {
      return;
    }
    const message = JSON.stringify({ type, payload, ts: Date.now() });
    for (const ws of this._clients) {
      if (ws.readyState === 1) {
        // WebSocket.OPEN
        try {
          ws.send(message);
        } catch {
          /* ignore per-client error */
        }
      }
    }
  }

  // ── 获取连接数 ────────────────────────────────────────────────
  getClientCount() {
    return this._clients.size;
  }

  // ── 内部：新连接处理 ──────────────────────────────────────────
  _onConnection(ws, req) {
    if (this._clients.size >= MAX_CLIENTS) {
      ws.close(1013, 'too many clients'); // Try Again Later
      return;
    }

    this._clients.add(ws);

    // 发送初始快照：最近 50 条记录 + 统计
    const snapshot = {
      entries: this._logger.query({ limit: 50 }),
      stats: this._logger.getStats(),
    };
    this._send(ws, 'snapshot', snapshot);

    // 处理客户端消息（过滤、订阅等）
    ws.on('message', (data) => this._onClientMessage(ws, data));
    ws.on('close', () => this._clients.delete(ws));
    ws.on('error', () => this._clients.delete(ws));

    // 心跳
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  }

  // ── 内部：客户端消息处理 ──────────────────────────────────────
  _onClientMessage(ws, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // 忽略非法消息
    }

    switch (msg.type) {
      case 'query': {
        // 客户端请求过滤查询
        const results = this._logger.query(msg.filters || {});
        this._send(ws, 'queryResult', { id: msg.id, entries: results });
        break;
      }
      case 'getStats': {
        this._send(ws, 'stats', this._logger.getStats());
        break;
      }
      case 'clear': {
        this._logger.clear();
        this._send(ws, 'cleared', {});
        break;
      }
      case 'setEnabled': {
        this._logger.setEnabled(!!msg.enabled);
        this._send(ws, 'enabled', { enabled: this._logger.isEnabled() });
        break;
      }
      case 'exportHAR': {
        const har = this._logger.exportHAR();
        this._send(ws, 'har', har);
        break;
      }
      default:
        break;
    }
  }

  // ── 内部：流量事件处理 ────────────────────────────────────────
  _handleTraffic(entry) {
    this.broadcast('traffic', entry);
  }

  // ── 内部：发送消息 ────────────────────────────────────────────
  _send(ws, type, payload) {
    if (ws.readyState !== 1) {
      return;
    }
    try {
      ws.send(JSON.stringify({ type, payload, ts: Date.now() }));
    } catch {
      /* ignore */
    }
  }

  // ── 内部：心跳 ────────────────────────────────────────────────
  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      for (const ws of this._clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          this._clients.delete(ws);
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_INTERVAL);
  }
}

// ── 单例引用（由 gateway 启动时注入）──────────────────────────
let _instance = null;

function getTrafficStream(opts) {
  if (!_instance) {
    _instance = new TrafficStream(opts);
  }
  return _instance;
}

module.exports = {
  TrafficStream,
  getTrafficStream,
  WS_PATH,
  MAX_CLIENTS,
};
