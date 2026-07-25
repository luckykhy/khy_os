'use strict';

/**
 * IPC Protocol — structured message envelope for parent↔child agent communication.
 *
 * All messages between a parent process and a forked agent child use this protocol.
 * Messages are JSON objects sent over Node.js IPC (child_process.fork() channel).
 *
 * Direction legend:
 *   P→C = parent-to-child    C→P = child-to-parent    BI = bidirectional
 */
const crypto = require('crypto');

// ── Message types ───────────────────────────────────────────────────────

/** @enum {string} */
const MSG = Object.freeze({
  // Parent → Child
  INIT:       'init',        // serialized AgentContext + config
  TASK:       'task',        // task prompt to execute
  FOLLOW_UP:  'follow_up',   // follow-up message for running agent
  KILL:       'kill',        // graceful shutdown request

  // Child → Parent
  READY:      'ready',       // child bootstrapped, ready for TASK
  PROGRESS:   'progress',    // partial result / streaming chunk
  TOOL_CALL:  'tool_call',   // requesting parent-side tool execution
  RESULT:     'result',      // final result
  ERROR:      'error',       // fatal error
  METRICS:    'metrics',     // resource usage report

  // Bidirectional
  HEARTBEAT:  'heartbeat',   // keep-alive ping/pong

  // Mailbox protocol
  ACK:          'ack',           // C→P: acknowledge received message (payload.seq)
  QUEUE_STATUS: 'queue_status',  // P→C: current queue depth (backpressure signal)
});

// ── Envelope ────────────────────────────────────────────────────────────

/**
 * Create a protocol message envelope.
 *
 * @param {string} type - One of MSG.* constants
 * @param {string} agentId - Agent identifier
 * @param {object} [payload={}] - Type-specific data
 * @param {string} [requestId] - For request-response correlation (auto-generated if omitted)
 * @returns {{ _ipc: true, type: string, requestId: string, agentId: string, timestamp: number, payload: object }}
 */
function createMessage(type, agentId, payload = {}, requestId) {
  if (!type || !Object.values(MSG).includes(type)) {
    throw new Error(`Invalid IPC message type: ${type}`);
  }
  if (!agentId) {
    throw new Error('agentId is required');
  }
  return {
    _ipc: true,                 // marker to distinguish from other IPC traffic
    type,
    requestId: requestId || crypto.randomBytes(6).toString('hex'),
    agentId: String(agentId),
    timestamp: Date.now(),
    payload: payload || {},
  };
}

/**
 * Parse and validate a received IPC message.
 *
 * @param {*} raw - Raw object received from IPC channel
 * @returns {{ valid: true, msg: object } | { valid: false, reason: string }}
 */
function parseMessage(raw) {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, reason: 'Not an object' };
  }
  if (!raw._ipc) {
    return { valid: false, reason: 'Missing _ipc marker' };
  }
  if (!raw.type || !Object.values(MSG).includes(raw.type)) {
    return { valid: false, reason: `Unknown type: ${raw.type}` };
  }
  if (!raw.agentId) {
    return { valid: false, reason: 'Missing agentId' };
  }
  return { valid: true, msg: raw };
}

// ── Request-Response helper ─────────────────────────────────────────────

/**
 * Create a promise-based request-response wrapper over an IPC channel.
 *
 * @param {ChildProcess|process} channel - Node.js IPC channel (has `.send()` and `on('message')`)
 * @param {string} agentId - Agent ID for message construction
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000] - Default timeout per request
 * @returns {{ request: Function, notify: Function, destroy: Function }}
 */
function createRequestResponse(channel, agentId, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30_000;
  const pending = new Map(); // requestId → { resolve, reject, timer }
  let destroyed = false;

  function onMessage(raw) {
    const parsed = parseMessage(raw);
    if (!parsed.valid) return;
    const { msg } = parsed;

    const entry = pending.get(msg.requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(msg.requestId);
      if (msg.type === MSG.ERROR) {
        entry.reject(new Error(msg.payload.message || 'Agent error'));
      } else {
        entry.resolve(msg);
      }
    }
  }

  channel.on('message', onMessage);

  return {
    /**
     * Send a request and wait for a correlated response.
     * @param {string} type - Message type to send
     * @param {object} [payload] - Payload
     * @param {number} [customTimeout] - Override timeout for this request
     * @returns {Promise<object>} Resolved response message
     */
    request(type, payload = {}, customTimeout) {
      if (destroyed) return Promise.reject(new Error('RPC channel destroyed'));
      const msg = createMessage(type, agentId, payload);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(msg.requestId);
          reject(new Error(`IPC request timed out after ${customTimeout || timeoutMs}ms (type=${type})`));
        }, customTimeout || timeoutMs);
        timer.unref?.();
        pending.set(msg.requestId, { resolve, reject, timer });
        channel.send(msg);
      });
    },

    /**
     * Send a fire-and-forget notification (no response expected).
     * @param {string} type
     * @param {object} [payload]
     */
    notify(type, payload = {}) {
      if (destroyed) return;
      const msg = createMessage(type, agentId, payload);
      try { channel.send(msg); } catch { /* channel closed */ }
    },

    /**
     * Clean up listeners and reject pending requests.
     */
    destroy() {
      destroyed = true;
      channel.removeListener('message', onMessage);
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('RPC channel destroyed'));
      }
      pending.clear();
    },
  };
}

module.exports = {
  MSG,
  createMessage,
  parseMessage,
  createRequestResponse,
};
