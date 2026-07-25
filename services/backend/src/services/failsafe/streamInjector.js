'use strict';

/**
 * failsafe/streamInjector.js — StreamFailSafeInjector：**兜底协议不可绕过**。
 *
 * 强制兜底协议：核心任务执行中若发生意外崩溃 / 流被异常掐断 / 进程被信号杀掉，
 * 必须在输出流的"最后一刻"强制注入一条结构化错误事件
 *   { type:'error', status:'failed', error_code, reason, detail, suggestion, fields }
 * 即便已经流式输出了部分内容，也以追加方式补一条 —— 前端据此翻译为精准人读提示，
 * **严禁**只显示"未返回有效回复"。
 *
 * 三层兜底：
 *   1) 应用层：业务 catch / finally 调 finalize(input) 主动归因。
 *   2) 流意外结束：markDone() 未被调用即视为异常，注入 E04。
 *   3) 进程层：uncaughtException / unhandledRejection → E04；SIGTERM / SIGINT → E06。
 *      所有"在册且未终结"的注入器会被全局清扫器逐一补写，确保进程被杀也写得出最后一条。
 *
 * 幂等：每个注入器只会终结一次（finalized 闸门），重复调用 no-op，杜绝双写终态。
 */

const { classify } = require('./classifier');
const { FALLBACK_CODE } = require('./errorCodes');

// 全局在册注入器（进程级清扫用）。WeakRef 不可枚举，故用 Set + 显式 dispose。
const _active = new Set();
let _processGuardsInstalled = false;

class StreamFailSafeInjector {
  /**
   * @param {object} opts
   * @param {(event:object)=>void} opts.send  SSE 发送器（如 aiManagementServer 的 sendEvent）。
   * @param {object} [opts.res]               http 响应对象（终结时尝试 end()）。
   * @param {object} [opts.context]           归因上下文（model/endpoint/timeoutMs/retryCount…）。
   * @param {boolean} [opts.track=true]       是否登记到进程级清扫器。
   */
  constructor({ send, res = null, context = {}, track = true } = {}) {
    this.send = typeof send === 'function' ? send : () => {};
    this.res = res;
    this.context = context || {};
    this.finalized = false;
    this.sawContent = false;
    this._tracked = false;
    if (track) this._track();
  }

  /** 透传一条事件，并跟踪是否已输出过内容（chunk）。 */
  emit(event) {
    if (event && (event.type === 'chunk' || event.type === 'content')) {
      const t = event.text || event.content || event.delta;
      if (typeof t === 'string' && t.length) this.sawContent = true;
    }
    try { this.send(event); } catch { /* 发送器异常不得反噬业务 */ }
    return this;
  }

  /** 正常完成：登记终态，关闭兜底（此后 finalize 为 no-op）。 */
  markDone() {
    this.finalized = true;
    this._untrack();
    return this;
  }

  /**
   * 主动归因并注入错误事件（应用层 catch / 空响应分支调用）。幂等。
   * @param {*} input 原始失败信号（Error / 结构化结果 / 裁决 / 已归因结构 / 错误码字符串）
   * @param {object} [ctx] 上下文覆盖
   * @returns {object|null} 注入的 E0x 结构；若已终结则返回 null（未重复注入）
   */
  fail(input, ctx = {}) {
    if (this.finalized) return null;
    const failure = _safeClassify(input, { ...this.context, ...ctx });
    this._inject(failure);
    return failure;
  }

  /**
   * 终结闸门：若尚未终结，则按"意外结束"注入兜底（默认 E04）。用于 finally / 流末尾。
   * 已正常 markDone 或已 fail 过则 no-op。
   * @param {*} [input] 可选的失败信号；缺省时按流意外中断处理。
   * @param {object} [ctx]
   * @returns {object|null}
   */
  finalize(input, ctx = {}) {
    if (this.finalized) return null;
    const signal = input !== undefined
      ? input
      : { error_code: FALLBACK_CODE, message: 'stream ended unexpectedly without a terminal event' };
    const failure = _safeClassify(signal, { ...this.context, ...ctx });
    this._inject(failure);
    return failure;
  }

  /** 清理（不注入）。仅在确认无需兜底时使用；通常用 markDone。 */
  dispose() {
    this.finalized = true;
    this._untrack();
  }

  // ── 内部 ────────────────────────────────────────────────────────

  _inject(failure) {
    this.finalized = true;
    const event = {
      type: 'error',
      fallback: true,
      partial: this.sawContent, // 告知前端：之前可能已输出部分内容
      status: failure.status,
      error_code: failure.error_code,
      reason: failure.reason,
      detail: failure.detail,
      suggestion: failure.suggestion,
      retryable: failure.retryable,
      // 续接提示透传：前端据此渲染"输入「继续」继续推进"，而非让用户对半截回复发懵。
      resumable: failure.resumable,
      continueHint: failure.continueHint,
      sensitive: failure.sensitive,
      category: failure.category,
      fields: failure.fields,
      // 追溯下钻关键：把本轮 requestId 盖到错误事件上，前端据此拉取服务端分阶段
      // 时间线（GET /api/ai-gateway/monitor/attribution?requestId=…）一路钻到根因。
      requestId: this.context?.requestId || null,
      // 向后兼容旧前端：保留 message，但内容是精准 reason 而非"未返回有效回复"。
      message: `[${failure.error_code}] ${failure.reason}`,
    };
    try { this.send(event); } catch { /* 发送失败也要尝试关闭响应 */ }
    try { if (this.res && typeof this.res.end === 'function') this.res.end(); } catch { /* ignore */ }
    this._untrack();
  }

  _track() {
    if (this._tracked) return;
    _active.add(this);
    this._tracked = true;
    StreamFailSafeInjector.installProcessGuards();
  }

  _untrack() {
    if (!this._tracked) return;
    _active.delete(this);
    this._tracked = false;
  }

  // ── 进程级最后一道防线 ──────────────────────────────────────────

  /**
   * 安装一次性进程级守卫：崩溃 / 信号杀进程时，清扫所有在册未终结的注入器，
   * 强制补写最后一条错误事件。可通过 KHY_FAILSAFE_PROCESS_GUARD=off 关闭。
   */
  static installProcessGuards() {
    if (_processGuardsInstalled) return;
    if (String(process.env.KHY_FAILSAFE_PROCESS_GUARD || '').toLowerCase() === 'off') return;
    _processGuardsInstalled = true;

    process.on('uncaughtException', (err) => {
      sweepActive({ error_code: 'E04', message: _errMsg(err), stack: err && err.stack });
    });
    process.on('unhandledRejection', (reason) => {
      sweepActive({ error_code: 'E04', message: _errMsg(reason), stack: reason && reason.stack });
    });
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        // 信号中断按网络层熔断兜底（请求被外部掐断）。
        sweepActive({ error_code: 'E06', message: `process received ${sig}`, endpoint: 'process' });
      });
    }
  }

  /** 测试 / 复位用：移除全部在册注入器（不注入）。 */
  static _clearActive() {
    for (const inj of [..._active]) inj._untrack();
  }

  /** 当前在册（未终结）注入器数量。 */
  static _activeCount() {
    return _active.size;
  }
}

/**
 * 进程级清扫：对所有在册未终结注入器强制补写错误事件。导出供进程守卫与测试调用。
 * @param {object} signal 统一失败信号（含 error_code 兜底）
 */
function sweepActive(signal) {
  for (const inj of [..._active]) {
    try {
      if (!inj.finalized) inj.finalize(signal);
    } catch { /* 单个注入器失败不得阻断其余清扫 */ }
  }
}

function _safeClassify(input, ctx) {
  try {
    return classify(input, ctx);
  } catch {
    // classify 兜底之上再兜底：绝不让兜底协议自身失败而无输出。
    return {
      status: 'failed', error_code: FALLBACK_CODE, reason: '工具内部抛出未捕获异常',
      detail: '执行过程中发生未归类的内部错误。', suggestion: '请重试或改用替代方案。',
      retryable: false, sensitive: false, category: '工具执行崩溃', fields: {}, attribution_complete: false,
    };
  }
}

function _errMsg(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

module.exports = {
  StreamFailSafeInjector,
  sweepActive,
};
