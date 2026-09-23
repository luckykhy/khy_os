'use strict';

/**
 * taskStateSpec.js — 纯叶子（零 IO、确定性、绝不抛、可单测）：A2A `TaskState` 的单一真源
 * 与「内部状态 → 规范状态」映射。
 *
 * 定位：khy-os 内部存在**至少三套互不相同**的 agent 生命周期状态机：
 *
 *   | 位置 | 状态集 |
 *   |------|--------|
 *   | `services/a2aAgentLifecycle.js` | pending / spawning / running / waiting / completing / completed / failed / killing / killed / timed_out |
 *   | `services/subAgentOrchestrator.js` | created / running / waiting / completed / failed / killed / timed_out |
 *   | `services/domain/state/stateMachine/agentLifecycle.js` | created / initializing / ready / running / completed / error / killed |
 *
 * 三套加起来与 A2A 规范的封闭状态集 `submitted / working / input-required / completed /
 * canceled / failed / rejected / auth-required / unknown` 只有 `completed` / `failed`
 * 两个词重合，且语义并不等价（规范的 `input-required` 表示「需要调用方补充输入」，
 * khy 的 `waiting` 语义更宽）。把私有状态直接透出到协议边界，等于对外宣称一套
 * 没人认识的状态机，任何标准客户端都无法据此驱动任务。
 *
 * 本叶子把这件事收敛成两条纯函数：
 *   1. `toA2aState(internal)` —— 任何内部状态（含未知状态）→ 规范状态，永不抛。
 *   2. `canTransition(from, to)` —— 规范状态之间的迁移是否合法（终态之后不得再迁）。
 *
 * 契约：零 IO、确定性、绝不抛。
 * 门控 KHY_A2A_STRICT_TASK_STATE（default-off，CANON on）：开启后，映射不到规范状态的
 * 内部状态不再静默降级为 `unknown`，而是由调用方记 warning —— 用于把「新加了一个
 * 内部状态却没同步映射表」这类漂移尽快暴露，而不是等外部 integrator 报错。
 */

// ── 规范状态集（A2A v0.3.0，封闭枚举）─────────────────────────────────────

/** A2A TaskState 全集（顺序与规范一致）。 */
const A2A_TASK_STATES = Object.freeze([
  'submitted',
  'working',
  'input-required',
  'completed',
  'canceled',
  'failed',
  'rejected',
  'auth-required',
  'unknown',
]);

/** 终态：进入之后**不得**再迁移（规范要求）。 */
const TERMINAL_TASK_STATES = Object.freeze(['completed', 'canceled', 'failed', 'rejected']);

/** 中断态：任务未结束，但需要外部输入才能继续。 */
const INTERRUPTED_TASK_STATES = Object.freeze(['input-required', 'auth-required']);

const _STATE_SET = new Set(A2A_TASK_STATES);
const _TERMINAL_SET = new Set(TERMINAL_TASK_STATES);

const FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 严格模式门控：映射不到规范状态时是否要求调用方告警（而不仅静默降级）。
 * @param {object} [env]
 * @returns {boolean}
 */
function isStrictTaskStateEnabled(env = process.env) {
  const e = env || {};
  const v = e.KHY_A2A_STRICT_TASK_STATE;
  return !(v === undefined || v === null || FALSY.has(String(v).trim().toLowerCase()));
}

// ── 内部状态 → 规范状态 ──────────────────────────────────────────────────
/**
 * 三套内部状态机的合并映射表。
 * 值的选择理由逐条写在行内注释里 —— 这不是「随便挑一个近义词」，而是本仓状态语义
 * 与规范语义的**显式对照**，将来任一内部状态机改了语义，这张表就是必须同步改的地方。
 */
const INTERNAL_TO_A2A_STATE = Object.freeze({
  // ── services/a2aAgentLifecycle.js ──
  pending: 'submitted', // 已登记、尚未起进程
  spawning: 'submitted', // 起进程属于「已提交、正在准备」
  running: 'working', // 正在干活
  waiting: 'input-required', // 等待外部输入/子代理 —— 规范里最接近的中断态
  completing: 'working', // 收尾仍属工作态；规范无「完成中」态
  completed: 'completed',
  failed: 'failed',
  killing: 'working', // 取消尚未生效，任务仍在「工作」；成功取消后转 canceled
  killed: 'canceled', // 被主动终止 ≡ 规范 canceled
  timed_out: 'failed', // 超时是失败的一种；规范无独立 timeout 态

  // ── services/domain/state/stateMachine/agentLifecycle.js ──
  created: 'submitted',
  initializing: 'submitted',
  ready: 'submitted', // 就绪但未开工 → 已提交
  error: 'failed',

  // ── 通用/别名 ──
  success: 'completed',
  ok: 'completed',
  cancelled: 'canceled',
  canceled: 'canceled',
  timeout: 'failed',
  rejected: 'rejected',
  'input-required': 'input-required',
  'auth-required': 'auth-required',
  submitted: 'submitted',
  working: 'working',
  unknown: 'unknown',
});

/** 内部状态集的清单（供守卫断言「三套状态机全被映射」）。 */
const KNOWN_INTERNAL_STATES = Object.freeze([
  // a2aAgentLifecycle
  'pending', 'spawning', 'running', 'waiting', 'completing', 'completed', 'failed',
  'killing', 'killed', 'timed_out',
  // stateMachine/agentLifecycle
  'created', 'initializing', 'ready', 'error',
]);

/**
 * 内部状态 → 规范 TaskState。
 * 未知/畸形输入 → `'unknown'`（规范定义的合法值，代表「无法判定」），绝不抛。
 * @param {string} internalState
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {function(string):void} [opts.onUnmapped] 严格模式下对未映射状态的告警回调
 * @returns {string}
 */
function toA2aState(internalState, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const key = String(internalState == null ? '' : internalState).trim().toLowerCase();
  if (!key) return 'unknown';
  const mapped = INTERNAL_TO_A2A_STATE[key];
  if (mapped && _STATE_SET.has(mapped)) return mapped;
  if (isStrictTaskStateEnabled(o.env) && typeof o.onUnmapped === 'function') {
    o.onUnmapped(key);
  }
  return 'unknown';
}

/**
 * 给定内部状态是否映射为终态。
 * @param {string} internalState
 * @returns {boolean}
 */
function isInternalTerminal(internalState) {
  return _TERMINAL_SET.has(toA2aState(internalState));
}

// ── 迁移合法性 ────────────────────────────────────────────────────────────
/**
 * 规范状态迁移表。
 *
 * 终态（completed / canceled / failed / rejected）**没有出边** —— 规范要求终态是最终状态。
 * `unknown` 视为「不知道当前是什么」，故允许迁到任何状态（包括终态）。
 * `submitted` 之后的任何非终态都可达（真实实现的进度报告并不严格有序）。
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  submitted: ['working', 'input-required', 'auth-required', 'completed', 'failed', 'canceled', 'rejected', 'unknown'],
  working: ['input-required', 'auth-required', 'completed', 'failed', 'canceled', 'rejected', 'unknown'],
  'input-required': ['working', 'auth-required', 'completed', 'failed', 'canceled', 'rejected', 'unknown'],
  'auth-required': ['working', 'input-required', 'completed', 'failed', 'canceled', 'rejected', 'unknown'],
  unknown: [...A2A_TASK_STATES],
  completed: [],
  canceled: [],
  failed: [],
  rejected: [],
});

/**
 * 规范状态迁移是否合法。同态迁移恒为 true（幂等上报）。未知状态名 → false（不猜）。
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
function canTransition(from, to) {
  const a = String(from == null ? '' : from).trim().toLowerCase();
  const b = String(to == null ? '' : to).trim().toLowerCase();
  if (!_STATE_SET.has(a) || !_STATE_SET.has(b)) return false;
  if (a === b) return true;
  const allowed = ALLOWED_TRANSITIONS[a];
  return Array.isArray(allowed) && allowed.includes(b);
}

/**
 * 构造规范 `TaskStatus`（`task.schema.json` 的形状）。
 *
 * `timestamp` 只在调用方显式传入时写入 —— 本叶子是确定性的，自己取 `Date.now()`
 * 会让同一个输入产出不同输出、无法做快照断言。
 *
 * @param {string} internalState
 * @param {object} [opts]
 * @param {string} [opts.timestamp]  ISO 8601；缺省 → 不写该字段
 * @param {object} [opts.message]    伴随该状态的规范 Message（如 input-required 的提问）
 * @returns {{state: string, timestamp?: string, message?: object}}
 */
function buildTaskStatus(internalState, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const status = { state: toA2aState(internalState, o) };
  const ts = typeof o.timestamp === 'string' ? o.timestamp.trim() : '';
  if (ts) status.timestamp = ts;
  if (o.message && typeof o.message === 'object') status.message = o.message;
  return status;
}

/**
 * 自检：本叶子声明的内部状态清单是否**全部**能在映射表里找到。
 * 返回未覆盖清单（空数组 = 全绿）。守卫与单测都用它做回归锁 ——
 * 将来有人给内部状态机加一个状态却忘了映射，这里会立刻报出名字。
 * @returns {string[]}
 */
function unmappedKnownStates() {
  return KNOWN_INTERNAL_STATES.filter((s) => INTERNAL_TO_A2A_STATE[s] === undefined);
}

/**
 * 自检：映射表里的**每一条**目标值都必须是规范合法状态。
 * @returns {Array<{from:string,to:string}>}
 */
function invalidMappingTargets() {
  const bad = [];
  for (const [from, to] of Object.entries(INTERNAL_TO_A2A_STATE)) {
    if (!_STATE_SET.has(to)) bad.push({ from, to });
  }
  return bad;
}

module.exports = {
  A2A_TASK_STATES,
  TERMINAL_TASK_STATES,
  INTERRUPTED_TASK_STATES,
  ALLOWED_TRANSITIONS,
  INTERNAL_TO_A2A_STATE,
  KNOWN_INTERNAL_STATES,
  isStrictTaskStateEnabled,
  toA2aState,
  isInternalTerminal,
  canTransition,
  buildTaskStatus,
  unmappedKnownStates,
  invalidMappingTargets,
};
