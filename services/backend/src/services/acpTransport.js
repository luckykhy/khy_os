'use strict';

/**
 * ACP Transport — Agent Communication Protocol transport layer.
 *
 * Supports three channel types:
 *   - ipc:  Node.js child_process IPC (default for process-isolated agents)
 *   - ws:   WebSocket (for daemon/remote communication)
 *   - http: HTTP JSON-RPC (for stateless request-response)
 *
 * All channels speak JSON-RPC 2.0 messages conforming to acp-message.schema.json.
 * Wire format is aligned with ipcProtocol.js so IPC channels can transparently
 * bridge ACP messages to forked child processes.
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const path = require('path');

// ── Load ACP schema for runtime validation ────────────────────────────
let _acpSchema = null;
function _getSchema() {
  if (!_acpSchema) {
    try {
      _acpSchema = require('../contracts/acp/acp-message.schema.json');
    } catch { _acpSchema = null; }
  }
  return _acpSchema;
}

// Map method → $defs key for param validation
const METHOD_PARAM_DEF = Object.freeze({
  'agent.spawn':       'AgentSpawnParams',
  'agent.kill':        'AgentKillParams',
  'agent.status':      'AgentStatusParams',
  'task.submit':       'TaskSubmitParams',
  'task.result':       'TaskResultParams',
  'task.progress':     'TaskProgressParams',
  'context.share':     'ContextShareParams',
  'tool.invoke':       'ToolInvokeParams',
  'tool.result':       'ToolResultParams',
  'message.send':      'MessageSendParams',
  'message.broadcast': 'MessageBroadcastParams',
});

// ── ACP Methods (mirrors schema enum) ──────────────────────────────────

const ACP_METHODS = Object.freeze({
  AGENT_SPAWN:        'agent.spawn',
  AGENT_KILL:         'agent.kill',
  AGENT_STATUS:       'agent.status',
  TASK_SUBMIT:        'task.submit',
  TASK_RESULT:        'task.result',
  TASK_PROGRESS:      'task.progress',
  CONTEXT_SHARE:      'context.share',
  TOOL_INVOKE:        'tool.invoke',
  TOOL_RESULT:        'tool.result',
  MESSAGE_SEND:       'message.send',
  MESSAGE_BROADCAST:  'message.broadcast',
  HEARTBEAT:          'heartbeat',
});

// ── Error codes (JSON-RPC 2.0 standard + ACP-specific) ────────────────

const ACP_ERRORS = Object.freeze({
  PARSE_ERROR:      -32700,
  INVALID_REQUEST:  -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS:   -32602,
  INTERNAL_ERROR:   -32603,
  AGENT_NOT_FOUND:  -40001,
  AGENT_BUSY:       -40002,
  TIMEOUT:          -40003,
  CHANNEL_CLOSED:   -40004,
});

// ── Message Builders ───────────────────────────────────────────────────

function createRequest(method, params, id) {
  return {
    jsonrpc: '2.0',
    id: id || crypto.randomBytes(6).toString('hex'),
    method,
    params: params || {},
  };
}

function createNotification(method, params) {
  return {
    jsonrpc: '2.0',
    method,
    params: params || {},
  };
}

function createResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function createErrorResponse(id, code, message, data) {
  const resp = { jsonrpc: '2.0', id, error: { code, message } };
  if (data !== undefined) resp.error.data = data;
  return resp;
}

/**
 * Validate an ACP message structure.
 * @param {object} msg
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return { valid: false, reason: 'Not an object' };
  if (msg.jsonrpc !== '2.0') return { valid: false, reason: 'Missing jsonrpc 2.0' };
  if (msg.method && !Object.values(ACP_METHODS).includes(msg.method)) {
    return { valid: false, reason: `Unknown method: ${msg.method}` };
  }
  // Response messages have result or error but no method
  if (!msg.method && msg.id === undefined) {
    return { valid: false, reason: 'Message has neither method nor id' };
  }
  // Schema-backed param validation (best-effort)
  if (msg.method && msg.params) {
    const schema = _getSchema();
    const defName = METHOD_PARAM_DEF[msg.method];
    if (schema && defName && schema.$defs?.[defName]) {
      const paramDef = schema.$defs[defName];
      const required = paramDef.required || [];
      for (const field of required) {
        if (msg.params[field] === undefined) {
          return { valid: false, reason: `Missing required param "${field}" for ${msg.method}` };
        }
      }
    }
  }
  return { valid: true };
}

// ── ACP Transport Class ────────────────────────────────────────────────

class ACPTransport extends EventEmitter {
  /**
   * @param {object} opts
   * @param {'ipc'|'ws'|'http'} opts.type - Channel type
   * @param {object} opts.channel - Underlying channel (ChildProcess, WebSocket, or {baseUrl})
   * @param {number} [opts.timeoutMs=30000]
   */
  constructor(opts) {
    super();
    this.type = opts.type || 'ipc';
    this.channel = opts.channel;
    this.timeoutMs = opts.timeoutMs || 30_000;
    this._pending = new Map();
    this._destroyed = false;
    this._handlers = new Map(); // method → handler fn

    if (this.type === 'ipc') {
      this._initIPC();
    } else if (this.type === 'ws') {
      this._initWS();
    }
    // HTTP is stateless — no persistent listener
  }

  /**
   * Send a request and wait for a correlated response.
   * @param {string} method - ACP method
   * @param {object} [params]
   * @param {number} [timeout]
   * @returns {Promise<*>} Result payload
   */
  request(method, params, timeout) {
    if (this._destroyed) return Promise.reject(new Error('Transport destroyed'));

    const msg = createRequest(method, params);
    return new Promise((resolve, reject) => {
      const ms = timeout || this.timeoutMs;
      const timer = setTimeout(() => {
        this._pending.delete(msg.id);
        reject(Object.assign(new Error(`ACP timeout: ${method}`), { code: ACP_ERRORS.TIMEOUT }));
      }, ms);
      timer.unref?.();
      this._pending.set(msg.id, { resolve, reject, timer });
      this._send(msg);
    });
  }

  /**
   * Send a fire-and-forget notification (no response expected).
   * @param {string} method
   * @param {object} [params]
   */
  notify(method, params) {
    if (this._destroyed) return;
    this._send(createNotification(method, params));
  }

  /**
   * Register a method handler for incoming requests.
   * @param {string} method
   * @param {(params: object) => Promise<*>} handler
   */
  handle(method, handler) {
    this._handlers.set(method, handler);
  }

  /**
   * Tear down the transport.
   */
  destroy() {
    this._destroyed = true;
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error('Transport destroyed'), { code: ACP_ERRORS.CHANNEL_CLOSED }));
    }
    this._pending.clear();
    this._handlers.clear();
    this.removeAllListeners();
  }

  // ── Internal: IPC ──

  _initIPC() {
    this._ipcHandler = (raw) => this._onRawMessage(raw);
    this.channel.on('message', this._ipcHandler);
  }

  // ── Internal: WebSocket ──

  _initWS() {
    this._wsHandler = (data) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        this._onRawMessage(msg);
      } catch { /* bad frame */ }
    };
    this.channel.on('message', this._wsHandler);
  }

  // ── Internal: shared message handling ──

  _onRawMessage(raw) {
    // Bridge from ipcProtocol format if needed
    if (raw && raw._ipc && !raw.jsonrpc) {
      raw = _ipcToAcp(raw);
    }

    const check = validateMessage(raw);
    if (!check.valid) return;

    // Response to a pending request
    if (raw.id !== undefined && !raw.method) {
      const entry = this._pending.get(raw.id);
      if (entry) {
        clearTimeout(entry.timer);
        this._pending.delete(raw.id);
        if (raw.error) {
          entry.reject(Object.assign(new Error(raw.error.message), { code: raw.error.code, data: raw.error.data }));
        } else {
          entry.resolve(raw.result);
        }
      }
      return;
    }

    // Incoming request or notification
    if (raw.method) {
      this.emit('message', raw);

      const handler = this._handlers.get(raw.method);
      if (handler && raw.id !== undefined) {
        // Request — must respond
        Promise.resolve()
          .then(() => handler(raw.params))
          .then((result) => this._send(createResponse(raw.id, result)))
          .catch((err) => this._send(createErrorResponse(raw.id, err.code || ACP_ERRORS.INTERNAL_ERROR, err.message)));
      }
    }
  }

  _send(msg) {
    try {
      if (this.type === 'ipc') {
        this.channel.send(msg);
      } else if (this.type === 'ws') {
        this.channel.send(JSON.stringify(msg));
      } else if (this.type === 'http') {
        // HTTP is fire-and-forget from transport perspective;
        // caller uses request() which handles the HTTP round-trip separately.
        this.emit('_httpSend', msg);
      }
    } catch { /* channel closed */ }
  }
}

// ── Bridge: ipcProtocol → ACP ──────────────────────────────────────────

const _IPC_TO_ACP_METHOD = {
  init:       ACP_METHODS.AGENT_SPAWN,
  task:       ACP_METHODS.TASK_SUBMIT,
  follow_up:  ACP_METHODS.TASK_SUBMIT,
  kill:       ACP_METHODS.AGENT_KILL,
  ready:      ACP_METHODS.AGENT_STATUS,
  progress:   ACP_METHODS.TASK_PROGRESS,
  tool_call:  ACP_METHODS.TOOL_INVOKE,
  result:     ACP_METHODS.TASK_RESULT,
  error:      ACP_METHODS.TASK_RESULT,
  metrics:    ACP_METHODS.TASK_RESULT,
  heartbeat:  ACP_METHODS.HEARTBEAT,
};

function _ipcToAcp(ipcMsg) {
  const method = _IPC_TO_ACP_METHOD[ipcMsg.type] || ACP_METHODS.HEARTBEAT;
  const msg = {
    jsonrpc: '2.0',
    method,
    params: {
      agentId: ipcMsg.agentId,
      ...(ipcMsg.payload || {}),
    },
  };
  if (ipcMsg.requestId) msg.id = ipcMsg.requestId;
  if (ipcMsg.type === 'error') {
    // Convert to error response
    return createErrorResponse(ipcMsg.requestId, ACP_ERRORS.INTERNAL_ERROR, ipcMsg.payload?.message || 'Agent error');
  }
  return msg;
}

module.exports = {
  ACP_METHODS,
  ACP_ERRORS,
  ACPTransport,
  createRequest,
  createNotification,
  createResponse,
  createErrorResponse,
  validateMessage,
};
