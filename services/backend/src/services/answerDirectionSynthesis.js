'use strict';

/**
 * answerDirectionSynthesis.js — 「拿到用户回答后,把它们当作一个组合决策,据此调整方向」的
 * 确定性单一真源(纯叶子:零 IO、无随机、无时钟、绝不抛、fail-soft、门控字节回退)。
 *
 * 背景(用户目标 2026-07-03「根据用户的回答组合调整方向」):
 *   AskUserQuestion 让用户对 1~4 张选项卡逐张作答;`toolUseLoop` 在答案回流处把它们拼成
 *   一串 `Q:…\nA:…` 喂回模型(services/toolUseLoop.js 答案接缝)。但那串**只有原始答案、没有
 *   任何引导**:模型可能逐条孤立处理、或干脆照提问前的默认假设一路推进,而不把这几张卡的选择
 *   **合在一起还原用户此刻真正的方向**并据此校准计划。这正是「组合调整方向」缺的一环。
 *
 * 本叶子在**答案接缝**处把回流内容加法式增强:先原样给出 `Q:/A:` 明细(与历史逐字节一致),
 * 再**据实际答案集**追加一段确定性中文指令,命令模型:①综合各维度选择还原真实方向 ②显式调整
 * 下一步计划(与原计划冲突以用户选择为准) ③留白维度给建议默认 ④复述综合方向再推进。
 *
 * 「据实际答案集」= 指令内容由检测到的信号**条件塑形**,不是死板样板:
 *   - 单卡 vs 多卡 → 措辞是否用「组合」;
 *   - 多选答案(", " 连接≥2项)→ 追加「多选的组合语义(同时满足/按优先级取舍)」一行;
 *   - 留白答案(命中固定标签「可讨论」)→ 追加「该维度仍开放,给建议默认+理由」一行。
 *
 * 门控 KHY_ANSWER_DIRECTION_SYNTHESIS(默认开;仅显式 0/false/off/no 关)。关闭 →
 * buildAnswerFeedback 逐字节回退到历史「只拼 Q:/A:」的 base,答复字节不变。
 *
 * 单一真源:base 明细的构造(buildBaseLines)只此一处,接缝直接消费,不各写一份。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// TUI QuestionPrompt/questionCardModel 为每张卡确定性追加的「可讨论」出口标签(用户
// 「这一点想再聊聊 / 由你来定」)。多选答案在 questionCardModel 里用 ", " join。二者是
// 检测「留白」与「多选」的**确定性**信号(与真实答案串的构造方式对齐,零假阳性优先)。
const DISCUSS_LABEL = '可讨论';
const _MULTI_SEP = ', ';

/**
 * 门控判定。默认开,仅显式 0/false/off/no 关闭。
 * @param {object} [env]  默认 process.env
 * @returns {boolean}
 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_ANSWER_DIRECTION_SYNTHESIS;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 构造 `Q:…\nA:…`(块间空行连接)明细 —— 与历史接缝逐字节一致的单一真源。
 * 非对象/空 → 空串。
 * @param {object} answers  { [questionText]: answerString }
 * @returns {string}
 */
function buildBaseLines(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return '';
  return Object.entries(answers)
    .map(([qText, ans]) => `Q: ${qText}\nA: ${ans}`)
    .join('\n\n');
}

/**
 * 分析答案集,抽出用于塑形指令的确定性信号。绝不抛。
 * @param {object} answers
 * @returns {{count:number, hasMulti:boolean, hasDeferred:boolean}}
 */
function _analyzeAnswers(answers) {
  const out = { count: 0, hasMulti: false, hasDeferred: false };
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return out;
  const entries = Object.entries(answers);
  out.count = entries.length;
  for (const [, rawAns] of entries) {
    const ans = String(rawAns == null ? '' : rawAns);
    // 多选:", " 连接出 ≥2 个非空 token。
    if (ans.split(_MULTI_SEP).map(s => s.trim()).filter(Boolean).length >= 2) {
      out.hasMulti = true;
    }
    // 留白:命中固定「可讨论」标签(单选留白 or 多选里含它)。
    if (ans.includes(DISCUSS_LABEL)) out.hasDeferred = true;
  }
  return out;
}

/**
 * 据分析信号构造「组合调整方向」的确定性中文指令块。只消费自身信号(非用户自由文本),
 * 无随机/时钟,绝不回显未知内容。
 * @param {{count:number, hasMulti:boolean, hasDeferred:boolean}} analysis
 * @returns {string}
 */
function buildSynthesisBlock(analysis) {
  const a = analysis || {};
  const multiCard = Number(a.count) >= 2;
  const lines = [];

  if (multiCard) {
    lines.push('## 用户已作答 —— 把这些回答当作「一个组合决策」,据此调整方向后再推进');
    lines.push('上面是用户对你所提各问题的选择。请把它们作为**一组相互关联的决策整体**来理解,不要逐条孤立处理:');
  } else {
    lines.push('## 用户已作答 —— 据此回答调整方向后再推进');
    lines.push('上面是用户的选择。请据此校准你的方向,不要照提问前的默认假设一路推进:');
  }

  let n = 0;
  lines.push(`${++n}. **先综合**:把${multiCard ? '各维度的选择合在一起' : '这一选择'},还原用户此刻真正想要的方向——它可能与你提问前的默认假设不同。`);
  if (a.hasMulti) {
    lines.push(`${++n}. **多选项的组合语义**:某些维度用户做了多选,注意它们之间是「需同时满足」还是「按优先级取舍」,别只挑其中一个。`);
  }
  lines.push(`${++n}. **再校准**:据此**显式调整**你的下一步计划/方向;若某项选择与你原计划冲突,以用户选择为准并用一句话说明取舍。`);
  if (a.hasDeferred) {
    lines.push(`${++n}. **留白项照顾**:某维度用户选了「${DISCUSS_LABEL}」,视为该方向仍开放——给出你的建议默认并说明理由,而不是略过。`);
  }
  lines.push(`${++n}. 用一两句话向用户**复述你综合后的方向**,再继续执行;不要无视这些选择照旧推进。`);

  return lines.join('\n');
}

/**
 * 答案接缝主入口(单一真源)。返回回流给模型的 output 文本。
 *   - base = buildBaseLines(answers)(历史逐字节明细)
 *   - 门控关 或 无有效答案(count===0) → 返回 base(逐字节回退)
 *   - 否则 → base + '\n\n' + 组合调整方向指令块
 * 绝不抛:任何意外 → 回退到 base。
 *
 * @param {object} input
 * @param {object} input.answers  { [questionText]: answerString }
 * @param {object} [input.env]    默认 process.env
 * @returns {string}
 */
function buildAnswerFeedback(input = {}) {
  const answers = input && input.answers;
  const env = (input && input.env) || process.env;
  let base = '';
  try {
    base = buildBaseLines(answers);
    if (!isEnabled(env)) return base;
    const analysis = _analyzeAnswers(answers);
    if (analysis.count === 0) return base;
    const block = buildSynthesisBlock(analysis);
    return base ? `${base}\n\n${block}` : block;
  } catch {
    return base;
  }
}

module.exports = {
  DISCUSS_LABEL,
  isEnabled,
  buildBaseLines,
  buildSynthesisBlock,
  buildAnswerFeedback,
  _analyzeAnswers,
};
