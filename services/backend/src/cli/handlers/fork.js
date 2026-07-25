'use strict';

/**
 * fork.js — `/fork` 命令薄壳:把当前对话分叉成一份独立副本,切到副本继续探索(原会话不动)。
 *
 * 对齐 Claude Code 的 /fork(复制当前对话 → 新独立会话 → 切过去)。**背后逻辑**(净化消息身份、
 * 推导分叉标题、构造写入 state)在纯叶子 sessionForkPlan.js(单一真源);本薄壳只做 IO:
 *   1. 解析源会话(当前 live session;无 live → 当前项目最近一条持久会话);
 *   2. restoreSession 读源快照(可选 --at <leafUuid> 从某分支末端分叉);
 *   3. buildForkState 算出净化后的 state(剥离 uuid/parentUuid/_khyTrace → 新分叉自己铸链);
 *   4. persistSession(null, state) 物化成一份全新 JSONL + JSON 快照(persistSession 自铸新 id);
 *   5. resumePersistedSession(newId) 把 live REPL 切到分叉(仅交互模式生效)。
 *
 * **复用既有不另起炉灶**:read=sessionPersistence.restoreSession;write=sessionPersistence.persistSession;
 * 切 live=ai.resumePersistedSession(同 `session resume`);live id=ai.getLiveSessionId。均既有导出,
 * 绝不另写会话读写/切换。原会话在盘上**原封不动**(只新增一份副本)。
 *
 * 用法:`/fork [--at <leafUuid>] [<新标题...>]`。门控 KHY_FORK 默认开;关 → 命令不接管(字节回退)。
 */

const { printInfo, printError, printSuccess, printWarn } = require('../formatters');
const leaf = require('../../services/session/sessionForkPlan');

function _persistence() {
  return require('../../services/sessionPersistence');
}

/** 解析源会话 id:优先当前 live session;否则当前项目作用域最近一条。返回 {sessionId, fromLive} 或 null。 */
function _resolveSource() {
  let liveId = null;
  try {
    const ai = require('../ai');
    liveId = ai.getLiveSessionId && ai.getLiveSessionId();
  } catch { /* fall through */ }
  if (liveId) return { sessionId: liveId, fromLive: true };

  // 无 live(尚未持久化任何 turn,或非交互态):退最近一条持久会话(当前项目优先)。
  try {
    const sp = _persistence();
    const all = sp.listPersistedSessions({ limit: 200 });
    if (Array.isArray(all) && all.length > 0) {
      const cwd = process.cwd();
      const scoped = all.filter((s) => s && s.cwd === cwd);
      const pick = (scoped.length > 0 ? scoped : all)[0];
      if (pick && pick.sessionId) return { sessionId: pick.sessionId, fromLive: false };
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * @param {string} _subCommand 预留(无子命令)
 * @param {string[]} [args] `[--at <leafUuid>] [<title...>]`
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
async function handleFork(_subCommand, args = [], options = {}) {
  if (!leaf.isEnabled(process.env)) {
    printInfo('fork 命令未启用(KHY_FORK=off)。');
    return false;
  }

  const parsed = leaf.parseForkArgs(args);
  if (!parsed.valid) {
    printError('用法: /fork [--at <leafUuid>] [<新标题>]');
    return true;
  }

  const source = _resolveSource();
  if (!source) {
    printError('没有可分叉的会话(尚无 live 会话,且当前项目暂无已保存会话)。');
    return true;
  }

  const sp = _persistence();
  const restoreOpts = parsed.leafUuid ? { leafUuid: parsed.leafUuid } : {};
  const snapshot = sp.restoreSession(source.sessionId, restoreOpts);
  if (!snapshot || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0) {
    printError(parsed.leafUuid
      ? '指定的 --at 分支末端无可分叉的消息(uuid 不存在或链为空)。'
      : '源会话没有可分叉的消息(快照为空或不存在)。');
    return true;
  }

  const state = leaf.buildForkState({
    snapshot,
    title: parsed.title,
    forkedAt: Date.now(), // 时刻由薄壳注入,纯叶子不调 Date
    // 刀 2:三槽 fork 继承。门控 KHY_SESSION_SLOTS 默认开;关 → 不传 enabled → 字节回退
    // (legacy:baseMeta 原样展开)。默认 policy=inherit:保留父 systemPrompt,但**恒清空**
    // 子的 insight(一次性收件箱属源)与 memory(外向摘要由子自身蒸馏,绝不冒领父的)。
    slots: (() => {
      try {
        const slots = require('../sessionSlots');
        if (!slots.slotsEnabled(process.env)) return undefined;
        return { enabled: true, policy: 'inherit' };
      } catch { return undefined; }
    })(),
  });
  if (!state) {
    printError('无法构造分叉(源会话无有效消息)。');
    return true;
  }

  let newId;
  try {
    newId = sp.persistSession(null, state); // null → persistSession 自铸新 id
  } catch (e) {
    printError(`分叉失败(写入新会话出错): ${e && e.message ? e.message : 'unknown'}`);
    return true;
  }

  const shortNew = String(newId).slice(0, 12);
  const shortSrc = String(source.sessionId).slice(0, 12);
  printSuccess(`已分叉「${state.title}」(${state.messages.length} 条消息) · ${shortSrc} → ${shortNew}`);
  printInfo(`原会话 ${shortSrc} 原封不动;分叉是一份独立副本。`);

  // 切 live REPL 到分叉(仅交互模式真生效;复用 ai.resumePersistedSession 同 `session resume`)。
  let switched = false;
  try {
    const ai = require('../ai');
    const r = ai.resumePersistedSession(newId);
    switched = !!(r && r.success);
    if (!switched && r && r.error) {
      printWarn(`切换到分叉失败: ${r.error}(分叉已保存,可用 \`session resume ${shortNew}\` 手动切换)。`);
    }
  } catch (e) {
    printWarn(`切换到分叉失败: ${e && e.message ? e.message : 'unknown'}(分叉已保存)。`);
  }

  if (switched) {
    if (process.env.KHY_REPL_ACTIVE === '1') {
      printInfo('已切到分叉,可直接继续对话;后续消息只写入分叉,不影响原会话。');
    } else {
      printWarn('切换仅在交互式会话 (REPL) 中生效;请在 `khy` 交互模式下使用 `/fork`。');
    }
  }

  return true;
}

module.exports = { handleFork };
