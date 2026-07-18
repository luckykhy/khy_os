'use strict';

/**
 * agentDevLog.js — khyos 底座侧「开发者可观测层」（规范 §1）。
 *
 * 规范见 docs/03_DESIGN_设计/[DESIGN-ARCH-016] AI_Agent显示规范.md。
 *
 * 定位：本模块是 §6 承诺的 khyos 底座结构化日志落地。它**不产生**任何新事件，
 * 而是把既有的 `diagnosticEvents.js` 单一事件源（`diagnostics` 单例，贯穿整个
 * Agent 调度/LLM/工具链路的 choke-point）**适配**成规范要求的单行 JSON（NDJSON）：
 *   - 字段契约（§1.2）：ts / trace_id / span_id / app / agent / step / phase /
 *     thought / action / tokens / duration_ms / status / detail；
 *   - 强制脱敏（§1.3 / R4）：密钥/Token/Bearer/key=value 一律打码后才落盘；
 *   - 大文本摘要（§1.4 / R3）：任何字符串字段截断到 ≤100 字符 + 长度标注；
 *   - 双模运行（§3）：嵌入走 KHYOS_REPORT_FD 上报通道，独立走文件/ stderr。
 *
 * 与既有架构的关系（防呆，严守边界）：
 *   - **不改**任何业务算法、Prompt、或 6000+ 行 toolUseLoop 的 emit 站点；
 *   - 仅以 `diagnostics.on('*')` 监听者身份消费事件，在序列化边界做脱敏/摘要，
 *     **绝不**改写已存储事件对象（其它消费者 advancedDiagnostics / traceAudit 依赖原形）。
 *
 * 零待机噪音（§4 R1/R2）：本模块**不含任何定时器**，监听者仅在事件 emit 时触发，
 *   无任务即无事件即无输出。模块加载与 sink 构造**绝不**打印任何内容。
 *
 * 用户通道隔离（§0 红线 / R5）：本模块**只**面向开发者，**绝不**向 stdout 写入，
 *   也绝不输出给用户交互层。用户自然语言层见 cli/aiRenderer.js。
 *
 * 通道选择（standalone 默认静默的理由）：khyos 交互式 CLI 与用户共用同一个 TTY，
 *   stdout=用户、stderr 同屏可见。若无脑默认把 NDJSON 写 stderr，会污染用户终端、
 *   破坏 TUI 布局（违反 R5/R6 的精神）。因此底座侧采取「按需点亮」：
 *     - eco 模式（宿主注入 KHYOS_REPORT_FD）→ 默认开启，经上报通道，对用户不可见；
 *     - 显式 `KHY_AGENT_LOG_FILE=<path>` → 落该文件，对用户不可见（推荐的可观测姿势）；
 *     - 显式 `KHY_AGENT_LOG` ∈ {1,true,stderr} → 写 stderr（明确排障场景）；
 *     - 其余（standalone 未显式开启）→ 静默不挂 sink，保持交互式 CLI 既有行为；
 *     - `KHY_AGENT_LOG=0` → 任何情况都彻底关闭（§1.5 极致静默）。
 *
 * 零外部依赖（仅 Node 内置 fs）。
 */

const fs = require('fs');

const MAX_TEXT = 100;          // 大文本摘要上限（字符），见 §1.4
const MAX_ACTION = 60;         // action 字段更短
const MAX_TRACES = 256;        // per-trace step 计数器 Map 上限（防无界增长）

// ── 脱敏（§1.3 / R4）─────────────────────────────────────────────────────────
// 命中密钥/令牌类子串即打码；保留少量首尾字符以保可排障性，其余以 *** 代替。
// 语义与 software/khyquant/services/agentDisplay.js 一致（§6 双参考实现，底座侧不
// 依赖应用，故为平行实现）。
const SECRET_PATTERNS = [
  // 形如 sk-xxxx / khy-xxxx / ghp_xxxx 等带前缀的密钥
  /\b([A-Za-z]{2,5}[-_])([A-Za-z0-9]{6,})\b/g,
  // Bearer <token>
  /\b(Bearer\s+)([A-Za-z0-9._-]{8,})/gi,
  // key=value / key: value 形式的敏感键
  /\b((?:api[_-]?key|token|secret|password|passwd|cookie|authorization)\s*[=:]\s*)("?)([^\s"&,}]{4,})/gi,
];

function _maskValue(v) {
  const s = String(v);
  if (s.length <= 6) return '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

function _safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    try { return String(obj); } catch { return ''; }
  }
}

/**
 * 对任意输入脱敏。无法判定时倾向多打码（最小泄露原则）。
 * @param {*} input
 * @returns {string}
 */
function redact(input) {
  if (input == null) return '';
  let s = typeof input === 'string' ? input : _safeStringify(input);
  s = s.replace(SECRET_PATTERNS[0], (m, prefix, body) => `${prefix}${_maskValue(body)}`);
  s = s.replace(SECRET_PATTERNS[1], (m, prefix, body) => `${prefix}${_maskValue(body)}`);
  s = s.replace(SECRET_PATTERNS[2], (m, keyEq, q, val) => `${keyEq}${q}${_maskValue(val)}`);
  return s;
}

/**
 * 大文本摘要（§1.4）：先脱敏，再截断到 max 字符，超出标注 +N chars。
 * @param {*} input
 * @param {number} [max]
 * @returns {string}
 */
function summarize(input, max = MAX_TEXT) {
  const s = redact(input);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

// ── 事件类型 → 规范 phase（§1.2 枚举: start|llm|tool|result|error|end）──────────
function phaseForType(type, data) {
  switch (type) {
    case 'tool_call':
      return 'tool';
    case 'tool_result':
      return 'result';
    case 'model_request':
    case 'model_response':
      return 'llm';
    case 'error':
      return 'error';
    case 'session_state': {
      const to = String((data && data.to) || '').toLowerCase();
      if (/(end|done|idle|stop|complete|finish)/.test(to)) return 'end';
      return 'start';
    }
    default:
      // attention 等少见类型并入 result（带 status=fallback），不新增枚举值。
      return 'result';
  }
}

// ── 事件 → action 摘要（§1.2 action: 当前动作）────────────────────────────────
function actionForEvent(type, data) {
  const d = data || {};
  switch (type) {
    case 'tool_call':
    case 'tool_result':
      return d.toolName ? `tool.${d.toolName}` : 'tool';
    case 'model_request':
      return d.model ? `llm.request:${d.model}` : 'llm.request';
    case 'model_response':
      return d.model ? `llm.response:${d.model}` : 'llm.response';
    case 'session_state':
      return d.from && d.to ? `state.${d.from}->${d.to}` : 'state';
    case 'error':
      return d.category ? `error.${d.category}` : 'error';
    default:
      return type;
  }
}

/**
 * Per-run 步骤计数器（§1.2 step 从 1 递增，按 trace_id 隔离）。
 * 用有界 Map 防无界增长（治理：参考 retention 一档）。
 */
class _StepCounter {
  constructor(max = MAX_TRACES) {
    this._m = new Map();
    this._max = max;
  }

  next(traceId) {
    const key = traceId || '_';
    const cur = (this._m.get(key) || 0) + 1;
    this._m.set(key, cur);
    if (this._m.size > this._max) {
      // 删最旧（Map 保持插入序）
      const oldest = this._m.keys().next().value;
      if (oldest !== undefined) this._m.delete(oldest);
    }
    return cur;
  }

  release(traceId) {
    if (traceId) this._m.delete(traceId);
  }
}

/**
 * 把一个 diagnostics 事件适配成规范 §1.2 的单行 NDJSON 对象（已脱敏+摘要）。
 * 纯函数（除 step 计数）；不改写入参 event。
 *
 * @param {object} event - diagnosticEvents 的事件 { type, traceId, spanId, data, ... }
 * @param {object} ctx   - { app, agent, step }
 * @returns {object} 规范字段对象
 */
function toDevLogRecord(event, ctx = {}) {
  const type = event && event.type;
  const data = (event && event.data) || {};
  const rec = {
    ts: new Date(event && event.timestamp ? event.timestamp : Date.now()).toISOString(),
    trace_id: (event && event.traceId) || '',
    app: ctx.app || 'khyos',
    agent: data.agent || data.agentRole || ctx.agent || 'agent',
    step: ctx.step || 1,
    phase: phaseForType(type, data),
  };
  if (event && event.spanId) rec.span_id = event.spanId;

  const action = actionForEvent(type, data);
  if (action) rec.action = summarize(action, MAX_ACTION);

  // thought / detail（摘要 + 脱敏）
  if (data.thought != null) rec.thought = summarize(data.thought);
  const detailRaw = _deriveDetail(type, data);
  if (detailRaw != null && detailRaw !== '') rec.detail = summarize(detailRaw);

  // tokens（§1.2）
  const tokens = _deriveTokens(type, data);
  if (tokens) rec.tokens = tokens;

  // duration_ms
  if (typeof data.durationMs === 'number') rec.duration_ms = Math.round(data.durationMs);

  // status
  const status = _deriveStatus(type, data, event);
  if (status) rec.status = status;

  return rec;
}

function _deriveDetail(type, data) {
  switch (type) {
    case 'tool_call':
      return Array.isArray(data.paramKeys) && data.paramKeys.length
        ? `params: ${data.paramKeys.join(',')}`
        : null;
    case 'tool_result':
      return data.error ? String(data.error) : null;
    case 'model_request':
      return data.provider ? `provider: ${data.provider}` : null;
    case 'model_response':
      return data.provider ? `provider: ${data.provider}` : null;
    case 'session_state':
      return data.reason != null ? String(data.reason) : null;
    case 'error':
      // 仅取首行摘要；完整堆栈不进常规日志流（§1.4）。
      return data.message != null ? String(data.message) : (data.stack ? String(data.stack).split('\n')[0] : null);
    default:
      return null;
  }
}

function _deriveTokens(type, data) {
  if (type === 'model_response') {
    const inn = Number(data.inputTokens || 0) || 0;
    const out = Number(data.outputTokens || 0) || 0;
    const total = Number(data.totalTokens || inn + out) || 0;
    if (inn || out || total) return { in: inn, out, total };
  }
  if (type === 'model_request' && data.tokenEstimate) {
    const inn = Number(data.tokenEstimate) || 0;
    if (inn) return { in: inn, out: 0, total: inn };
  }
  return null;
}

function _deriveStatus(type, data, event) {
  if (type === 'error') return 'error';
  if (type === 'tool_result') return data.success ? 'ok' : 'error';
  if (event && event.attention) return 'fallback';
  if (type === 'session_state' || type === 'tool_call' || type === 'model_request' || type === 'model_response') {
    return 'ok';
  }
  return null;
}

// ── 通道解析（§3 / 见文件头 doc）────────────────────────────────────────────
function _parseFd(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * 解析当前进程应使用的 sink 目标。返回 null 表示「静默不挂 sink」。
 * @param {object} [env] - 注入 process.env 的可测试缝
 * @returns {{kind:'fd'|'file'|'stderr', fd?:number, file?:string}|null}
 */
function resolveTarget(env = process.env) {
  if (String(env.KHY_AGENT_LOG) === '0') return null; // 极致静默，最高优先级
  const fd = _parseFd(env.KHYOS_REPORT_FD);
  if (fd != null) return { kind: 'fd', fd };          // eco 模式：默认开启
  if (env.KHY_AGENT_LOG_FILE) return { kind: 'file', file: String(env.KHY_AGENT_LOG_FILE) };
  const flag = String(env.KHY_AGENT_LOG || '').toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'stderr') return { kind: 'stderr' };
  return null; // standalone 未显式开启 → 静默，保持交互式 CLI 既有行为
}

/**
 * NDJSON 开发者日志 sink。以 diagnostics 监听者身份消费事件，序列化边界做脱敏/摘要。
 * 任何写失败一律静默吞掉，绝不抛出影响 Agent（防呆）。
 */
class AgentDevLogSink {
  /**
   * @param {object} opts
   * @param {string} [opts.app='khyos']
   * @param {string} [opts.agent='agent']
   * @param {{kind:string, fd?:number, file?:string}} opts.target
   */
  constructor(opts = {}) {
    this.app = opts.app || 'khyos';
    this.agent = opts.agent || 'agent';
    this.target = opts.target;
    this._steps = new _StepCounter();
    this._fileFd = null; // 文件目标的懒打开 fd
  }

  /** 处理一个 diagnostics 事件，写出一行 NDJSON。绝不抛。 */
  handle(event) {
    try {
      if (!event || !this.target) return;
      const step = this._steps.next(event.traceId);
      const rec = toDevLogRecord(event, { app: this.app, agent: this.agent, step });
      this._write(rec, event);
      // 运行收尾时回收该 trace 的计数器，防止长生命周期进程无界增长。
      if (rec.phase === 'end') this._steps.release(event.traceId);
    } catch {
      /* 序列化/写入失败一律静默（§3.2 防呆，绝不崩 Agent） */
    }
  }

  _write(rec, event) {
    const t = this.target;
    if (t.kind === 'fd') {
      // 嵌入（eco）模式上报通道（§3.2）：NDJSON 状态事件，由底座排空。
      // TODO: [Agent-Display-Unresolved] 宿主提供正式 khyos.api.report_status 绑定后，
      // 应在此优先调用该 API；当前宿主未暴露该通道，按规范降级写 fd，不盲调不存在的 API。
      const payload = _safeStringify({ type: 'agent.log', trace_id: rec.trace_id, payload: rec }) + '\n';
      try { fs.writeSync(t.fd, payload); return; } catch { this._writeStderr(rec); return; }
    }
    if (t.kind === 'file') {
      try {
        if (this._fileFd == null) this._fileFd = fs.openSync(t.file, 'a');
        fs.writeSync(this._fileFd, _safeStringify(rec) + '\n');
        return;
      } catch { this._writeStderr(rec); return; }
    }
    this._writeStderr(rec);
  }

  _writeStderr(rec) {
    try { process.stderr.write(_safeStringify(rec) + '\n'); } catch { /* 终极兜底：彻底静默 */ }
  }

  dispose() {
    if (this._fileFd != null) {
      try { fs.closeSync(this._fileFd); } catch { /* ignore */ }
      this._fileFd = null;
    }
  }
}

// ── 单例挂载（幂等）─────────────────────────────────────────────────────────
let _attached = null;

/**
 * 幂等地把 NDJSON 开发者日志 sink 挂到 `diagnostics` 单例上。
 * 由 Agent 调度入口（toolUseLoop）在每次运行起点 best-effort 调用一次即可。
 *
 * @param {object} [opts] - { app, agent }
 * @returns {{dispose:Function}|null} 已挂载句柄；静默场景返回 null。
 */
function enableKhyosAgentDevLog(opts = {}) {
  const target = resolveTarget();
  if (!target) return _attached; // 静默：不挂 sink（且不改既有行为）
  if (_attached) return _attached; // 已挂载，幂等
  let diagnostics;
  try {
    ({ diagnostics } = require('./diagnosticEvents'));
  } catch {
    return null; // 事件源不可用 → 静默降级
  }
  const sink = new AgentDevLogSink({
    app: opts.app || 'khyos',
    agent: opts.agent || 'agent',
    target,
  });
  let unsub = null;
  try {
    unsub = diagnostics.on('*', (e) => sink.handle(e));
  } catch {
    return null;
  }
  _attached = {
    sink,
    dispose() {
      try { if (unsub) unsub(); } catch { /* ignore */ }
      try { sink.dispose(); } catch { /* ignore */ }
      _attached = null;
    },
  };
  return _attached;
}

/** 测试缝：复位单例挂载状态。 */
function _resetForTest() {
  if (_attached) {
    try { _attached.dispose(); } catch { /* ignore */ }
  }
  _attached = null;
}

module.exports = {
  redact,
  summarize,
  phaseForType,
  actionForEvent,
  toDevLogRecord,
  resolveTarget,
  AgentDevLogSink,
  enableKhyosAgentDevLog,
  MAX_TEXT,
  MAX_ACTION,
  _resetForTest,
};
