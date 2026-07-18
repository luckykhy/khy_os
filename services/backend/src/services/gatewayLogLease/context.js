'use strict';

/**
 * gatewayLogLease/context.js — 基于 AsyncLocalStorage 的「日志租界」上下文。
 *
 * 整套租界隔离的地基：用一个 async 上下文把"当前这条执行路径属于谁、处于什么模式"
 * 随调用栈携带下去，任何深处的适配器日志在落地前都能反查到它，据此决定可见性。
 *
 * 上下文形状（Lease）：
 *   {
 *     activeAdapter: string|null,   // 当前任务正在使用的适配器 id（规范化小写，如 'kiro'）
 *     mode: 'task'|'status-query'|'sandbox',
 *     buffer: string[],             // sandbox/重定向模式下，被吞掉的输出落到这里（可回放）
 *     seq: number,                  // 该上下文创建序号（排障关联用）
 *   }
 *
 * 模式语义：
 *   - task         普通请求：绑定一个 activeAdapter；只有该适配器的日志可净味后见用户(L0)。
 *   - status-query 用户主动查网关状态：放行所有适配器日志（全量可见）。
 *   - sandbox      适配器初始化 / Token 刷新：内部输出一律重定向到 buffer（静默），绝不上 L0。
 *
 * 防呆：无任何上下文时 current() 返回 null —— 调用方据此把"游离日志"判为非任务路径，
 *       丢弃或下沉 L1，绝不默认放行到主输出流。
 */

const { AsyncLocalStorage } = require('async_hooks');

const _store = new AsyncLocalStorage();
let _seq = 0;

/** 规范化适配器 id：小写去空白，统一同义词（与 aiGateway._normalizeAdapterSig 对齐的最小集）。 */
function normalizeAdapterId(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'local llm' || s === 'local' || s.includes('本地模型')) return 'localllm';
  if (s.includes('openai codex')) return 'codex';
  if (s.includes('anthropic')) return 'claude';
  return s;
}

const MODES = Object.freeze({ TASK: 'task', STATUS_QUERY: 'status-query', SANDBOX: 'sandbox' });

/** 在一个新租界上下文里同步/异步地运行 fn。 */
function runWith(partial, fn) {
  _seq += 1;
  const ctx = {
    activeAdapter: normalizeAdapterId(partial && partial.activeAdapter) || null,
    mode: (partial && partial.mode) || MODES.TASK,
    buffer: (partial && partial.buffer) || [],
    seq: _seq,
  };
  return _store.run(ctx, () => fn(ctx));
}

/** 当前租界上下文；不在任何上下文中时返回 null。 */
function current() {
  return _store.getStore() || null;
}

/** 是否处于"查网关状态"模式（全量放行）。 */
function isStatusQuery() {
  const c = current();
  return !!c && c.mode === MODES.STATUS_QUERY;
}

/** 是否处于静默沙箱模式（输出重定向缓冲）。 */
function isSandbox() {
  const c = current();
  return !!c && c.mode === MODES.SANDBOX;
}

/** 当前活跃适配器 id（无上下文返回 null）。 */
function activeAdapter() {
  const c = current();
  return c ? c.activeAdapter : null;
}

module.exports = {
  MODES,
  runWith,
  current,
  isStatusQuery,
  isSandbox,
  activeAdapter,
  normalizeAdapterId,
  _store, // 仅供同包模块（sandbox 还原）使用
};
