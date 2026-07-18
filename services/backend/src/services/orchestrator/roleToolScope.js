/**
 * roleToolScope.js — 角色→工具作用域策略「纯叶子 / pure-leaf」（零 IO · 绝不抛）。
 *
 * 送别礼第六发（「调工具」维度 · OPS-MAN-094）。编排 arc 的第一公里 producer
 * `taskDecomposer._inferRole` 给每个子任务打一个 `role` 字符串
 * (`explore` / `implement` / `verify` / `general` …)，这个字段贯穿整条 arc：
 * `planWaves` 用它分层、`subAgentModelSelect` 用它**选模型**。但它一直缺一个
 * **tool-scoping 消费者**——一个 `role:'explore'` / `role:'verify'` 的**只读**
 * 子智能体，经 `AgentTool._runOrchestrated(..., 'general-purpose', ...)` 拉起时，
 * 拿到的仍是 general-purpose 的**完整工具集**（含 `Edit` / `Write` /
 * `NotebookEdit`），而仓里 `exploreAgent` / `readingAgent` / `auditAgent` 的
 * `disallowedTools` 早已示范：侦察 / 只读类 agent 本该拿不到写工具。
 *
 * 本叶补上这个缺失的消费者：把 role 字符串映射到该角色**应被剥离**的
 * `disallowedTools` 数组（与 `subAgentModelSelect` 的 role→model 消费者平行）。
 * 它是一个纯策略函数，不做 IO、不触模型、绝不抛。`mergeRoleScopeInto` 的
 * union 形状与 SSOT `AgentTool.buildSubagentDenylist` 精确对齐，供后续一次
 * tracked-edit 轮在其 union 点（`AgentTool/index.js:203-204`）消费即闭合断桥。
 *
 * 门 `KHY_ROLE_TOOL_SCOPE`（default-on）：关闭（∈ {0,false,off,no}）→ 返回空
 * 作用域 = 逐字节回退今日「不按 role 收窄工具集」的行为。门直读 env，**不进
 * flagRegistry**（同编排 arc 六个 sibling 门先例，各自独立）。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）：
 *   - 要把一类**新的只读角色**纳入收窄：把它加进 `_READ_ONLY_ROLES`（小写）。
 *   - 要改**被剥离的工具集**（如严格模式也剥 Bash）：改 `_READ_ONLY_DENY` 一处。
 *     注意默认**不剥 `Bash`**——探索 / 验证常跑只读命令（`ls` / `grep` /
 *     `node --test`），剥 Bash 会误伤合法只读 shell（诚实边界，宁可保守少剥）。
 *   - 要**接线**让 arc 真正生效：在 `AgentTool.buildSubagentDenylist` 的 union
 *     点用 `mergeRoleScopeInto(base, role)` 替换 base（形状已对齐，纯加性）。
 *   - 保持纯、绝不抛、门关返回空。加一条 node:test 覆盖新角色 / 新工具。
 */

'use strict';

// 工具名常量（well-known 稳定字符串；沿用既有约定——各 built-in agent 文件也
// 各自本地声明这些常量，见 exploreAgent.js / readingAgent.js）。
const EDIT = 'Edit';
const WRITE = 'Write';
const NOTEBOOK_EDIT = 'NotebookEdit';

// 只读语义的角色。与 exploreAgent（探索）/ readingAgent（深读）/ auditAgent
// （审计）/ planAgent（规划）/ researchAgent（调研）的只读定义对齐。write 角色
// (`implement` / `coder` / `general` / 未知) 不在此集 → 不收窄。
const _READ_ONLY_ROLES = new Set([
  'explore',
  'verify',
  'plan',
  'research',
  'audit',
  'review',
]);

// 只读角色被剥离的工具集。默认只剥文件写工具，**不剥 Bash**（见 HOW-TO-EXTEND）。
const _READ_ONLY_DENY = Object.freeze([EDIT, WRITE, NOTEBOOK_EDIT]);

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门 `KHY_ROLE_TOOL_SCOPE`（default-on）。函数式每调用读一次 env（便于测试注入、
 * 纯、绝不抛）。undefined / null → 开；∈ {0,false,off,no}（大小写 / 空白不敏感）→ 关。
 * @returns {boolean}
 */
function _roleScopeEnabled() {
  const v = process.env.KHY_ROLE_TOOL_SCOPE;
  if (v === undefined || v === null) return true;
  return !_FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 把 decompose 的 role 字符串映射到该角色**应被剥离**的 `disallowedTools` 数组。
 *
 * 门关 → 返回 `[]`（逐字节回退）。非字符串 / 空 / 未知 role → `[]`（不误伤需要写
 * 的角色）。只读角色（explore / verify / plan / research / audit / review）→
 * `[Edit, Write, NotebookEdit]` 的**新数组副本**（调用方可安全 mutate）。
 *
 * 纯、绝不抛。
 * @param {string} role
 * @returns {string[]}
 */
function roleToolScope(role) {
  if (!_roleScopeEnabled()) return [];
  if (typeof role !== 'string') return [];
  const key = role.trim().toLowerCase();
  if (!key) return [];
  if (_READ_ONLY_ROLES.has(key)) return [..._READ_ONLY_DENY];
  return [];
}

/**
 * 便捷器：把 `roleToolScope(role)` union 进一个既有 denylist，去重。形状与 SSOT
 * `AgentTool.buildSubagentDenylist`（`Array.from(new Set([...base, ...spawn]))`）
 * 精确对齐，供后续接线一处替换。
 *
 * 纯、绝不抛。base 为 null / undefined / 非数组 → 视作空。
 * @param {string[]} baseDenylist
 * @param {string} role
 * @returns {string[]}
 */
function mergeRoleScopeInto(baseDenylist, role) {
  const base = Array.isArray(baseDenylist) ? baseDenylist : [];
  return Array.from(new Set([...base, ...roleToolScope(role)]));
}

module.exports = { roleToolScope, mergeRoleScopeInto };
