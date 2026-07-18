'use strict';

/**
 * rewindResume.js — 纯叶子:让「逐回合回溯(rewind)」跨会话恢复(resume)存活的单一真源。
 *
 * 背景(先核实再动手):khy 已有完整 checkpoint/rewind 栈 —— fileHistoryService(逐文件快照)、
 * checkpointService(整工作区检查点)、rollbackService(四级回退门面)、rewindControl(TUI 双击 ESC
 * 回溯的纯叶子)。**唯一真缺口**不是机制缺失,而是「某条 user 消息 ↔ 该回合前的工作区检查点 id」
 * 这条链接只活在内存:rewindControl.patchUserCheckpointId 把 id 盖在 ai._messages 的 user 消息上,
 * 但这个字段在持久化往返里被三处字段白名单各自丢弃 ——
 *   1) sessionPersistence.appendMessage 写 JSONL 时只取固定字段(无 checkpointId);
 *   2) sessionPersistence.restoreSession 读回时 .map 又是固定白名单(无 checkpointId);
 *   3) ai.resumeSession 装回 _messages 时 .map(m => ({role, content})) 再剥一次。
 * 于是「恢复对话+代码到第 X 条消息」在 resume 后失效,readline 的 `khy rewind <n>` 只能退回
 * 「最近检查点」而非逐回合精确(handlers/rollback.js 此前如实标注了这一降级)。
 *
 * 本叶子是「回溯存活契约」的单一真源:声明哪些消息字段必须随持久化往返(REWIND_PERSIST_FIELDS),
 * 提供把这些字段在「写盘 entry」与「读回 message」间搬运的纯函数(append/restore/resume 三处共用),
 * 并提供 buildRewindPlan —— 给定已解析的回溯目标清单(由 rewindControl.listUserTargets 产出,本叶子
 * **绝不重算名次**,名次语义的单一真源是 rewindControl)与 n,产出精确恢复计划与诚实的「无逐回合 id
 * 则退回最近检查点」标记。
 *
 * 契约:零 IO、确定性(不依赖时钟/随机)、绝不抛(fail-soft)、env 门控 KHY_REWIND_PERSIST 默认开;
 * 关则 carry* 成恒等(字节回退:不写额外字段、不读回额外字段),buildRewindPlan 仍是纯计算照常可用。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  const raw = env && env.KHY_REWIND_PERSIST;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 必须随持久化往返、才能让逐回合回溯在 resume 后存活的消息字段(单一真源)。
 * 新增「回溯所需的、需随会话存活的字段」= 在此加一项,append/restore/resume 三端自动搬运。
 */
const REWIND_PERSIST_FIELDS = Object.freeze(['checkpointId']);

function _present(obj, k) {
  return obj && typeof obj === 'object'
    && Object.prototype.hasOwnProperty.call(obj, k)
    && obj[k] !== undefined && obj[k] !== null && obj[k] !== '';
}

/** 从消息里取出回溯字段(仅含存在者)。纯读、绝不抛。 */
function pickRewindFields(msg) {
  const out = {};
  try {
    for (const k of REWIND_PERSIST_FIELDS) if (_present(msg, k)) out[k] = msg[k];
  } catch { /* fail-soft */ }
  return out;
}

/**
 * 把源对象的回溯字段搬到目标对象(写盘 entry / 读回 message / 装回 _messages),原地改并返回 dst。
 * 门控关 → 恒等(不搬任何字段 = 字节回退到改动前行为)。绝不抛。
 * @param {object} src 源(原始消息 / JSONL entry / 链条目)
 * @param {object} dst 目标(将被写盘或装入运行时的对象)
 * @param {object} [env]
 * @returns {object} dst(便于链式)
 */
function carryRewindFields(src, dst, env = process.env) {
  try {
    if (!dst || typeof dst !== 'object') return dst;
    if (!isEnabled(env)) return dst;
    for (const k of REWIND_PERSIST_FIELDS) if (_present(src, k)) dst[k] = src[k];
  } catch { /* fail-soft */ }
  return dst;
}

/**
 * 给定回溯目标清单(rewindControl.listUserTargets 的输出:从新到旧,每条带 rankFromEnd /
 * checkpointId / content)与 n(回溯到倒数第 n 条 user 回合),产出精确恢复计划。
 * 本叶子绝不重算名次 —— 此处只做选择 + 诚实降级标记。
 *
 * @param {Array<{rankFromEnd?:number, checkpointId?:(string|null), content?:string}>} targets
 * @param {number} n 倒数第 n 条 user 回合(1-based)
 * @returns {{ok:boolean, error?:string, rankFromEnd?:number, checkpointId?:(string|null),
 *            content?:string, hasCheckpoint?:boolean, fallbackToLatest?:boolean}}
 */
function buildRewindPlan(targets, n) {
  const list = Array.isArray(targets) ? targets : [];
  const idx = Math.floor(Number(n));
  if (!Number.isFinite(idx) || idx < 1) {
    return { ok: false, error: '回溯名次必须为 >=1 的整数' };
  }
  if (idx > list.length) {
    return { ok: false, error: `只有 ${list.length} 条可回溯的用户回合` };
  }
  // listUserTargets 已从新到旧排序:倒数第 n 条 = 下标 n-1。
  const t = list[idx - 1] || {};
  const checkpointId = t.checkpointId || null;
  const hasCheckpoint = !!checkpointId;
  return {
    ok: true,
    rankFromEnd: Number(t.rankFromEnd) || idx,
    checkpointId,
    content: String(t.content == null ? '' : t.content),
    hasCheckpoint,
    // 无逐回合 id(老会话 / readline 未盖戳)→ 诚实退回「最近可用检查点」,绝不假装逐回合精确。
    fallbackToLatest: !hasCheckpoint,
  };
}

/** 自描述(给 CLI 帮助 / 文档 / 自检用)。 */
function describeRewindResume() {
  return {
    gate: 'KHY_REWIND_PERSIST',
    fields: REWIND_PERSIST_FIELDS.slice(),
    summary: '让逐回合回溯(rewind)跨会话恢复存活:把「user 消息 ↔ 回合检查点 id」随 JSONL transcript '
      + '往返(append/restore/resume 三端共用本契约),readline `khy rewind <n>` 据此逐回合精确恢复代码;'
      + '缺 id 时诚实退回最近检查点。',
  };
}

module.exports = {
  isEnabled,
  REWIND_PERSIST_FIELDS,
  pickRewindFields,
  carryRewindFields,
  buildRewindPlan,
  describeRewindResume,
};
