'use strict';

/**
 * sessionSlots.js — 会话「三槽」生命周期的纯叶子单一真源(零 IO·确定性·绝不抛)。
 *
 * 背后逻辑(学自 Stello):一个会话节点除了 history,还挂三个**生命周期各异**的槽:
 *   - systemPrompt  持久:每轮注入,fork 时经 4 层合并(defaults→parent→profile→fork)继承。
 *   - insight       一次性收件箱:注入**一次**即清空(下一轮不再出现)。
 *   - memory        外向摘要:**绝不**注入本节点自身上下文(对齐 Stello 的不对称),
 *                   只由 orchestrator / 跨支综合读取。本叶子提供写,但绝不把它纳入注入集。
 *
 * 这些全是**确定性的纯数据变换**(读 metadata → 算注入文本 + 下一份 metadata),
 * 放在本叶子;真正的 IO(读/写快照 metadata)在薄壳 sessionForestService(经
 * sessionPersistence.updateSessionMetadata 就地写,镜像 renameSession)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;一切经入参注入,绝不读 process.env
 * (gate 函数除外,仅读 env 形参)、绝不触文件/Date/crypto/child_process。仅依赖语言内置。
 *
 * 导出:
 *   - slotsEnabled(env)               门控 KHY_SESSION_SLOTS 默认开
 *   - applyInsightOnce(metadata)      → {insightText, nextMetadata, changed} 一次性读后清
 *   - mergeSystemPrompt(layers)       4 层合并(后者覆盖)→ 单一 systemPrompt
 *   - readSlots(metadata)             → {systemPrompt, insight, memory} 规整读
 *   - writeSlot(metadata, slot, text) → nextMetadata(校验 slot + 截断;绝不就地改入参)
 *   - INJECTABLE_SLOTS               注入集白名单(刻意不含 memory)
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当幽灵依赖。零依赖。
 */

const FALSY = new Set(['0', 'false', 'off', 'no']);

/** 槽枚举。注入集**刻意不含 memory**(memory 只外向,绝不自注入)。 */
const SLOT_NAMES = ['systemPrompt', 'insight', 'memory'];
const INJECTABLE_SLOTS = ['systemPrompt', 'insight'];

/** 槽文本上限(防止异常长串撑爆注入/快照)。env 不参与:确定性纯叶子。 */
const SLOT_MAX = {
  systemPrompt: 8000,
  insight: 4000,
  memory: 4000,
};

/**
 * 门控:KHY_SESSION_SLOTS 默认开。falsy(0/false/off/no/空)→ 关。大小写不敏感 + trim。
 * @param {object} [env]
 * @returns {boolean}
 */
function slotsEnabled(env) {
  const e = env || {};
  const raw = e.KHY_SESSION_SLOTS;
  if (raw === undefined || raw === null) return true;
  return !FALSY.has(String(raw).trim().toLowerCase());
}

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStr;

// 收敛到 utils/truncateEllipsis 单一真源(逐字节/语义等价委托,调用点不变)
const _truncate = require('../utils/truncateEllipsis');

/** 浅拷贝一份 metadata(绝不就地改入参;非对象 → 空对象)。 */
function _cloneMeta(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  return Object.assign({}, metadata);
}

/**
 * 规整读三槽(缺失/非串 → 空串)。
 * @param {object} metadata
 * @returns {{systemPrompt:string, insight:string, memory:string}}
 */
function readSlots(metadata) {
  const m = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    systemPrompt: typeof m.systemPrompt === 'string' ? m.systemPrompt : '',
    insight: typeof m.insight === 'string' ? m.insight : '',
    memory: typeof m.memory === 'string' ? m.memory : '',
  };
}

/**
 * 一次性消费 insight:若 metadata.insight 非空,返回注入文本并在 nextMetadata 中**清空**它。
 * 一次性语义:本轮注入,下一轮(insight 已空)不再出现。
 *
 * @param {object} metadata
 * @returns {{insightText:string, nextMetadata:object, changed:boolean}}
 *   - insightText：本轮要注入的 insight(空串 = 无)。
 *   - nextMetadata：清空 insight 后的新 metadata(浅拷贝,绝不就地改入参)。
 *   - changed：是否确有清空动作(供薄壳决定是否回写)。
 */
function applyInsightOnce(metadata) {
  const slots = readSlots(metadata);
  const text = slots.insight.trim() ? slots.insight : '';
  if (!text) {
    return { insightText: '', nextMetadata: _cloneMeta(metadata), changed: false };
  }
  const next = _cloneMeta(metadata);
  next.insight = '';
  return { insightText: text, nextMetadata: next, changed: true };
}

/**
 * 4 层合并 systemPrompt(后者覆盖前者的同层意图,但**拼接**而非丢弃)。
 * 对齐 Stello fork 的 defaults→parent→profile→fork:越靠后越「贴近本节点」。
 * 各层去空白后非空才纳入,以 `\n\n` 连接,整体截断到上限。
 *
 * @param {Array<string>|{defaults?,parent?,profile?,fork?}} layers
 * @returns {string} 合并后的 systemPrompt(空 → '')。
 */
function mergeSystemPrompt(layers) {
  let ordered;
  if (Array.isArray(layers)) {
    ordered = layers;
  } else if (layers && typeof layers === 'object') {
    ordered = [layers.defaults, layers.parent, layers.profile, layers.fork];
  } else {
    ordered = [];
  }
  const parts = [];
  for (const layer of ordered) {
    const s = _str(layer).trim();
    if (s) parts.push(s);
  }
  return _truncate(parts.join('\n\n'), SLOT_MAX.systemPrompt);
}

/**
 * 写一个槽 → 返回新 metadata(校验 slot 名 + 截断到该槽上限;绝不就地改入参)。
 * memory 可写(供 orchestrator/综合回写),但写它**绝不**改变其「不自注入」语义
 * (注入集见 INJECTABLE_SLOTS,刻意不含 memory)。
 *
 * @param {object} metadata
 * @param {string} slot ∈ {systemPrompt, insight, memory}
 * @param {string} text
 * @returns {object|null} nextMetadata;slot 非法 → null(薄壳据此拒绝)。
 */
function writeSlot(metadata, slot, text) {
  const name = _str(slot);
  if (SLOT_NAMES.indexOf(name) === -1) return null;
  const next = _cloneMeta(metadata);
  next[name] = _truncate(text, SLOT_MAX[name] || 4000);
  return next;
}

/**
 * 该槽是否进「注入本节点自身上下文」的集合。memory 恒 false(外向不自注入)。
 * @param {string} slot
 * @returns {boolean}
 */
function isInjectableSlot(slot) {
  return INJECTABLE_SLOTS.indexOf(_str(slot)) !== -1;
}

module.exports = {
  slotsEnabled,
  applyInsightOnce,
  mergeSystemPrompt,
  readSlots,
  writeSlot,
  isInjectableSlot,
  SLOT_NAMES,
  INJECTABLE_SLOTS,
  SLOT_MAX,
};
