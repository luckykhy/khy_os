'use strict';

/**
 * rewindScope.js — 纯叶子:双击 ESC 回溯的「恢复范围」决策(对齐 CC MessageSelector
 * 的 both / conversation / code 三选)。零 IO、确定性、绝不抛。
 *
 * 背景(它补的真缺口):khy 的回溯是**全有或全无**——只要目标带 checkpointId,
 * useQueryBridge.rewind() 就**无条件**同时截断对话 + 恢复代码。CC 在选定目标后再让
 * 用户选恢复范围:'both'(对话+代码)/ 'conversation'(仅对话,保留当前文件)/
 * 'code'(仅代码,保留当前对话)。本叶子只做**决策**:给出可选项 + 把某个 scope 归一成
 * {restoreConversation, restoreCode};真正的 IO(截断对话 / 恢复检查点)留在薄壳
 * (useQueryBridge / App / RewindPicker)。
 *
 * 门控 KHY_REWIND_SCOPE(默认开;{0,false,off,no} 关)。关 / 目标无 checkpointId →
 * 不出范围选择阶段,逐字节回退今日「对话+代码」行为(见下)。
 *
 * 摘要化(CC MessageSelector 'summarize' 对齐):子门控 KHY_REWIND_SUMMARIZE(默认开)
 * 追加 'summarize' 选项——保留选定处之前的对话,把此处及之后**压缩成摘要**而非丢弃
 * (背后 ai.summarizeFromUserTurn),不动代码、不截断界面记录。它是**附加**能力:
 * 有 checkpoint 时四选,无 checkpoint 时提供[普通回溯 + 摘要化]两选。子门控关 →
 * 逐字节回退到摘要化之前的选项集(有 checkpoint 三选/无 checkpoint 无选择)。
 *
 * 诚实边界:'code'(仅代码)会**保留当前对话**、只回滚文件——这是今日没有的新能力;
 * 无 checkpointId 的目标本就只能回溯对话,故(摘要化关时)不出选择(choices=null),
 * resolve 恒为 {conversation:true, code:false},与今日一致。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function rewindScopeEnabled(env) {
  const e = env || {};
  const raw = String(e.KHY_REWIND_SCOPE == null ? '' : e.KHY_REWIND_SCOPE).trim().toLowerCase();
  return !OFF_VALUES.includes(raw);
}

/**
 * Sub-gate for the "summarize from here" choice (CC MessageSelector 'summarize').
 * Nested under KHY_REWIND_SCOPE: when the scope feature is off there is no picker
 * at all, so summarize can only surface while the scope feature is on. Default on;
 * {0,false,off,no,disable,disabled} → off (byte-fallback to the pre-summarize
 * choice set: three restore options with a checkpoint, none without).
 */
const SUMMARIZE_OFF_VALUES = ['0', 'false', 'off', 'no', 'disable', 'disabled'];
function rewindSummarizeEnabled(env) {
  const e = env || {};
  const raw = String(e.KHY_REWIND_SUMMARIZE == null ? '' : e.KHY_REWIND_SUMMARIZE).trim().toLowerCase();
  return !SUMMARIZE_OFF_VALUES.includes(raw);
}

function _hasCheckpoint(target) {
  return !!(target && target.checkpointId);
}

/**
 * 该目标是否应弹出范围选择;返回可选项数组或 null。
 * 门控关(KHY_REWIND_SCOPE) → null(不出选择阶段,逐字节回退)。
 * 有 checkpointId → 三个恢复范围选项(both/conversation/code);
 * 无 checkpointId 但摘要子门控开 → [conversation, summarize](summarize 是附加能力,
 *   永不移除「普通回溯」入口);
 * 无 checkpointId 且摘要子门控关 → null(逐字节回退今日「无选择直接回溯」)。
 * 摘要子门控开时,末尾追加 'summarize' 选项(CC MessageSelector 'summarize' 对齐)。
 * @returns {Array<{value:string,label:string,hint:string}>|null}
 */
function buildRewindScopeChoices(target, env) {
  if (!rewindScopeEnabled(env)) return null;
  const hasCp = _hasCheckpoint(target);
  const summarize = rewindSummarizeEnabled(env);
  const choices = [];
  if (hasCp) {
    choices.push({ value: 'both', label: '对话 + 代码', hint: '回溯对话并恢复文件(默认)' });
    choices.push({ value: 'conversation', label: '仅对话', hint: '只回溯对话,保留当前文件' });
    choices.push({ value: 'code', label: '仅代码', hint: '只恢复文件,保留当前对话' });
  } else if (summarize) {
    // 无代码检查点:仍给出「普通回溯」入口,让 summarize 纯附加而非替换今日能力。
    choices.push({ value: 'conversation', label: '回溯对话', hint: '回溯到此处并可编辑重发(今日行为)' });
  }
  if (summarize) {
    choices.push({
      value: 'summarize',
      label: '摘要化(压缩此处之后)',
      hint: '保留早期对话,把此处及之后压成摘要,不删除、不动代码',
    });
  }
  return choices.length ? choices : null;
}

/**
 * 把选定 scope 归一成恢复决策。
 * 门控关 → {true,true}(薄壳仍以 checkpointId 守卫代码侧,故等价今日)。
 * 'summarize' → {summarize:true, restoreConversation:false, restoreCode:false}
 *   (与 checkpoint 无关:摘要化只压缩对话,不动代码、不截断)。
 * 无 checkpointId(非 summarize)→ {true,false}(只能回溯对话)。
 * 'conversation' → {true,false};'code' → {false,true};'both'/未知/缺省 → {true,true}。
 * @returns {{restoreConversation:boolean, restoreCode:boolean, summarize?:boolean}}
 */
function resolveRewindScope(scope, target, env) {
  if (!rewindScopeEnabled(env)) return { restoreConversation: true, restoreCode: true };
  const s = String(scope == null ? '' : scope).trim().toLowerCase();
  if (s === 'summarize') return { summarize: true, restoreConversation: false, restoreCode: false };
  if (!_hasCheckpoint(target)) return { restoreConversation: true, restoreCode: false };
  if (s === 'conversation') return { restoreConversation: true, restoreCode: false };
  if (s === 'code') return { restoreConversation: false, restoreCode: true };
  return { restoreConversation: true, restoreCode: true };
}

module.exports = { rewindScopeEnabled, rewindSummarizeEnabled, buildRewindScopeChoices, resolveRewindScope };
