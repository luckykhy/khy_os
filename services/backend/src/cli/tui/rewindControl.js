'use strict';

/**
 * rewindControl.js — 「Khy ESC/Ctrl+C 对齐 Claude Code」中双击 ESC 回溯(rewind)的单一真源。
 *
 * Goal (2026-06-25): 对齐 Claude Code 的招牌 ESC 行为——空闲时双击 ESC 进入「回溯」:
 *   跳回某条历史用户消息,截断该点之后的对话(UI + 后端 ai._messages),并(可选)恢复
 *   磁盘文件到那一回合之前,再把那条消息文本回填输入框供编辑重发。
 *
 * 设计同 services/query/activeAssist.js / inertialContinuation.js:纯叶子,env 门控(默认开),
 * 冻结 RULES 文档化「何时回溯 / 何时让位」,只做判定,绝不发起 React/IO;任何错误 fail-soft
 * 回落今天行为(仅对话回溯,或无操作)。React 与 IO 胶水留在 App.js / useQueryBridge.js。
 */

const REWIND_FLAG = 'KHY_ESC_REWIND';            // 主闸:双击 ESC 回溯,默认开
const CHECKPOINT_FLAG = 'KHY_TUI_TURN_CHECKPOINT'; // 每轮前自动检查点(代码回溯前提),默认开
const HINT_FLAG = 'KHY_ESC_REWIND_HINT';         // 显示子闸:可恢复错误后附「双击 Esc 回溯」提示,默认开

// 「双击 Esc 回到上一条消息编辑后重试」的一行提示——对齐 Claude Code errors.ts 里
// 那句 "Double press esc to go back and edit your message and try again"。措辞与
// performRewind 成功后的「可编辑后重发」一致(诚实:回溯确实会把该消息回填输入框)。
const ESC_REWIND_HINT_TEXT = '提示：双击 Esc 可回到上一条消息，编辑后重试。';

// 「编辑消息即可自救」的可恢复错误类(镜像 CC errors.ts 会附该提示的那组:请求/图片/内容
// 过大 · 过载/限流 529/429 · 超时 · 瞬时网络)。刻意**不含** auth/权限/无效 key——那类改
// 消息没用(CC 亦另引导 /login),也不含语法/工具执行错误(那不是「上一条用户消息」的锅)。
const _RECOVERABLE_HINT_RE = new RegExp(
  [
    'too large', '过大', '太大', 'payload_too_large', 'request too large',
    'too many tokens', 'prompt[_\\s-]?too[_\\s-]?long', 'context[_\\s-]?length', 'maximum context',
    'rate[_\\s-]?limit', '限流', '频率', 'too many requests', 'overloaded', '过载',
    '\\b429\\b', '\\b529\\b',
    'timed out', 'timeout', '超时', 'etimedout', 'econnreset', 'econnrefused',
    'network', '网络', 'temporarily', '稍后重试', '请重试',
  ].join('|'),
  'i',
);

/**
 * env 门控惯例(同 activeAssist.flagOn):默认开,仅显式 0/false/off/no 关。
 * @param {string} flag
 * @returns {boolean}
 */
function flagOn(flag) {
  const v = String(process.env[flag] == null ? '' : process.env[flag]).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 主闸:双击 ESC 回溯是否启用。 */
function isRewindEnabled() { return flagOn(REWIND_FLAG); }
/** 每轮前检查点子闸(代码回溯的前提;关掉则只能对话回溯)。 */
function turnCheckpointEnabled() { return flagOn(CHECKPOINT_FLAG); }

/**
 * 可恢复错误后是否给用户一行「双击 Esc 回溯」提示——纯判定,env 门控默认开。
 * @param {object} [env] 注入的 env(便于测试);缺省读 process.env
 * @returns {boolean}
 */
function escRewindHintEnabled(env) {
  const src = env || (typeof process !== 'undefined' ? process.env : {});
  const v = String(src[HINT_FLAG] == null ? '' : src[HINT_FLAG]).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 给一条「回合失败」的用户面错误,决定是否附「双击 Esc 回溯并编辑重试」提示。
 * 对齐 Claude Code errors.ts:只在**交互式**会话、**可恢复且改消息即可自救**的错误类上追加,
 * 且**仅当双击 ESC 回溯 affordance 真的启用时**才提示(否则会指向不存在的操作 = 不诚实)。
 *
 * 纯函数、零 IO、绝不抛。所有事实由参数注入。
 *
 * @param {string} errorText            错误文案(已脱敏的用户面串)
 * @param {object} p
 * @param {boolean} p.rewindEnabled     双击 ESC 回溯是否启用(isRewindEnabled())
 * @param {boolean} p.interactive       是否交互式 TTY(非交互→双击 ESC 不可用,镜像 CC getIsNonInteractiveSession)
 * @param {object}  [p.env]             门控 env(测试注入)
 * @returns {string|null}               一行提示,或 null(门控关/非交互/回溯未启用/非可恢复类/坏输入)
 */
function buildEscRewindHint(errorText, { rewindEnabled, interactive, env } = {}) {
  try {
    if (!escRewindHintEnabled(env)) return null;   // 显示子闸关
    if (!rewindEnabled) return null;               // 回溯未启用 → 抑制(诚实耦合)
    if (!interactive) return null;                 // 非交互 → 双击 ESC 不可用
    const text = String(errorText == null ? '' : errorText);
    if (!text.trim()) return null;
    if (!_RECOVERABLE_HINT_RE.test(text)) return null; // 仅「改消息即可自救」的可恢复类
    return ESC_REWIND_HINT_TEXT;
  } catch {
    return null;
  }
}

/**
 * 空闲态 ESC 的单源裁决——把「清空草稿 / 回溯」两套双击语义的冲突收成一个纯函数。
 * 调用方(App.js)负责先处理忙时中断,本函数只管空闲分支。次序与既有实现一致:
 * vim 拥有 ESC > 先清附加图片 > 有草稿走清空 > 空行走回溯。
 *
 * @param {object} p
 * @param {boolean} p.vimEnabled       vim 模式开(ESC 归编辑器)
 * @param {number}  p.pendingImagesLen 已暂存的待发图片数
 * @param {string}  p.value            输入框当前文本
 * @param {boolean} p.withinWindow     距上次 ESC 是否在双击窗口内(now - escAt < DOUBLE_PRESS_MS)
 * @param {boolean} p.rewindEnabled    回溯是否启用(isRewindEnabled())
 * @returns {'vim'|'drop-images'|'clear-input'|'arm-clear'|'open-rewind'|'arm-rewind'|'noop'}
 */
function decideEscIdle({ vimEnabled, pendingImagesLen, value, withinWindow, rewindEnabled } = {}) {
  if (vimEnabled) return 'vim';
  if (Number(pendingImagesLen) > 0) return 'drop-images';
  const hasDraft = String(value == null ? '' : value).length > 0;
  if (hasDraft) {
    // 有草稿:保持今天行为——双击清空 / 单击 arm。回溯绝不劫持非空输入框(护草稿)。
    return withinWindow ? 'clear-input' : 'arm-clear';
  }
  // 空行:回溯启用时双击进回溯;否则维持今天的无操作。
  if (!rewindEnabled) return 'noop';
  return withinWindow ? 'open-rewind' : 'arm-rewind';
}

/**
 * 某条 UI 消息在「user 角色消息」里从末尾数的名次(1-based)。
 * UI 每条 user 回合与后端 ai._messages 的 user 消息 1:1 有序对应,故此名次是跨两存储的稳定键。
 * messages[idx] 必须是 user 角色,否则返回 0(无效)。
 *
 * @param {Array<{role?:string}>} messages
 * @param {number} idx
 * @returns {number} >=1 名次,或 0 表示无效
 */
function userTurnRankFromEnd(messages, idx) {
  if (!Array.isArray(messages)) return 0;
  const i = Math.floor(Number(idx));
  if (!Number.isFinite(i) || i < 0 || i >= messages.length) return 0;
  if (String(messages[i] && messages[i].role || '').toLowerCase() !== 'user') return 0;
  let rank = 0;
  for (let k = messages.length - 1; k >= i; k--) {
    if (String(messages[k] && messages[k].role || '').toLowerCase() === 'user') rank++;
  }
  return rank;
}

/**
 * Phase1 回溯目标:最后一条 user 回合。无 user 消息则返回 null。
 * @param {Array<object>} messages
 * @returns {{idx:number, content:string, checkpointId:(string|null), rankFromEnd:number}|null}
 */
function selectLastUserTarget(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && String(m.role || '').toLowerCase() === 'user') {
      return {
        idx: i,
        content: String(m.content == null ? '' : m.content),
        checkpointId: m.checkpointId || null,
        rankFromEnd: 1,
      };
    }
  }
  return null;
}

/**
 * Phase2 回溯选择器的目标清单:全部 user 回合,**从新到旧**排序(最近的在最前),
 * 每条带 idx / 截断预览 content / checkpointId / rankFromEnd。无 user 消息则返回 []。
 * 选择器(RewindPicker)纯展示本清单,选中某条即把该 target 交回 performRewind,
 * 与 Phase1 selectLastUserTarget 走同一条回溯管线(rankFromEnd 是跨两存储稳定键)。
 *
 * @param {Array<object>} messages
 * @param {number} [previewLen=80] 预览文本最大字符数(超出截断加省略号)
 * @returns {Array<{idx:number, content:string, preview:string, checkpointId:(string|null), rankFromEnd:number}>}
 */
function listUserTargets(messages, previewLen = 80) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  let rank = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || String(m.role || '').toLowerCase() !== 'user') continue;
    rank += 1;
    const content = String(m.content == null ? '' : m.content);
    const flat = content.replace(/\s+/g, ' ').trim();
    const lim = Math.max(8, Math.floor(Number(previewLen)) || 80);
    const preview = flat.length > lim ? `${flat.slice(0, lim - 1)}…` : flat;
    out.push({ idx: i, content, preview, checkpointId: m.checkpointId || null, rankFromEnd: rank });
  }
  return out;
}

/**
 * 把某次轮次前检查点的 id 不可变地回填到对应 user 消息(按 timestamp 匹配)。
 * 返回新数组;无匹配则原样返回(引用可不变,调用方据此免去多余渲染亦可)。
 *
 * @param {Array<object>} messages
 * @param {*} timestamp  push 该 user 消息时用的 startTime
 * @param {string} id    saveCheckpoint 返回的 checkpoint id
 * @returns {Array<object>}
 */
function patchUserCheckpointId(messages, timestamp, id) {
  if (!Array.isArray(messages) || !id) return messages;
  let patched = false;
  const next = messages.map((m) => {
    if (!patched && m && String(m.role || '').toLowerCase() === 'user' && m.timestamp === timestamp) {
      patched = true;
      return { ...m, checkpointId: id };
    }
    return m;
  });
  return patched ? next : messages;
}

// ── RULES:何时回溯 / 何时让位(冻结,文档即契约)──────────────────────────
const RULES = Object.freeze({
  R1_esc_busy:
    'ESC 在忙时只中断当前轮次,永不退出、永不回溯(由 App.js 在调用本模块前处理)。',
  R2_double_esc_idle:
    '空闲且输入框为空时,双击 ESC(窗口内第二次)进入回溯;首击仅 arm 提示「再按一次 Esc 回溯对话」。',
  R3_draft_never_rewind:
    '输入框有草稿时,ESC 维持今天的清空语义(双击清空 / 单击 arm),回溯绝不劫持草稿。',
  R4_vim_owns_esc:
    'vim 模式下 ESC 归编辑器(INSERT→NORMAL / 取消),回溯经 ESC 不可达,降级用 /rewind。',
  R5_rewind_pipeline:
    '回溯 = 后端 ai.rewindToUserTurn(rankFromEnd) 截断 _messages + 可选 restoreCheckpoint 恢复代码'
    + ' + UI setMessages(slice(0,idx)) + textInput.setText(content) 回填;任一步失败 fail-soft 退化为仅对话回溯。',
  R6_gates:
    'KHY_ESC_REWIND(主闸)/ KHY_TUI_TURN_CHECKPOINT(每轮检查点,代码回溯前提)默认开,仅 0/false/off/no 关。',
  R7_error_hint:
    '回合以「可恢复且改消息即可自救」的错误类失败时(过大/限流/过载/超时/网络),交互式 TTY 且回溯启用'
    + '(KHY_ESC_REWIND 开)下,错误行末追加一句「双击 Esc 可回到上一条消息,编辑后重试」(对齐 CC errors.ts);'
    + '显示子闸 KHY_ESC_REWIND_HINT 默认开。auth/权限/无效 key/语法/工具错误不追加(改消息无用)。',
});

module.exports = {
  flagOn,
  isRewindEnabled,
  turnCheckpointEnabled,
  escRewindHintEnabled,
  buildEscRewindHint,
  decideEscIdle,
  userTurnRankFromEnd,
  selectLastUserTarget,
  listUserTargets,
  patchUserCheckpointId,
  ESC_REWIND_HINT_TEXT,
  RULES,
};
