'use strict';

/**
 * clarificationCards.js
 *
 * 「体察人的惰性」—— 当用户给出的提示词**不清晰**(只给了引用对象、或用了「看看 /
 * 搞一下 / 你看着办」这类模糊说法)时,与其凭空臆测或简单拒绝,不如确定性地提示模型:
 * 用结构化「选项卡」帮用户把真实需求**选**出来。
 *
 * 纯叶子:无 I/O、无随机、单一真源。给定用户文本 + 是否有媒体 + 已激活意图模式,产出一个
 * 结构化裁决 + 一段中文系统指令(由上层注入**系统提示词**而非用户消息,避免被模型当作
 * prompt injection)。
 *
 * 与既有件正交,且复用单一真源,不重复造判据:
 *  - 清晰度判定**复用** multimodalIntentRouter.assessPromptClarity(同一套保守、零假阳性
 *    的启发式:空文本+媒体 / 纯引用无指令 / 敷衍动词 → 不清;具体动作+对象 → 清晰)。
 *  - multimodalIntentRouter 负责「≥2 路异构输入且不清 → 分路不混淆」的特化指令;本件负责
 *    「提示词不清 → 用选项卡澄清」的通用 UI 指令。二者可同时出现、互补不冲突(前者讲
 *    『怎么分路识别』,后者讲『怎么向用户澄清』)。
 *  - intentGate 的 goal/coding/... 模式活跃即视为「用户已给出明确指令」,本路由让位不注入。
 *
 * 触发后注入的指令只是**让位给用户去选**的引导;真正的「可讨论」选项与「左右多张卡」交互
 * 由 TUI 的 QuestionPrompt 确定性保证(系统自动为每张卡补「可讨论」与「自由输入」两项),
 * 所以指令明确告诉模型**无需**自己再加这两项,避免与自动项重复。
 */

const { assessPromptClarity } = require('./multimodalIntentRouter');

// 与 multimodalIntentRouter 保持一致:这些意图模式活跃即代表用户已给出明确指令。
const CLEAR_MODES = Object.freeze(['goal', 'ultrawork', 'coding', 'analyze', 'learn']);

function _enabled(options = {}) {
  if (options && options.clarificationCards !== undefined) {
    return !['0', 'false', 'off', 'no'].includes(
      String(options.clarificationCards).trim().toLowerCase()
    );
  }
  const raw = String(process.env.KHY_CLARIFICATION_CARDS || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * 评估是否需要「选项卡澄清」。保守:仅在「提示词不清 且 无意图模式活跃」时触发,
 * 复用 assessPromptClarity 的零假阳性判据。
 *
 * @param {object} input
 * @param {string} input.text          用户原始消息
 * @param {boolean} [input.hasMedia]   是否伴随媒体(图片/音频/视频/文档)
 * @param {string[]} [input.modes]     intentGate.detectModes().modes
 * @param {object} [input.options]     env 覆盖({clarificationCards})
 * @returns {{
 *   enabled:boolean,
 *   clarity:{clear:boolean,reason:string},
 *   modeActive:boolean,
 *   need:boolean,
 *   reason:string
 * }}
 */
function assessClarificationNeed(input = {}) {
  const options = input.options || {};
  const enabled = _enabled(options);
  const text = String(input.text || '');
  const hasMedia = !!input.hasMedia;
  const modes = (Array.isArray(input.modes) ? input.modes : [])
    .map(m => String(m || '').trim().toLowerCase())
    .filter(Boolean);

  const clarity = assessPromptClarity(text, { hasMedia });
  const modeActive = modes.some(m => CLEAR_MODES.includes(m));

  const need = enabled && !clarity.clear && !modeActive;
  return {
    enabled,
    clarity,
    modeActive,
    need,
    reason: need ? clarity.reason : (modeActive ? 'mode-active' : (clarity.clear ? 'prompt-clear' : 'disabled')),
  };
}

/**
 * 构建「用选项卡澄清不清晰提示词」的中文系统指令(确定性,无随机)。
 * 明确告诉模型:系统会自动为每张卡补上「可讨论」与「自由输入」,无需自己再加,避免重复。
 * @returns {string}
 */
function buildClarificationDirective() {
  const lines = [];
  lines.push('## 体察用户惰性 —— 提示词不清晰,用「选项卡」澄清真实需求');
  lines.push('用户这次的提示词不够清晰(可能只给了引用对象,或用了「看看 / 搞一下 / 你看着办」这类模糊说法)。请**体察其惰性**:既不要假装已经完全理解、贸然臆测,也不要简单拒绝,而是先用结构化「选项卡」帮用户把需求**选**出来。');
  lines.push('');
  lines.push('做法(调用 AskUserQuestion 工具):');
  lines.push('1. 给出 1~4 张选项卡(questions 数组),用户可**左右切换**逐张确认;每张聚焦一个待澄清维度(如:目标产物 / 范围 / 风格或格式 / 优先级)。');
  lines.push('2. 每张卡尽量设 `multiSelect: true`,让用户**上下多选**(真实诉求常常不止一个)。');
  lines.push('3. 每张卡给 2~4 个**具体、互斥、贴合上下文**的选项即可;系统会**自动**为每张卡补上「可讨论」(这一点想再聊聊 / 由你来定)与「自由输入」两项,你**无需**自己再加这两项。');
  lines.push('4. 选项要**一眼可分**:每个 label 用 1~5 字的短标签,description 说清「选它会怎样」的具体后果,不要含糊或彼此重叠。');
  lines.push('5. 若你确有倾向,就把**推荐项放在第一个**并在 label 末尾标「(推荐)」,在其 description 里说明**为什么**它更稳妥/更快;若确无倾向,就不要硬凑推荐。');
  lines.push('6. 拿到用户选择后,把多张卡的选择**综合成一个方向**(而非逐条孤立处理),据此调整计划再推进;在澄清之前**不要**盲目假设,也**不要**只追问而完全不给方向。');
  return lines.join('\n');
}

/**
 * 选项卡澄清路由主入口(单一真源)。
 * @param {object} input  同 assessClarificationNeed
 * @returns {{...assessment, directive:(string|null)}}
 */
function routeClarification(input = {}) {
  const assessment = assessClarificationNeed(input);
  return {
    ...assessment,
    directive: assessment.need ? buildClarificationDirective() : null,
  };
}

module.exports = {
  CLEAR_MODES,
  assessClarificationNeed,
  buildClarificationDirective,
  routeClarification,
};
