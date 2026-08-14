/**
 * state.js — `/state` diagnostics: shadow FSM states + recent transitions.
 *
 * Read-only aggregation over the four shadow state machine domains:
 *   1. CLI startup      — process.__khyStartupFsm (mounted by bin/khy.js)
 *   2. Server startup   — process.__khyServerStartupFsm (mounted by server.js)
 *   3. REPL phases      — cli/replSession.getReplFsm()
 *   4. Tool-use loop    — services/toolUseLoopCore.getLastLoopFsm()
 * Agent lifecycle FSMs live on each processAgent instance (no global
 * registry by design), so this command only points the user there.
 *
 * Fail-soft everywhere: a null/NoopFsm instance, a missing module or a
 * throwing getter degrades to an explanatory line, never a crash. Heavy
 * modules (replSession, toolUseLoopCore) are only consulted when they are
 * ALREADY in require.cache — if they never loaded in this process, their
 * FSM definitionally does not exist and we avoid pulling the module graph.
 *
 * @module handlers/state
 */
'use strict';

// ── Constants ──

const RECENT_LIMIT = 10; // transitions shown per machine

// ── Helpers ──

/**
 * Format a unix-ms timestamp as local HH:mm:ss.
 * @param {number} ts
 * @returns {string}
 */
function _fmtTime(ts) {
  if (!Number.isFinite(ts)) {
    return '--:--:--';
  }
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Pick lightweight scalar fields out of a transition meta object.
 * Never prints raw objects — only short Chinese fragments.
 * @param {object|null} meta
 * @returns {string[]}
 */
function _metaBits(meta) {
  const bits = [];
  if (!meta || typeof meta !== 'object') {
    return bits;
  }
  if (Number.isFinite(meta.iteration)) {
    bits.push(`第 ${meta.iteration} 轮`);
  }
  if (Number.isFinite(meta.attempt)) {
    bits.push(`第 ${meta.attempt} 次重试`);
  }
  if (Number.isFinite(meta.count)) {
    bits.push(`${meta.count} 个工具`);
  }
  if (Number.isFinite(meta.rounds)) {
    bits.push(`门控第 ${meta.rounds} 轮`);
  }
  if (typeof meta.step === 'string' && meta.step) {
    bits.push(`步骤 ${meta.step}`);
  }
  if (typeof meta.reason === 'string' && meta.reason) {
    bits.push(`原因 ${meta.reason}`);
  }
  if (typeof meta.gate === 'string' && meta.gate) {
    bits.push(`闸门 ${meta.gate}`);
  }
  return bits;
}

/**
 * Return a module's exports only when it is already loaded in this process.
 * Avoids dragging in heavy module graphs just to answer "no FSM yet".
 * @param {string} relPath - path relative to this file, for require.resolve
 * @returns {object|null}
 */
function _loadedModule(relPath) {
  try {
    const resolved = require.resolve(relPath);
    if (!require.cache[resolved]) {
      return null;
    }
    return require(resolved);
  } catch {
    return null;
  }
}

/**
 * Render one FSM domain into output lines (fail-soft on every FSM call).
 * @param {string[]} out - accumulator
 * @param {string} title - Chinese domain title, e.g. '工具循环 toolLoop'
 * @param {object|null} fsm - FSM instance or null
 * @param {string} missingText - full explanatory line when fsm is null
 */
function _renderFsm(out, title, fsm, missingText) {
  if (!fsm) {
    out.push(`${title}：${missingText}`);
    return;
  }

  // NoopFsm marker: the KHY_FSM_ENABLED gate is off — say so explicitly
  // instead of rendering it as an active machine with an empty history.
  if (fsm.disabled === true) {
    out.push(`${title}：状态机已通过 KHY_FSM_ENABLED=0 关闭（0 条历史）`);
    return;
  }

  let state = null;
  let since = null;
  let history = [];
  try {
    state = fsm.getState();
  } catch {
    /* keep null */
  }
  try {
    since = fsm._since;
  } catch {
    /* keep null */
  }
  try {
    history = fsm.getHistory() || [];
  } catch {
    history = [];
  }

  if (state === null || state === undefined) {
    out.push(`${title}：状态机存在但读取状态失败（0 条可用历史，已跳过）`);
    return;
  }

  const sinceText = Number.isFinite(since) ? `自 ${_fmtTime(since)} 起` : '起始时间未知';
  out.push(`${title}：当前 ${state}（${sinceText}，历史 ${history.length} 条）`);

  if (history.length === 0) {
    out.push(`  该状态机尚无转移记录（历史 0/${RECENT_LIMIT} 条，可能为 NoopFsm 或刚创建）`);
    return;
  }

  const recent = history.slice(-RECENT_LIMIT);
  out.push(`  最近 ${recent.length}/${history.length} 条转移（旧 → 新）：`);
  for (const entry of recent) {
    const e = entry || {};
    const time = _fmtTime(e.at);
    const bits = _metaBits(e.meta);
    const tail = bits.length ? `，${bits.join('，')}` : '';
    if (e.illegal) {
      out.push(`  状态 ${e.from} 收到事件 ${e.event}（${time}${tail}）⚠ 非法转移已忽略`);
    } else {
      out.push(`  ${e.from} → ${e.to}（事件 ${e.event}，${time}${tail}）`);
    }
  }
}

// ── Handler ──

/**
 * Handle `/state` (router command `state`): print per-domain FSM diagnostics.
 * @param {object} [options] - parsed --flags (unused, reserved)
 * @param {string[]} [args] - positional args (unused, reserved)
 */
async function handleState(options = {}, args = []) {
  // eslint-disable-line no-unused-vars
  const out = [];
  out.push('◆ 状态机诊断（/state）— 正在读取 4 个域的状态机快照');
  out.push('');

  // 1. CLI startup FSM (mounted on process by bin/khy.js)
  let startupFsm = null;
  try {
    startupFsm = process.__khyStartupFsm || null;
  } catch {
    /* keep null */
  }
  _renderFsm(
    out,
    '启动序列 startup',
    startupFsm,
    '本进程未挂载启动状态机（KHY_FSM_ENABLED 可能关闭，或非 khy CLI 入口，历史 0 条）'
  );

  out.push('');

  // 2. Server startup FSM (mounted on process by server.js)
  let serverFsm = null;
  try {
    serverFsm = process.__khyServerStartupFsm || null;
  } catch {
    /* keep null */
  }
  _renderFsm(
    out,
    '服务端启动 server-startup',
    serverFsm,
    '本进程未挂载服务端启动状态机（当前非 server 进程，历史 0 条）'
  );

  out.push('');

  // 3. REPL phase FSM (only when replSession already loaded in this process)
  let replFsm = null;
  const replMod = _loadedModule('../replSession');
  if (replMod && typeof replMod.getReplFsm === 'function') {
    try {
      replFsm = replMod.getReplFsm();
    } catch {
      /* keep null */
    }
  }
  _renderFsm(out, 'REPL repl', replFsm, '本进程未启动 REPL 会话（getReplFsm 返回空，历史 0 条）');

  out.push('');

  // 4. Tool-use loop FSM (only when toolUseLoopCore already loaded)
  let loopFsm = null;
  const loopMod = _loadedModule('../../services/toolUseLoopCore');
  if (loopMod && typeof loopMod.getLastLoopFsm === 'function') {
    try {
      loopFsm = loopMod.getLastLoopFsm();
    } catch {
      /* keep null */
    }
  }
  _renderFsm(
    out,
    '工具循环 toolLoop',
    loopFsm,
    '本会话尚未运行工具循环（getLastLoopFsm 返回空，历史 0 条）'
  );

  out.push('');

  // 5. Agent lifecycle: per-instance FSMs, no global registry by design.
  out.push(
    'Agent 生命周期 agentLifecycle：各 processAgent 实例持有独立状态机（无全局注册表，请在对应 Agent 实例上查看 _fsm）'
  );
  out.push('');
  out.push(
    '提示：设 KHY_STATE_DEBUG=1 可在 stderr 实时打印每条转移（格式 [fsm:label] from → to (event, HH:mm:ss)）'
  );

  console.log(out.join('\n'));
  return true;
}

module.exports = { handleState };
