'use strict';

/**
 * sessionForkPlan.js — `/fork` 的「会话分叉规划」零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;源会话快照 / 标题 / 时间戳全经入参注入,
 * 本叶子绝不读 process.env、绝不触文件、绝不 spawn、绝不调 Date、绝不调 crypto。
 *
 * 背后的逻辑(对齐 Claude Code /fork):CC 的 /fork 把当前对话**复制成一份独立副本**,让你在
 * 不污染原会话的前提下探索一条岔路。khy 的等价能力早已齐备:sessionPersistence.restoreSession
 * 重建源会话消息链,persistSession(任意/新 id, state) 把消息物化成一份全新的 JSONL transcript +
 * JSON 快照,ai.resumePersistedSession 把 live REPL 切到该新会话(原会话在盘上原封不动)。
 * 本叶子只负责其中**纯确定性**那块 —— 把「源快照 → 该写进新分叉的 state」算出来:
 *   - parseForkArgs(args)
 *       → { title, leafUuid, valid, parseError }  —— 解析 `[--at <leafUuid>] [<title...>]`
 *   - deriveForkTitle(sourceTitle, explicitTitle)
 *       → 新分叉标题(显式优先;否则源标题 + " (fork)";源也空 → "Forked session")
 *   - buildForkState({ snapshot, title, forkedAt })
 *       → { title, model, messages[], metadata } | null  —— 喂给 persistSession 的 state
 *
 * **关键正确性**:源快照消息带着原会话的 uuid / parentUuid / timestamp / _khyTrace。若原样交给
 * persistSession,appendMessage 会因 `msg.uuid || _uuid()` **复用原 uuid** → 两个会话共享 uuid +
 * 溯源哈希链串味。故 buildForkState **剥离** uuid/parentUuid/timestamp/_khyTrace/_khyProvenance,
 * 只留 role/content + isMeta/isCompactSummary 旗标,让新分叉**自己铸链**(干净独立的 transcript)。
 *
 * 真正的 IO(restoreSession 读盘、persistSession 写盘、resumePersistedSession 切 live、回显)在薄壳
 * handlers/fork.js;本叶子只算。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。
 * 本叶子零依赖。
 */

const _FORK_SUFFIX = ' (fork)';
const _DEFAULT_FORK_TITLE = 'Forked session';
const _MAX_TITLE_LEN = 200;

/**
 * 解析 /fork 参数:`[--at <leafUuid>] [<title...>]`。
 * `--at`/`-a` 后接一个 leaf uuid(从某分支末端分叉);其余拼成显式标题。
 * @param {string[]} [args]
 * @returns {{ title:string, leafUuid:string|null, valid:boolean, parseError:string|null }}
 */
function parseForkArgs(args) {
  const list = Array.isArray(args) ? args.map((a) => String(a == null ? '' : a)) : [];
  let leafUuid = null;
  const titleParts = [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (tok === '--at' || tok === '-a' || tok === '--from') {
      const next = list[i + 1];
      if (next == null || next === '' || next.startsWith('-')) {
        return { title: '', leafUuid: null, valid: false, parseError: 'missing_leaf_uuid' };
      }
      leafUuid = next;
      i += 1;
      continue;
    }
    if (tok.startsWith('--at=')) {
      const v = tok.slice('--at='.length);
      if (!v) return { title: '', leafUuid: null, valid: false, parseError: 'missing_leaf_uuid' };
      leafUuid = v;
      continue;
    }
    titleParts.push(tok);
  }
  const title = titleParts.join(' ').trim();
  return { title, leafUuid, valid: true, parseError: null };
}

/**
 * 推导分叉标题:显式优先;否则源标题 + " (fork)";源也空 → 默认。已带 " (fork)" 后缀的源不重复叠加。
 * @param {string} sourceTitle
 * @param {string} [explicitTitle]
 * @returns {string}
 */
function deriveForkTitle(sourceTitle, explicitTitle) {
  const explicit = String(explicitTitle == null ? '' : explicitTitle).trim();
  if (explicit) return explicit.slice(0, _MAX_TITLE_LEN);
  const base = String(sourceTitle == null ? '' : sourceTitle).trim();
  if (!base) return _DEFAULT_FORK_TITLE;
  if (base.endsWith(_FORK_SUFFIX)) return base.slice(0, _MAX_TITLE_LEN);
  return (base + _FORK_SUFFIX).slice(0, _MAX_TITLE_LEN);
}

/**
 * 把源会话消息**净化**成可独立铸链的副本:剥离会话身份(uuid/parentUuid/timestamp)与溯源
 * (_khyTrace/_khyProvenance),只保留 role/content + 语义旗标。让新分叉的 appendMessage 自己铸链。
 * @param {Array<object>} messages
 * @returns {Array<{role:string, content:*, isMeta?:boolean, isCompactSummary?:boolean}>}
 */
function _sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const clean = { role: m.role || 'unknown', content: m.content == null ? '' : m.content };
    if (m.isMeta) clean.isMeta = true;
    if (m.isCompactSummary) clean.isCompactSummary = true;
    out.push(clean);
  }
  return out;
}

/**
 * 从源会话快照构造写入新分叉的 state。空/无消息 → null(由薄壳友好报错,绝不写空会话)。
 * @param {object} params
 * @param {object} params.snapshot   restoreSession 返回的对象({ title, model, messages, metadata, ... })
 * @param {string} [params.title]    显式分叉标题(可空,走 deriveForkTitle)
 * @param {number} [params.forkedAt] 分叉时刻(薄壳注入 Date.now();纯叶子不调 Date)
 * @returns {{ title:string, model:string, messages:Array, metadata:object }|null}
 */
function buildForkState(params) {
  const p = params || {};
  const snap = p.snapshot;
  if (!snap || typeof snap !== 'object') return null;
  const messages = _sanitizeMessages(snap.messages);
  if (messages.length === 0) return null;

  const title = deriveForkTitle(snap.title, p.title);
  const baseMeta = (snap.metadata && typeof snap.metadata === 'object') ? snap.metadata : {};
  const metadata = Object.assign({}, baseMeta, {
    forkedFrom: snap.sessionId || (baseMeta.forkedFrom || null),
  });
  if (Number.isFinite(p.forkedAt)) metadata.forkedAt = p.forkedAt;

  // 刀 2:fork 槽继承(对齐 Stello policy none|inherit|compress)。仅当薄壳**显式**传入
  // p.slots.enabled 时生效;否则字节回退(KHY_SESSION_SLOTS=0 或未接线 → legacy 行为不变)。
  // 关键修正:不接线时上面的 baseMeta 展开会把父节点的 insight(一次性收件箱)/memory(外向
  // 摘要)原样复制给子分支——这违反 Stello 语义(子分支应空收件箱 + 自产外向摘要)。
  if (p.slots && p.slots.enabled) {
    _applyForkSlots(metadata, p.slots);
  }

  return {
    title,
    model: snap.model || '',
    messages,
    metadata,
  };
}

/**
 * 按策略整理 fork 子节点的三槽(就地改 metadata;调用方已确认 slots.enabled)。
 *   - insight 一次性收件箱属**源**节点,子分支恒从空开始(绝不继承父的待读 insight)。
 *   - memory  外向摘要由子分支**自身** history 蒸馏而来,绝不冒领父的(恒清空)。
 *   - systemPrompt:none → 清空;inherit/compress → 薄壳若已 mergeSystemPrompt 传入则用之,
 *     否则保留 baseMeta 里继承到的(若有)。compress 无 LLM 时诚实退化为 inherit。
 * @param {object} metadata 就地修改
 * @param {{policy?:string, systemPrompt?:string}} slotOpt
 */
function _applyForkSlots(metadata, slotOpt) {
  const policy = String(slotOpt.policy || 'inherit').toLowerCase();
  delete metadata.insight;
  delete metadata.memory;
  if (policy === 'none') {
    delete metadata.systemPrompt;
  } else if (typeof slotOpt.systemPrompt === 'string' && slotOpt.systemPrompt) {
    metadata.systemPrompt = slotOpt.systemPrompt;
  }
}

/**
 * 门控:KHY_FORK 默认开。falsy(0/false/off/no/空)→ 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_FORK === undefined ? 'true' : e.KHY_FORK;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

module.exports = {
  parseForkArgs,
  deriveForkTitle,
  buildForkState,
  isEnabled,
  // 暴露常量便于测试钉死。
  _FORK_SUFFIX,
  _DEFAULT_FORK_TITLE,
  _MAX_TITLE_LEN,
};
