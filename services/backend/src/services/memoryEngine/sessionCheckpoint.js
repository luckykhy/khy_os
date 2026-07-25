'use strict';

/**
 * sessionCheckpoint.js — 「会话结束自动进度检查点」纯叶子(零 IO、零状态、不读时钟、绝不抛)。
 *
 * 诉求(goal 2026-07-03 续:用户要「再加一个门控的『会话结束自动 checkpoint』层」):
 *   RecordProgress 工具已让模型能在里程碑处手动写检查点,但依赖模型**自觉调用**——它可能忘。
 *   本层是**安全网**:会话结束(/clear·/new·/reset·双 Ctrl+C·Ctrl+D 退出)时,若这一段
 *   确实像「跨会话的学习/工作」且模型**没有**已经手动 checkpoint,就从会话记录里**启发式**
 *   蒸馏出一条 {主题, 已覆盖, 下一步} 追加进项目 PROGRESS.md,让下次能接上、真正闭环。
 *
 * 与 khy「零假阳性」哲学一致的三道护栏(本叶子只做判断与蒸馏,写盘归 ai.js→memdir 的 IO 壳):
 *   ① **绝不用 LLM**:退出/清空路径脆弱(可能 process.exit 在即、可能 429),只用确定性启发式。
 *   ② **只当安全网**:若本会话已出现 RecordProgress 工具调用 → 直接跳过(绝不盖过模型手写的更好检查点)。
 *   ③ **严格门槛**:仅在 studyMode 开、或会话有足够「学习信号 + 实质轮次」时才触发;否则不写(防噪)。
 *
 * 蒸馏是**粗粒度且诚实标注**的(covered 前缀「[自动]」):它取最后一条实质 assistant 回复做
 * 「已覆盖」、从中抽显式「下一步」措辞、以**项目文件夹名**作主题锚点(PROGRESS.md 本就按项目隔离)。
 * 宁可粗也不臆造:抽不到下一步就留空,不编。
 *
 * 门控(默认开,值 ∈{0,false,off,no} 关;父门控 KHY_PROGRESS_LOG 关 / KHY_DISABLE_MEMORY 亦全关):
 *   KHY_PROGRESS_AUTO_CHECKPOINT —— 会话结束自动 checkpoint 层(KHY_PROGRESS_LOG 的子门控)。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

function _off(v) {
  return OFF.has(String(v == null ? '' : v).trim().toLowerCase());
}

let _progress;
try { _progress = require('./progressLog'); } catch { _progress = null; }

/**
 * 总门控:父门控 KHY_PROGRESS_LOG(含 KHY_DISABLE_MEMORY)必须开,且本子门控未关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  // 父门控优先:进度日志整体关(或记忆总关)⇒ 自动层必关。
  if (_progress && typeof _progress.isEnabled === 'function') {
    if (!_progress.isEnabled(e)) return false;
  } else {
    // 叶子缺失时的保守回退:仍尊重记忆总开关与父门控 KHY_PROGRESS_LOG。
    const dis = String(e.KHY_DISABLE_MEMORY || '').trim().toLowerCase();
    if (dis === '1' || dis === 'true') return false;
    if (_off(e.KHY_PROGRESS_LOG)) return false;
  }
  return !_off(e.KHY_PROGRESS_AUTO_CHECKPOINT);
}

// 触发门槛常量。
const MIN_ASSISTANT_TURNS = 3;   // 至少这么多条实质 assistant 回复才算「一段」学习/工作
const MIN_LEARNING_SIGNALS = 2;  // 非 studyMode 时,至少命中这么多个不同学习信号词
const SUBSTANTIVE_MIN_CHARS = 24; // 一条 assistant 回复算「实质」的最短清洗后字符数(CJK 友好)

// 学习/教学信号词表(zh 按子串、en 按小写整串包含)。小而聚焦,用于门槛判定(非蒸馏)。
const _LEARN_ZH = ['学', '教', '章', '节', '课', '练', '题', '复习', '背', '考', '知识点', '讲', '例题', '公式', '单词', '语法', '刷题'];
const _LEARN_EN = ['learn', 'study', 'teach', 'chapter', 'lesson', 'exercise', 'review', 'quiz', 'practice', 'tutorial', 'homework', 'grammar', 'vocabulary'];

/** 把一条消息的 content 归一为纯文本(容忍字符串 / content-block 数组)。绝不抛。 */
function _msgText(msg) {
  try {
    if (!msg) return '';
    const c = msg.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b.text === 'string') return b.text;
        return '';
      }).join(' ');
    }
    return typeof c === 'string' ? c : '';
  } catch {
    return '';
  }
}

/** 该消息是否含名为 `toolName` 的结构化 tool_use 块。 */
function _hasToolUse(msg, toolName) {
  try {
    const c = msg && msg.content;
    if (!Array.isArray(c)) return false;
    return c.some((b) => b && b.type === 'tool_use' && String(b.name || '') === toolName);
  } catch {
    return false;
  }
}

/**
 * 本会话是否已出现 RecordProgress 工具调用(模型手写了检查点)。是 ⇒ 安全网跳过。
 * 认结构化 tool_use 块,也认工具结果载体文本里的 `[Tool:RecordProgress]` 标记。绝不抛。
 * @param {Array} messages
 * @returns {boolean}
 */
function alreadyCheckpointed(messages) {
  if (!Array.isArray(messages)) return false;
  try {
    for (const m of messages) {
      if (_hasToolUse(m, 'RecordProgress')) return true;
      const t = _msgText(m);
      if (t && t.indexOf('[Tool:RecordProgress]') !== -1) return true;
    }
  } catch { /* fail-soft */ }
  return false;
}

/** 去掉 tool_call/tool 标记与多余空白,便于蒸馏可读文本。 */
function _clean(text) {
  return String(text || '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, ' ')
    .replace(/\[Tool[^\]]*\]/gi, ' ')
    .replace(/\[Tool Result\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 统计不同学习信号命中数(zh 子串 + en 小写整串)。 */
function _learningSignalCount(joinedLower) {
  let n = 0;
  for (const w of _LEARN_ZH) { if (joinedLower.indexOf(w) !== -1) n += 1; }
  for (const w of _LEARN_EN) { if (joinedLower.indexOf(w) !== -1) n += 1; }
  return n;
}

/**
 * 判定这段会话是否值得自动 checkpoint(严格,防噪)。studyMode 开 ⇒ 直接合格;
 * 否则要求足够实质 assistant 轮次 且 足够学习信号。绝不抛。
 * @param {object} args
 * @param {Array}   args.messages
 * @param {boolean} [args.studyMode]
 * @returns {boolean}
 */
function qualifies(args = {}) {
  try {
    const a = args && typeof args === 'object' ? args : {};
    const messages = Array.isArray(a.messages) ? a.messages : [];
    let substantive = 0;
    const parts = [];
    for (const m of messages) {
      const role = String((m && m.role) || '').toLowerCase();
      const txt = _clean(_msgText(m));
      if (role === 'assistant' && txt.length >= SUBSTANTIVE_MIN_CHARS) substantive += 1;
      if (role === 'assistant' || role === 'user') parts.push(txt);
    }
    if (substantive < MIN_ASSISTANT_TURNS) return false;
    if (a.studyMode === true) return true;
    return _learningSignalCount(parts.join(' ').toLowerCase()) >= MIN_LEARNING_SIGNALS;
  } catch {
    return false;
  }
}

// 显式「下一步」措辞(抽到才填,抽不到留空——绝不臆造)。
const _NEXT_RE = /(?:下一步|接下来|下次|下节课?|后续|然后|next(?:\s+step)?)[：:，,\s]+([^。;；\n]{2,120})/i;

/** 最后一条实质 assistant 回复(清洗后)。无 ⇒ ''。 */
function _lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (String((m && m.role) || '').toLowerCase() !== 'assistant') continue;
    const t = _clean(_msgText(m));
    if (t.length >= 20) return t;
  }
  return '';
}

/**
 * 从会话记录启发式蒸馏一条自动检查点。粗粒度、诚实标注、不臆造。绝不抛。
 * @param {object} args
 * @param {Array}  args.messages
 * @param {string} [args.folderName]  项目文件夹名(主题锚点)
 * @returns {{topic:string, covered:string, next:string}|null}
 */
function distill(args = {}) {
  try {
    const a = args && typeof args === 'object' ? args : {};
    const messages = Array.isArray(a.messages) ? a.messages : [];
    const last = _lastAssistantText(messages);
    if (!last) return null;

    const topicRaw = String(a.folderName || '').trim();
    const topic = topicRaw && topicRaw !== '.' && topicRaw !== '/' && topicRaw !== '~'
      ? topicRaw : '(本项目)';

    // 已覆盖:诚实前缀 + 最后一条实质回复(交给 progressLog._clip 截断)。
    const covered = '[自动] ' + last;

    // 下一步:仅当抽到显式措辞。优先在最后一条回复里抽,否则全程倒序找第一处。
    let next = '';
    const mLast = last.match(_NEXT_RE);
    if (mLast) {
      next = _clean(mLast[1]);
    } else {
      for (let i = messages.length - 1; i >= 0 && !next; i--) {
        const m = messages[i];
        if (String((m && m.role) || '').toLowerCase() !== 'assistant') continue;
        const mm = _clean(_msgText(m)).match(_NEXT_RE);
        if (mm) next = _clean(mm[1]);
      }
    }
    return { topic, covered, next };
  } catch {
    return null;
  }
}

/**
 * 端到端编排:门控 → 安全网(已手写则跳) → 门槛 → 蒸馏。返回可追加的 entry 或 null。
 * 纯函数;写盘由调用方(ai.js)交给 memdir.appendProjectProgress。绝不抛。
 * @param {object} args
 * @param {Array}   args.messages
 * @param {boolean} [args.studyMode]
 * @param {string}  [args.folderName]
 * @param {object}  [args.env]
 * @returns {{topic:string, covered:string, next:string}|null}
 */
function buildAutoCheckpoint(args = {}) {
  try {
    const a = args && typeof args === 'object' ? args : {};
    if (!isEnabled(a.env)) return null;
    const messages = Array.isArray(a.messages) ? a.messages : [];
    if (alreadyCheckpointed(messages)) return null;         // 安全网:不盖模型手写
    if (!qualifies({ messages, studyMode: a.studyMode })) return null;
    return distill({ messages, folderName: a.folderName });
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  alreadyCheckpointed,
  qualifies,
  distill,
  buildAutoCheckpoint,
  MIN_ASSISTANT_TURNS,
  MIN_LEARNING_SIGNALS,
};
