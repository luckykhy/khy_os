'use strict';

/**
 * gatewayLogLease/sandbox.js — AdapterLogSandbox：底层输出拦截 + 静默沙箱 + 后台报错守卫。
 *
 * 三件事：
 *   1) 拦截 console.* / process.stdout|stderr.write，按租界裁决（logLease.decide）把每条
 *      适配器日志路由到 L0(净味)/L1(开发日志)/BUFFER(沙箱缓冲)/DROP。非适配器、非租界内的
 *      普通日志原样放行（最小爆破半径，绝不接管全局日志）。
 *   2) runSandboxed()：把适配器初始化 / Token 刷新整体放进静默沙箱——其内部一切输出重定向
 *      到上下文缓冲，绝不上 L0；runForAdapter()/runStatusQuery() 为请求绑定活跃适配器/查询态。
 *   3) guardBackground()：包裹"发射后不管"的后台异步（Token 刷新、探活），把其 rejection 就地
 *      捕获并下沉 L1，使未被选中的适配器报错绝不冒泡成全局 UnhandledRejection / 污染主流 / 崩进程。
 *
 * 防呆：
 *   - 适配器应优先用 emit(adapterId, level, …) 显式带源打日志（不依赖文本嗅探）。
 *   - 拦截器自身任何异常都 fail-safe 回退到"原样放行"，绝不吞掉真正该见的输出、绝不抛错。
 *   - install()/installProcessGuards() 幂等，受 env KHY_GATEWAY_LOG_LEASE 门控（缺省关，显式开）。
 */

const { AsyncLocalStorage } = require('async_hooks');
const util = require('util');

const ctxMod = require('./context');
const logLease = require('./logLease');
const noiseFilter = require('./noiseFilter');
const devLog = require('./devLog');
const { ADAPTER_TOKENS } = require('./noiseFilter');

// "当前正在打日志的适配器"上下文（provenance），与"活跃适配器"(lease.activeAdapter)正交。
const _sourceStore = new AsyncLocalStorage();

const ENV_FLAG = 'KHY_GATEWAY_LOG_LEASE';
function _enabled() {
  const v = process.env[ENV_FLAG];
  return v === '1' || v === 'true' || v === 'on';
}

// ── 原生 sink 句柄（install 时快照，uninstall 还原）────────────────────
let _installed = false;
let _orig = null;
let _userWrite = null; // L0 出口：默认写真实 stdout

function _composeText(args) {
  try { return util.format(...args); } catch { return args.map(String).join(' '); }
}

/** 从文本前缀嗅探来源适配器（[kiroAdapter] / [kiro:debug] / [relay_api] …）。 */
function _sniffSource(text) {
  const m = String(text).match(/^\s*\[([^\]]+)\]/);
  if (!m) return null;
  const inner = m[1].toLowerCase().replace(/:.*/, '').replace(/adapter$/, '').replace(/[_-]/g, '');
  for (const tok of ADAPTER_TOKENS) {
    const norm = tok.replace(/adapter$/, '').replace(/[_-]/g, '');
    if (norm && inner.includes(norm)) return ctxMod.normalizeAdapterId(tok.replace(/adapter$/, ''));
  }
  return null;
}

/** 解析这条输出归属的来源适配器：显式 > 文本标记(跨适配器优先) > provenance 上下文。 */
function _resolveSource(explicit, text) {
  if (explicit) return ctxMod.normalizeAdapterId(explicit);
  // 文本里显式带了 [xxxAdapter] 标记时，即便它出现在别的适配器的 provenance 块内，
  // 也必须归到被点名的那个适配器（否则 deepseek 请求里 kiro 的后台日志会被误判为 deepseek）。
  const sniffed = _sniffSource(text);
  if (sniffed) return sniffed;
  return _sourceStore.getStore() || null;
}

/** 把一条（已确定来源的）输出按租界落地。返回 true=已被租界接管，false=未接管(应原样放行)。 */
function _route(explicitSource, level, text) {
  const inLease = !!ctxMod.current();
  const source = _resolveSource(explicitSource, text);

  // 沙箱模式下接管一切（init/token 刷新内的所有输出都属适配器内部）。
  const sandbox = ctxMod.isSandbox();
  // 非沙箱、非适配器来源、且不在任何租界里 → 不接管，原样放行（最小爆破半径）。
  if (!sandbox && !source && !inLease) return false;
  // 非沙箱、非适配器来源、但在租界里：仍不接管（避免吞掉请求内其它服务的普通日志）。
  if (!sandbox && !source) return false;

  let verdict;
  try {
    verdict = logLease.decide({ sourceAdapter: source, level, text });
  } catch {
    return false; // 裁决失败 → fail-safe 放行
  }

  switch (verdict.channel) {
    case logLease.CHANNELS.L0:
      _emitUser(verdict.output);
      return true;
    case logLease.CHANNELS.L1:
      devLog.write({ kind: 'lease', adapter: source, level, message: verdict.output });
      return true;
    case logLease.CHANNELS.BUFFER: {
      const c = ctxMod.current();
      if (c && Array.isArray(c.buffer)) c.buffer.push(`[${source || '?'}] ${verdict.output}`);
      else devLog.write({ kind: 'sandbox', adapter: source, level, message: verdict.output });
      return true;
    }
    case logLease.CHANNELS.DROP:
    default:
      return true; // 接管并丢弃
  }
}

/** L0 出口：净味后的用户可见提示写到真实用户流。 */
function _emitUser(text) {
  if (text == null || text === '') return;
  const line = String(text).endsWith('\n') ? String(text) : String(text) + '\n';
  try { (_userWrite || process.stdout.write.bind(process.stdout))(line); } catch { /* 出口失败不致命 */ }
}

// ── 显式 API（防呆①推荐：适配器带源打日志）───────────────────────────

/** 适配器显式打一条带源日志。无论 install 与否都按租界裁决（不依赖 console 补丁）。 */
function emit(adapterId, level, ...args) {
  const text = _composeText(args);
  const handled = _route(adapterId, level || 'log', text);
  // 未被接管（如纯系统提示），回退到真实输出，避免静默丢信息。
  if (!handled) _emitUser(noiseFilter.sanitizeForStatus(text));
}

/** 声明一段代码块的来源适配器（不改变 lease 模式/活跃适配器）。 */
function withSource(adapterId, fn) {
  return _sourceStore.run(ctxMod.normalizeAdapterId(adapterId), fn);
}

// ── 租界运行器 ────────────────────────────────────────────────────────

/** 为一次请求绑定活跃适配器（task 模式）：该适配器日志净味后可见 L0。 */
function runForAdapter(adapterId, fn) {
  const id = ctxMod.normalizeAdapterId(adapterId);
  return ctxMod.runWith({ activeAdapter: id, mode: ctxMod.MODES.TASK }, () => withSource(id, () => fn()));
}

/** 查网关状态上下文：放行全部适配器日志（全量可见）。 */
function runStatusQuery(fn) {
  return ctxMod.runWith({ mode: ctxMod.MODES.STATUS_QUERY }, () => fn());
}

/**
 * 静默沙箱：适配器初始化 / Token 刷新。内部一切输出重定向到缓冲，绝不上 L0。
 * @returns {Promise<{ result:*, buffer:string[], error:Error|null }>}
 */
async function runSandboxed(adapterId, fn) {
  const id = ctxMod.normalizeAdapterId(adapterId);
  const buffer = [];
  return ctxMod.runWith({ activeAdapter: id, mode: ctxMod.MODES.SANDBOX, buffer }, async (ctx) => {
    return _sourceStore.run(id, async () => {
      try {
        const result = await fn();
        return { result, buffer: ctx.buffer, error: null };
      } catch (error) {
        // 沙箱内异常不外泄：摘要下沉 L1，调用方拿结构化结果自行决定降级。
        devLog.write({ kind: 'sandbox-error', adapter: id, level: 'error', message: noiseFilter.sanitizeForStatus(error) });
        return { result: null, buffer: ctx.buffer, error };
      }
    });
  });
}

/**
 * 守卫"发射后不管"的后台异步（Token 刷新 / 探活）：rejection 就地捕获→L1，
 * 绝不冒泡成全局 UnhandledRejection、绝不污染主流、绝不崩进程。
 * @returns {Promise<*>} 永不 reject（失败时 resolve(null)）。
 */
function guardBackground(adapterId, fnOrPromise) {
  const id = ctxMod.normalizeAdapterId(adapterId);
  const p = typeof fnOrPromise === 'function'
    ? Promise.resolve().then(() => _sourceStore.run(id, fnOrPromise))
    : Promise.resolve(fnOrPromise);
  return p.catch((err) => {
    devLog.write({ kind: 'background-error', adapter: id, level: 'error', message: noiseFilter.sanitizeForStatus(err) });
    return null;
  });
}

// ── console / stdout 拦截补丁 ─────────────────────────────────────────

const _LEVELS = ['log', 'info', 'warn', 'error', 'debug'];

/** 安装拦截补丁。幂等；受 env 门控。返回 uninstall()。 */
function install(opts = {}) {
  if (_installed) return uninstall;
  if (!opts.force && !_enabled()) return () => {};

  _userWrite = typeof opts.userSink === 'function'
    ? opts.userSink
    : process.stdout.write.bind(process.stdout);

  _orig = {
    console: {},
    stdout: process.stdout.write.bind(process.stdout),
    stderr: process.stderr.write.bind(process.stderr),
  };
  for (const lvl of _LEVELS) _orig.console[lvl] = console[lvl].bind(console);

  for (const lvl of _LEVELS) {
    console[lvl] = (...args) => {
      let handled = false;
      try { handled = _route(null, lvl, _composeText(args)); } catch { handled = false; }
      if (!handled) _orig.console[lvl](...args);
    };
  }
  // stdout/stderr.write：仅当能确定适配器来源或在沙箱内才接管，否则原样放行。
  process.stdout.write = _wrapWrite(_orig.stdout, 'log');
  process.stderr.write = _wrapWrite(_orig.stderr, 'error');

  _installed = true;
  return uninstall;
}

function _wrapWrite(origWrite, level) {
  return function patched(chunk, encoding, cb) {
    try {
      const text = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString(encoding || 'utf8') : String(chunk));
      // _userWrite 自身就是 origWrite 时不要递归：L0 出口已直接走 origWrite。
      const handled = _route(null, level, text);
      if (handled) {
        if (typeof encoding === 'function') encoding();
        else if (typeof cb === 'function') cb();
        return true;
      }
    } catch { /* fail-safe 放行 */ }
    return origWrite(chunk, encoding, cb);
  };
}

/** 还原原生 sink。 */
function uninstall() {
  if (!_installed || !_orig) return;
  for (const lvl of _LEVELS) console[lvl] = _orig.console[lvl];
  process.stdout.write = _orig.stdout;
  process.stderr.write = _orig.stderr;
  _installed = false;
  _orig = null;
}

// ── 全局后台报错安全网（保守：只认领适配器可归因者）─────────────────

let _guardsInstalled = false;
function installProcessGuards() {
  if (_guardsInstalled) return () => {};
  const onRejection = (reason) => {
    const id = _attributeAdapter(reason);
    if (!id) return; // 非适配器可归因：交给既有处理器，绝不越权
    const active = ctxMod.activeAdapter();
    if (active && id === active) return; // 活跃路径的真实错误：不吞，留给正常错误流
    devLog.write({ kind: 'unhandled-rejection', adapter: id, level: 'error', message: noiseFilter.sanitizeForStatus(reason) });
  };
  process.on('unhandledRejection', onRejection);
  _guardsInstalled = true;
  return () => { process.removeListener('unhandledRejection', onRejection); _guardsInstalled = false; };
}

/** 尝试把一个错误归因到某适配器（显式字段 > 文本嗅探）。 */
function _attributeAdapter(err) {
  if (err && typeof err === 'object' && err.adapterId) return ctxMod.normalizeAdapterId(err.adapterId);
  // 优先用 message（栈以 "Error:" 开头，会让前缀嗅探落空）；message 无果再扫栈里的 [xxxAdapter] 标记。
  const msg = err instanceof Error ? (err.message || '') : String(err || '');
  const hit = _sniffSource(msg);
  if (hit) return hit;
  const stack = err instanceof Error ? (err.stack || '') : '';
  const m = stack.match(/\[([^\]]*adapter[^\]]*)\]/i);
  return m ? _sniffSource(`[${m[1]}]`) : null;
}

module.exports = {
  install,
  uninstall,
  installProcessGuards,
  emit,
  withSource,
  runForAdapter,
  runStatusQuery,
  runSandboxed,
  guardBackground,
  _route,            // 测试用
  _sniffSource,      // 测试用
  _attributeAdapter, // 测试用
  ENV_FLAG,
};
