'use strict';

/**
 * promptAutoCapture — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 目的:在聊天流收尾处,判断用户本轮的原始输入是否「值得收藏为提示词」。命中的
 * 候选由调用侧写入 promptStore 的待审核队列(status:'pending'),用户再终审留存或
 * 丢弃。本叶子**只做可解释的启发式判定**,绝不触发任何模型调用 / IO —— 「AI 发现」=
 * 系统按规则自动挑,用户终审,而非二次 LLM 判断。
 *
 * 判据(全部为纯字符串启发式):
 *   - 长度落在 [MIN_LEN, MAX_LEN] 区间(太短无收藏价值,太长多为一次性上下文);
 *   - 命中至少一条「指令性结构」信号:角色设定 / 分步 / 输出格式约束 / 指令动词;
 *   - 不是明显的一次性闲聊 / 纯提问(排除信号)。
 *
 * 门控 KHY_PROMPT_AUTOCAPTURE(默认开;显式 0/false/off/no 关闭 → shouldCapture 恒
 * 返回 false,逐字节回退今日无捕获行为)。坏输入(null/非字符串)→ false,绝不抛。
 */

const MIN_LEN = 40;
const MAX_LEN = 4000;

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function autoCaptureEnabled(env = process.env) {
  const raw = env && env.KHY_PROMPT_AUTOCAPTURE;
  if (raw === undefined || raw === null || raw === '') return true;
  return !_FALSY.has(String(raw).trim().toLowerCase());
}

// 指令性结构信号:命中任一即视为「像一条可复用提示词」。中英双语覆盖。
const _INSTRUCTION_SIGNALS = [
  // 角色设定 / persona
  /你是[一个]{0,2}?[^\n]{0,20}?(专家|助手|工程师|顾问|角色|大师|老师)/,
  /\b(you are|act as|you're)\b[^\n]{0,40}?\b(expert|assistant|engineer|senior|professional)\b/i,
  /扮演|担任|作为一名/,
  // 分步 / 结构化
  /(第[一二三四五六七八九1-9]步|步骤[一二三1-9]|分\s*步|逐步)/,
  /\b(step[\s-]?by[\s-]?step|first[,\s].{0,30}\bthen\b)/i,
  // 输出格式约束
  /(按照|以)[^\n]{0,20}?(格式|结构|模板|json|markdown|表格|列表)输出/i,
  /\b(respond|output|answer|format)\b[^\n]{0,30}?\b(in|as|using)\b[^\n]{0,20}?\b(json|markdown|table|list|format)\b/i,
  /输出格式|返回格式|遵循.{0,10}规范|请严格/,
  // 指令动词密度(祈使)
  /(请你?|帮我|要求你?|你需要|你必须|务必)/,
  /\b(please|ensure|make sure|you must|you should|always|never)\b/i,
];

// 排除信号:明显的一次性闲聊 / 极短纯问句,不值得进库。
const _EXCLUDE_SIGNALS = [
  /^(你好|嗨|hi|hello|hey|谢谢|thanks|thank you|ok|好的|收到)[\s!！。.?？]*$/i,
];

function _isString(v) {
  return typeof v === 'string';
}

/**
 * 判断一段文本是否值得作为提示词候选自动收藏。
 * @param {string} text     用户本轮原始输入
 * @param {object} env      环境(门控读取,叶子纯 → 由壳注入)
 * @returns {boolean}
 */
function shouldCapture(text, env = process.env) {
  try {
    if (!autoCaptureEnabled(env)) return false;
    if (!_isString(text)) return false;
    const t = text.trim();
    if (t.length < MIN_LEN || t.length > MAX_LEN) return false;
    for (const re of _EXCLUDE_SIGNALS) {
      if (re.test(t)) return false;
    }
    for (const re of _INSTRUCTION_SIGNALS) {
      if (re.test(t)) return true;
    }
    return false;
  } catch {
    // 纯叶子契约:绝不抛,任何意外一律判不捕获(fail-closed 更安全)。
    return false;
  }
}

/**
 * 从候选文本派生一个简短标题(截断保首行)。纯函数,绝不抛。
 * @param {string} text
 * @returns {string}
 */
function deriveTitle(text) {
  try {
    if (!_isString(text)) return 'AI 发现的提示词';
    const firstLine = text.trim().split(/\r?\n/)[0].trim().replace(/\s+/g, ' ');
    if (!firstLine) return 'AI 发现的提示词';
    return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
  } catch {
    return 'AI 发现的提示词';
  }
}

module.exports = {
  shouldCapture,
  deriveTitle,
  autoCaptureEnabled,
  // exported for tests
  MIN_LEN,
  MAX_LEN,
};
