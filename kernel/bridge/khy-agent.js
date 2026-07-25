/* khy-agent.js — the built-in KHY agent, running in-process over khy-bridge.
 *
 * This is the OS's default agent (requirement 1, side a): a plain Node object
 * that owns a KhyBridge, answers the kernel's decision plane, and exposes the
 * shared tool surface for in-process callers. It is the counterpart to the
 * external agent (Claude Code) that reaches the same OS through khy-mcp.js —
 * both go through one KhyBridge, so the OS behaves identically whichever agent
 * is attached.
 *
 * The "brain" — how a decision question becomes an answer — is injectable, so
 * the OS stays loosely coupled to any specific model (requirement 3). The
 * default brain is a dependency-free rule set: it needs no network and always
 * answers, so the kernel never blocks. A deployment that wants a real model
 * passes a brain that calls the project's AI gateway; it receives the question,
 * the intent code, and the live config (from /disk/etc/agent.conf, requirement
 * 4) so it can honor the model the user configured in-system.
 */
'use strict';

const { KhyBridge } = require('./khy-bridge');
const { makeTools } = require('./khy-tools');

const INTENT_GENERIC = 0x0000;   // parity with AGENT_INTENT_GENERIC (agentask.h)
const INTENT_NL = 0x0001;        // parity with AGENT_INTENT_NL

/* Default, dependency-free brain. Returns a string answer for any question.
 *   GENERIC -> a yes/no verdict: DENY anything that reads destructive, else ALLOW.
 *   NL      -> a structured action line the kernel executes (SET / GET / SAY). */
function defaultBrain(question, code /*, config */) {
  const q = String(question).toLowerCase();
  if (code === INTENT_GENERIC) {
    const destructive = /\b(shut\s*down|delete|destroy|format|wipe|erase|kill all)\b/.test(q);
    return destructive ? 'DENY' : 'ALLOW';
  }
  if (code === INTENT_NL) {
    let m;
    if ((m = q.match(/(?:use|set|switch to)\s+model\s+(\S+)/))) return `SET model ${m[1]}`;
    if ((m = q.match(/(?:use|set)\s+endpoint\s+(\S+)/))) return `SET endpoint ${m[1]}`;
    if (/(what|which|current).*\bmodel\b/.test(q)) return 'GET model';
    if (/(what|which|current).*\bendpoint\b/.test(q)) return 'GET endpoint';
    return 'SAY hello from the built-in KHY agent — ask me to set or show config, or anything else';
  }
  return 'ALLOW';
}

class KhyAgent {
  /**
   * @param {object} opts
   * @param {string} [opts.socketPath] COM2 unix socket (QEMU) to attach to
   * @param {import('stream').Duplex} [opts.stream] an already-open device stream
   * @param {(question:string, code:number, config:object) => (string|Promise<string>)} [opts.brain]
   *        decision answerer; defaults to defaultBrain
   * @param {(event:object) => void} [opts.onEvent] optional event-plane subscriber
   */
  constructor(opts = {}) {
    this.bridge = new KhyBridge({
      socketPath: opts.socketPath,
      stream: opts.stream,
      requestTimeoutMs: opts.requestTimeoutMs,
    });
    this.brain = opts.brain || defaultBrain;
    this.config = {};                 // last-read /disk/etc/agent.conf
    this.tools = makeTools(this.bridge);
    this._onEvent = opts.onEvent || null;
  }

  /* Connect the bridge, load the persisted config, and start serving the
   * decision plane. Resolves once attached and configured. */
  async start() {
    await this.bridge.connect();
    if (this._onEvent) this.bridge.on('event', this._onEvent);
    // Pick up whatever model/endpoint the user configured in-system (req. 4).
    try { this.config = await this.bridge.readConfig(); } catch (_e) { this.config = {}; }
    this.bridge.onDecision((question, code) => this.brain(question, code, this.config));
    return this;
  }

  /* Re-read the persisted config (e.g. after the user runs `ai set model ...`). */
  async refreshConfig() {
    this.config = await this.bridge.readConfig();
    return this.config;
  }

  /* Look up a tool descriptor by name (shared with the MCP surface). */
  tool(name) {
    return this.tools.find((t) => t.name === name) || null;
  }

  /* Invoke an OS capability by tool name — the in-process path an embedded agent
   * uses to drive the OS, identical to what the external agent calls over MCP. */
  async call(name, args = {}) {
    const t = this.tool(name);
    if (!t) throw new Error(`unknown tool: ${name}`);
    return t.handler(args);
  }

  stop() {
    this.bridge.close();
  }
}

module.exports = { KhyAgent, defaultBrain, INTENT_GENERIC, INTENT_NL };
