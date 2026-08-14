/**
 * agentDisplay — khyos 生态 AI Agent 显示规范（生态应用侧参考实现）
 *
 * 规范见 docs/03_DESIGN_设计/[DESIGN-ARCH-016] AI_Agent显示规范.md。
 *
 * 一次 Agent 运行同时面向两类受众，二者物理隔离、互不污染，但共享同一 trace_id：
 *   1) 开发者可观测层 —— 单行 JSON（NDJSON），含 trace_id/step/phase/action/tokens，
 *      强制脱敏（§1.3）+ 大文本摘要 ≤100 字符（§1.4）。
 *   2) 用户交互层 —— 自然语言短句（进度 / 结果汇报 / 错误降级），严禁暴露任何内部字段。
 *
 * 双模运行（§3）：
 *   - 独立（standalone）：开发者日志 + 用户提示均写 stderr，保持 stdout 纯净。
 *   - 嵌入（eco）：经 khyos 上报通道交给底座渲染，严禁直接 console 抢占 TUI。
 *
 * 零待机噪音（§4 R1/R2）：本模块**不含任何定时器**，只在任务期间被显式调用时才产生输出。
 * 模块加载与 reporter 构造**绝不**打印任何内容。
 *
 * 零外部依赖（仅 Node 内置 crypto / fs），可在独立与嵌入两种环境无差别加载。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');

const MAX_TEXT = 100; // 大文本摘要上限（字符），见 §1.4

// ── 脱敏（§1.3 / R4）─────────────────────────────────────────────────────────
// 命中密钥/令牌类子串即打码；保留少量首尾字符以保可排障性，其余以 *** 代替。
const SECRET_PATTERNS = [
  // 形如 sk-xxxx / khy-xxxx / ghp_xxxx 等带前缀的密钥
  /\b([A-Za-z]{2,5}[-_])([A-Za-z0-9]{6,})\b/g,
  // Bearer <token> / Authorization: <token>
  /\b(Bearer\s+)([A-Za-z0-9._-]{8,})/gi,
  // key=value 形式的敏感键
  /\b((?:api[_-]?key|token|secret|password|passwd|cookie|authorization)\s*[=:]\s*)("?)([^\s"&,}]{4,})/gi,
];

function _maskValue(v) {
  const s = String(v);
  if (s.length <= 6) return '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

/**
 * 对任意字符串脱敏。无法判定时倾向于多打码（最小泄露原则）。
 * @param {*} input
 * @returns {string}
 */
function redact(input) {
  if (input == null) return '';
  let s = typeof input === 'string' ? input : safeStringify(input);
  s = s.replace(SECRET_PATTERNS[0], (m, prefix, body) => `${prefix}${_maskValue(body)}`);
  s = s.replace(SECRET_PATTERNS[1], (m, prefix, body) => `${prefix}${_maskValue(body)}`);
  s = s.replace(SECRET_PATTERNS[2], (m, keyEq, q, val) => `${keyEq}${q}${_maskValue(val)}`);
  return s;
}

/**
 * 大文本摘要（§1.4）：先脱敏，再截断到 MAX_TEXT 字符，超出标注 +N。
 * @param {*} input
 * @param {number} [max]
 * @returns {string}
 */
function summarize(input, max = MAX_TEXT) {
  const s = redact(input);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

function safeStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

// ── trace / span id（§1.2）──────────────────────────────────────────────────
function newTraceId() {
  return crypto.randomBytes(16).toString('hex'); // 32 hex
}
function newSpanId() {
  return crypto.randomBytes(8).toString('hex'); // 16 hex
}

// ── 模式判定（§3.1）─────────────────────────────────────────────────────────
function detectMode() {
  const m = String(process.env.KHYQUANT_MODE || '').toLowerCase();
  if (m === 'eco') return 'eco';
  if (m === 'standalone') return 'standalone';
  // 默认独立；缺省即静默降级，绝不因缺 khyos 运行时而报错（§3.3）。
  return 'standalone';
}

// ── token 概数格式化（用户层，§2.2）──────────────────────────────────────────
function fmtTokens(n) {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/**
 * 一次 Agent 运行的显示器。每次运行 new 一个，承载唯一 trace_id 与累计资源。
 */
class AgentDisplay {
  /**
   * @param {object} [opts]
   * @param {string} [opts.app='khyquant'] 产生方
   * @param {string} [opts.agent='agent'] agent 角色名
   * @param {string} [opts.traceId] 复用上游 trace_id；缺省自动生成
   */
  constructor(opts = {}) {
    this.app = opts.app || 'khyquant';
    this.agent = opts.agent || 'agent';
    this.traceId = opts.traceId || newTraceId();
    this.mode = detectMode();
    // step 在同一 trace 内全局单调递增（§1.2）：子显示器共享同一计数器引用，
    // 使父/子 agent 的事件在一次运行里保持有序、不重号。
    this._stepRef = opts._stepRef || { n: 0 };
    this.startedAt = Date.now();
    this.tokens = { in: 0, out: 0, total: 0 };
    // 嵌入模式上报 fd（由 khyos 注入）；无则降级（见 _report）。绝不在此打印。
    this._reportFd = _parseFd(process.env.KHYOS_REPORT_FD);
    // 开发者日志可经 KHY_AGENT_LOG=0 关闭（§1.5）。
    this._devEnabled = process.env.KHY_AGENT_LOG !== '0';
  }

  /** 当前已用步数（同一 trace 内全局计数）。 */
  get step() {
    return this._stepRef.n;
  }

  /** 复制一个共享 trace_id 的子显示器（用于子 agent / 并行步骤）。 */
  child(agent) {
    const c = new AgentDisplay({ app: this.app, agent, traceId: this.traceId, _stepRef: this._stepRef });
    c.tokens = this.tokens; // 共享资源累计
    return c;
  }

  /** 累计 token 消耗。接受 {in,out,total} 或 {inputTokens,outputTokens}。 */
  addTokens(u = {}) {
    const inn = Number(u.in ?? u.inputTokens ?? u.input ?? 0) || 0;
    const out = Number(u.out ?? u.outputTokens ?? u.output ?? 0) || 0;
    const tot = Number(u.total ?? u.totalTokens ?? inn + out) || 0;
    this.tokens.in += inn;
    this.tokens.out += out;
    this.tokens.total += tot;
  }

  /**
   * 开发者结构化日志（§1）。单行 JSON，字段强制脱敏 + 摘要。
   * @param {string} phase start|llm|tool|result|error|end
   * @param {object} [fields] {action, thought, detail, tokens, durationMs, status, spanId}
   */
  log(phase, fields = {}) {
    if (!this._devEnabled) return;
    this._stepRef.n += 1;
    const evt = {
      ts: new Date().toISOString(),
      trace_id: this.traceId,
      app: this.app,
      agent: this.agent,
      step: this._stepRef.n,
      phase,
    };
    if (fields.spanId) evt.span_id = fields.spanId;
    if (fields.action) evt.action = summarize(fields.action, 60);
    if (fields.thought != null) evt.thought = summarize(fields.thought);
    if (fields.detail != null) evt.detail = summarize(fields.detail);
    if (fields.tokens) {
      const t = fields.tokens;
      evt.tokens = {
        in: Number(t.in ?? t.inputTokens ?? 0) || 0,
        out: Number(t.out ?? t.outputTokens ?? 0) || 0,
        total: Number(t.total ?? t.totalTokens ?? 0) || 0,
      };
    }
    if (typeof fields.durationMs === 'number') evt.duration_ms = Math.round(fields.durationMs);
    if (fields.status) evt.status = fields.status;
    this._emitDev(evt);
  }

  /** 用户层进度提示（§2.1）：自然语言短句，严禁内部字段。 */
  progress(message) {
    this._emitUser({ type: 'progress', text: redact(String(message)) });
  }

  /**
   * 用户层结果汇报（§2.2）：结论 + 简要资源消耗（耗时/约略 token）。
   * 同时写一条开发者 end 事件。
   */
  done(message) {
    const ms = Date.now() - this.startedAt;
    const sec = (ms / 1000).toFixed(1);
    const tok = this.tokens.total;
    const tail = tok > 0 ? `，消耗约 ${fmtTokens(tok)} tokens` : '';
    this._emitUser({ type: 'result', text: `${redact(String(message))}（耗时 ${sec} 秒${tail}）` });
    this.log('end', { detail: message, durationMs: ms, status: 'ok', tokens: this.tokens });
  }

  /**
   * 用户层错误降级（§2.2 / R7）：对用户说人话 + 已采取的兜底；对开发者记 error 事件。
   * @param {string} userMessage 给用户的自然语言
   * @param {Error|string} [err] 真实错误（仅进开发者层，脱敏+摘要）
   * @param {string} [fallback] 已采取的兜底动作描述（给用户）
   */
  error(userMessage, err, fallback) {
    const text = fallback
      ? `${redact(String(userMessage))}，${redact(String(fallback))}`
      : redact(String(userMessage));
    this._emitUser({ type: 'error', text });
    this.log('error', { detail: err && err.stack ? err.stack.split('\n')[0] : err, status: 'error' });
  }

  // ── 通道实现 ───────────────────────────────────────────────────────────────

  _emitDev(evt) {
    const line = safeStringify(evt);
    if (this.mode === 'eco') {
      this._report({ type: 'agent.log', trace_id: this.traceId, payload: evt });
    } else {
      // 独立模式：开发者 JSON 走 stderr，保持 stdout 纯净（§1.5）。
      process.stderr.write(line + '\n');
    }
  }

  _emitUser(evt) {
    if (this.mode === 'eco') {
      this._report({ type: 'agent.status', trace_id: this.traceId, phase: evt.type, message: evt.text });
    } else {
      // 独立模式：用户层自然语言走 stderr（不含任何 JSON / 内部字段，§2.2）。
      process.stderr.write(evt.text + '\n');
    }
  }

  /**
   * 嵌入模式上报（§3.2）。优先级：
   *   1) 宿主注入的 fd（KHYOS_REPORT_FD）→ 写 NDJSON 状态事件，由 khyos 排空；
   *   2) 降级 → stderr 加 khyos.status 前缀，供底座解析；
   * 任何写失败都静默降级，绝不抛出导致 Agent 崩溃（§3.2 防呆）。
   *
   * TODO: [Agent-Display-Unresolved] 当 khyos 宿主提供正式的 khyos.api.report_status
   * 绑定（Python app_protocol ctx 注入到 Node 侧）后，应在此处优先调用该 API；
   * 当前宿主侧尚未暴露该通道，故按规范降级到 fd / stderr，不盲目调用不存在的 API。
   */
  _report(obj) {
    const line = safeStringify(obj) + '\n';
    try {
      if (this._reportFd != null) {
        fs.writeSync(this._reportFd, line);
        return;
      }
    } catch {
      // fd 写失败 → 落到 stderr 降级
    }
    try {
      process.stderr.write('khyos.status ' + line);
    } catch {
      /* 终极兜底：彻底静默，绝不抛 */
    }
  }
}

function _parseFd(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 便捷工厂：创建一次运行的显示器。 */
function create(opts) {
  return new AgentDisplay(opts);
}

module.exports = {
  AgentDisplay,
  create,
  redact,
  summarize,
  newTraceId,
  newSpanId,
  detectMode,
  fmtTokens,
  MAX_TEXT,
};
