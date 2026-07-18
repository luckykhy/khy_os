/* khy-bridge.js — the host single source of truth for the Agent ⇄ OS channel.
 *
 * KhyBridge connects to the kernel's COM2 chardev (a unix socket when QEMU is
 * run with `-serial unix:...`, or any Node duplex stream for a real device) and
 * exposes all three planes as a clean JSON API:
 *
 *   control plane (agent -> OS)   async methods: stat / list / read / write /
 *                                 mkdir / remove / ps. Each sends a REQUEST and
 *                                 resolves with the parsed RESPONSE, correlated
 *                                 by seq, with a timeout so a wedged link never
 *                                 hangs a caller.
 *   decision plane (OS -> agent)  the kernel asks; set a handler with
 *                                 onDecision(fn). fn(question, code) returns the
 *                                 decision string; the bridge replies
 *                                 DECISION_RESP with the matching seq. If no
 *                                 handler is set, a default is sent so the
 *                                 kernel's caller still unblocks promptly.
 *   event plane (OS -> agent)     fire-and-forget; subscribe with
 *                                 on('event', fn) — spawn / exit / fault.
 *
 * Loose coupling: the bridge is a plain Node process with no kernel dependency.
 * It can be started before or after the kernel, run standalone, and survive the
 * channel going idle. Reads are resynchronizing (FrameSplitter); a corrupt or
 * partial stream is dropped, never fatal.
 *
 * The built-in KHY Node agent calls these methods in-process; an external agent
 * (Claude Code) reaches them through a thin MCP/SDK wrapper — both share this
 * one implementation, satisfying requirement 1 (both agents connect) without
 * duplicating protocol logic.
 */
'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { TYPE, encodeFrame, decodeFrame, FrameSplitter } = require('./khy-frame');
const P = require('./khy-protocol');

class KhyStatusError extends Error {
  constructor(status, verb) {
    super(`${verb} failed: ${P.STATUS_NAME[status] || status}`);
    this.name = 'KhyStatusError';
    this.status = status;
    this.statusName = P.STATUS_NAME[status] || String(status);
    this.verb = verb;
  }
}

class KhyBridge extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.socketPath]   unix socket path of COM2 (QEMU)
   * @param {stream.Duplex} [opts.stream] an already-open duplex (real device)
   * @param {number} [opts.requestTimeoutMs=5000] per-request response timeout
   * @param {string} [opts.defaultDecision='ALLOW'] reply when no handler is set
   */
  constructor(opts = {}) {
    super();
    this.socketPath = opts.socketPath || null;
    this.stream = opts.stream || null;
    this.requestTimeoutMs = opts.requestTimeoutMs || 5000;
    this.defaultDecision = opts.defaultDecision || 'ALLOW';

    this._seq = 0;                  // bridge REQUEST seq space (kernel keeps its
                                    // own high-based spaces for event/decision)
    this._pending = new Map();      // seq -> { resolve, reject, timer, verb }
    this._decisionHandler = null;
    this._splitter = new FrameSplitter((wire) => this._onWire(wire));
    this._closed = false;
  }

  /* Connect (when constructed with socketPath). Resolves once the socket is up.
   * No-op for a pre-supplied stream (already open). */
  connect() {
    if (this.stream) {
      this._attach(this.stream);
      return Promise.resolve(this);
    }
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      sock.once('error', reject);
      sock.once('connect', () => {
        sock.removeListener('error', reject);
        this._attach(sock);
        resolve(this);
      });
    });
  }

  _attach(stream) {
    this.stream = stream;
    stream.on('data', (chunk) => this._splitter.push(chunk));
    stream.on('error', (err) => this.emit('error', err));
    stream.on('close', () => { if (!this._closed) this.emit('close'); });
  }

  /* Register the decision-plane handler. fn(question, code) may be sync or async
   * and returns the decision (string or Buffer). */
  onDecision(fn) {
    this._decisionHandler = fn;
    return this;
  }

  // ── Inbound frame dispatch ────────────────────────────────────────────────

  _onWire(wire) {
    let frame;
    try {
      frame = decodeFrame(wire);
    } catch (_e) {
      return; // corrupt frame: drop, stay synchronized (kernel discipline)
    }
    switch (frame.type) {
      case TYPE.RESPONSE:
        this._resolveResponse(frame);
        break;
      case TYPE.EVENT:
        this.emit('event', P.parseEvent(frame.code, frame.payload));
        break;
      case TYPE.DECISION_REQ:
        this._handleDecision(frame);
        break;
      default:
        break; // REQUEST / DECISION_RESP are inbound-from-OS never; ignore
    }
  }

  _resolveResponse(frame) {
    const waiter = this._pending.get(frame.seq);
    if (!waiter) return; // late/duplicate response to a timed-out request
    this._pending.delete(frame.seq);
    clearTimeout(waiter.timer);
    waiter.resolve(frame.payload);
  }

  _handleDecision(frame) {
    const question = frame.payload.toString('utf8');
    this.emit('decision', { seq: frame.seq, code: frame.code, question });
    const reply = (decision) => {
      const payload = Buffer.isBuffer(decision) ? decision
        : Buffer.from(String(decision), 'utf8');
      this._send(TYPE.DECISION_RESP, frame.seq, frame.code, payload);
    };
    if (!this._decisionHandler) {
      reply(this.defaultDecision);
      return;
    }
    Promise.resolve()
      .then(() => this._decisionHandler(question, frame.code))
      .then((decision) => reply(decision == null ? this.defaultDecision : decision))
      .catch(() => reply(this.defaultDecision)); // a throwing handler still unblocks the kernel
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  _send(type, seq, code, payload) {
    if (this._closed || !this.stream) return;
    this.stream.write(encodeFrame({ type, seq, code, payload }));
  }

  /* Send a control-plane REQUEST and await its RESPONSE payload (raw bytes). */
  _request(code, payload, verb) {
    const seq = (this._seq = (this._seq + 1) >>> 0) || (this._seq = 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(seq);
        reject(new Error(`${verb || 'request'} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this._pending.set(seq, { resolve, reject, timer, verb });
      this._send(TYPE.REQUEST, seq, code, payload);
    });
  }

  /* Run a verb, split the status, and either return the OK body or throw. */
  async _verb(code, payload, verbName, { okStatuses = [P.STATUS.OK] } = {}) {
    const raw = await this._request(code, payload, verbName);
    const { status, body } = P.splitStatus(raw);
    if (!okStatuses.includes(status)) throw new KhyStatusError(status, verbName);
    return { status, body };
  }

  // ── Control-plane JSON API ────────────────────────────────────────────────

  async stat(path) {
    const { body } = await this._verb(P.VERB.STAT, P.statReq(path), 'stat');
    return P.parseStat(body);
  }

  /* List a directory, transparently paging until the last (short) page. */
  async list(path) {
    const out = [];
    let start = 0;
    for (;;) {
      const { body } = await this._verb(P.VERB.LIST, P.listReq(start, path), 'list');
      const page = P.parseListPage(body);
      if (page.length === 0) break;
      out.push(...page);
      start += page.length;
      if (page.length < P.PAGE_FULL) break;
    }
    return out;
  }

  /* Read a whole file, paging by offset until a zero-length read. */
  async read(path, { chunk = 4096, maxBytes = 1 << 24 } = {}) {
    const parts = [];
    let offset = 0;
    let total = 0;
    while (total < maxBytes) {
      const { body } = await this._verb(P.VERB.READ, P.readReq(offset, chunk, path), 'read');
      const { nread, bytes } = P.parseReadPage(body);
      if (nread === 0) break;
      parts.push(Buffer.from(bytes));
      offset += nread;
      total += nread;
    }
    return Buffer.concat(parts);
  }

  async write(path, data, { append = false } = {}) {
    const mode = append ? P.WRITE.APPEND : P.WRITE.OVERWRITE;
    const { body } = await this._verb(P.VERB.WRITE, P.writeReq(mode, path, data), 'write');
    return P.parseWritten(body);
  }

  async mkdir(path) {
    await this._verb(P.VERB.MKDIR, P.pathReq(path), 'mkdir');
    return true;
  }

  async remove(path) {
    await this._verb(P.VERB.REMOVE, P.pathReq(path), 'remove');
    return true;
  }

  /* Process table, paged like list(). */
  async ps() {
    const out = [];
    let start = 0;
    for (;;) {
      const { body } = await this._verb(P.VERB.PS, P.psReq(start), 'ps');
      const page = P.parsePsPage(body);
      if (page.length === 0) break;
      out.push(...page);
      start += page.length;
      if (page.length < P.PAGE_FULL) break;
    }
    return out;
  }

  /* Low-level escape hatch: run a verb and return { status, statusName, body }
   * WITHOUT throwing on error statuses — used to assert negative cases. */
  async rawVerb(code, payload) {
    const raw = await this._request(code, payload, 'rawVerb');
    return P.splitStatus(raw);
  }

  /* Read the OS-owned agent config (/disk/etc/agent.conf) over the control plane
   * and parse its `key=value` lines into a plain object. This is requirement 4's
   * "the bridge reads it to decide which agent/model": after the user configures
   * the model in-system (`ai use model ...`), the kernel persists it here and the
   * bridge picks it up from this one call. A missing file (the system has not
   * been configured yet, or /disk is not mounted) yields {} rather than throwing,
   * so an unconfigured system still connects. */
  async readConfig(path = '/disk/etc/agent.conf') {
    let raw;
    try {
      raw = await this.read(path);
    } catch (e) {
      if (e instanceof KhyStatusError && e.statusName === 'ENOENT') return {};
      throw e;
    }
    const cfg = {};
    for (const line of raw.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      cfg[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return cfg;
  }

  close() {
    this._closed = true;
    for (const [, w] of this._pending) {
      clearTimeout(w.timer);
      w.reject(new Error('bridge closed'));
    }
    this._pending.clear();
    if (this.stream) this.stream.destroy();
  }
}

module.exports = { KhyBridge, KhyStatusError };
