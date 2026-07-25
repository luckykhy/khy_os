'use strict';

/**
 * promptIntentRepair.js
 *
 * 「奔赴人的真实意图」—— 当用户给的提示词**乱**(错别字、漏字、语序颠倒、混入乱码 /
 * 零宽 / 控制字符等)时,khyos 不应一律抛选项卡反问,而应先**自己对乱提示词做一些理解**:
 * 结合前后文语境善意纠错、推断真实意图,能判定就直接推进,只有关键点经语境仍无法确定时
 * 才升级到选项卡澄清。
 *
 * 纯叶子:无 I/O、无随机、单一真源。给定用户文本 + 是否有媒体 + 已激活意图模式,产出一个
 * 结构化裁决 + 一段中文系统指令(由上层注入**系统提示词**而非用户消息,避免被模型当作
 * prompt injection)。
 *
 * 分工(不重复造判据):
 *  - 清晰度判定**复用** multimodalIntentRouter.assessPromptClarity(同一套保守、零假阳性
 *    判据);意图模式集合**复用** clarificationCards.CLEAR_MODES(单一真源)。
 *  - 「语义层纠错」(错别字 / 漏字 / 语序)交给模型——它才是处理模糊自然语言的合适工具;
 *    本叶子只确定性地负责:1) 何时该提示模型去做善意理解(触发门控,零假阳性优先);
 *    2) 结构层清洗(去乱码 / 零宽 / 控制字符、并拢多余空白)给出一个**仅供参考**的清理版本,
 *    绝不改写用户原始消息。
 *
 * 与既有件的关系(互补,可同时注入):
 *  - clarificationCards 讲「不清 → 怎样用选项卡向用户澄清」;本件讲「先结合语境纠错、奔赴
 *    真实意图,只有残余关键点才落到澄清卡」。两者同时出现时顺序自洽:先理解 → 实在判不准
 *    的那一两个点再用卡。
 *  - multimodalIntentRouter 讲「>=2 路异构输入 → 分路不混淆」;与本件正交。
 */

const { assessPromptClarity } = require('./multimodalIntentRouter');
const { CLEAR_MODES } = require('./clarificationCards');

// 拟声 / 情绪性叠字:这类同字重复是用户**有意**的(哈哈哈 / 谢谢谢 / 嗯嗯),不是笔误,
// 不应被「字符异常重复」信号误伤。
const REPEAT_OK_CHARS = new Set(
  Array.from('哈呵嘿嘻啦哇喔噢唉嗯哦嗷咦哼呜喵汪嘛呢啊哎谢么了的'),
);

// 结构性乱码:这些字符在正常提示词里几乎不可能出现,命中即为「强信号」(零假阳性)。
const REPLACEMENT_CHAR_RE = /\uFFFD/;                       // U+FFFD 替换符(编码损坏)
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/;       // 零宽字符
// C0/C1 控制字符与 DEL,但放行常见排版用的 TAB/LF/CR(U+0009/000A/000D)。
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
// 同一非空白字符连续出现 3 次及以上(用于「字符异常重复」的弱信号探测)。
const RUN_RE = /(\S)\1{2,}/g;
// 代码栅栏 / 行内代码:出现即不提供「清理参考」,以免误导模型以为要改动代码格式。
const CODEISH_RE = /```|`[^`]/;
// 行内多余空白(>=2 个空格/制表,不含换行)。
const INLINE_WS_RE = /[^\S\r\n]{2,}/g;
const INLINE_WS3_RE = /[^\S\r\n]{3,}/;

function _enabled(options = {}) {
  if (options && options.promptIntentRepair !== undefined) {
    return !['0', 'false', 'off', 'no'].includes(
      String(options.promptIntentRepair).trim().toLowerCase()
    );
  }
  const raw = String(process.env.KHY_PROMPT_INTENT_REPAIR || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * 结构性「乱」信号探测。保守、零假阳性优先:
 *  - strong:乱码替换符 / 零宽字符 / 控制字符 —— 正常提示词里不可能出现,命中即可独立触发。
 *  - medium:同字异常重复(排除拟声叠字)/ 多余空白 —— 仅作为参考信息列入指令,不独立触发,
 *    避免把「哈哈哈」「好的   」之类误判为乱。
 * @param {string} text
 * @returns {{strong:string[], medium:string[], signals:string[]}}
 */
function detectGarbleSignals(text) {
  const t = String(text || '');
  const strong = [];
  const medium = [];
  if (!t) return { strong, medium, signals: [] };

  if (REPLACEMENT_CHAR_RE.test(t)) strong.push('乱码字符(U+FFFD)');
  if (ZERO_WIDTH_RE.test(t)) strong.push('零宽字符');
  if (CONTROL_CHAR_RE.test(t)) strong.push('控制字符');

  // 同字连续 >=3 次,且重复字不在拟声/情绪叠字白名单里 → 可能是抖动/误触。
  let hasAbnormalRun = false;
  let mm;
  RUN_RE.lastIndex = 0;
  while ((mm = RUN_RE.exec(t)) !== null) {
    const ch = mm[1];
    if (/\s/.test(ch)) continue;       // 空白单独处理
    if (REPEAT_OK_CHARS.has(ch)) continue;
    if (/[0-9]/.test(ch)) continue;    // 数字本就可连续(如年份/编号)
    hasAbnormalRun = true;
    break;
  }
  if (hasAbnormalRun) medium.push('字符异常重复');

  // 句中出现 >=3 连续空白(不含换行)→ 可能漏字/误删。
  if (INLINE_WS3_RE.test(t)) medium.push('多余空白');

  return { strong, medium, signals: strong.concat(medium) };
}

/**
 * 仅做**保义不变**的结构层清洗,给出一个「清理参考版本」。绝不触碰用户原始消息,也不做
 * 任何语义层改写(错别字/漏字交给模型)。代码场景(含栅栏/行内代码)直接放弃清理。
 * @param {string} text
 * @returns {{text:string, changed:boolean}}
 */
function lightNormalize(text) {
  const original = String(text || '');
  if (!original || CODEISH_RE.test(original)) return { text: original, changed: false };
  const out = original
    .replace(new RegExp(ZERO_WIDTH_RE.source, 'g'), '')   // 去零宽
    .replace(new RegExp(CONTROL_CHAR_RE.source, 'g'), '') // 去控制符
    .replace(INLINE_WS_RE, ' ')                           // 行内多余空白并拢
    .replace(/[^\S\r\n]+\n/g, '\n')                       // 行尾空白
    .trim();
  return { text: out, changed: out !== original };
}

/**
 * 评估是否需要「乱提示词理解 / 奔赴真实意图」指令。
 *
 * 触发条件(零假阳性优先):
 *   need = enabled && ( 强乱码信号 || (提示词不清 && 无意图模式活跃) )
 * 即:1) 出现结构性乱码 —— 无论清晰与否都提示模型先清洗再理解;2) 提示词本身不清(模糊动词/
 * 纯引用/空文本+媒体)且未由意图模式给出明确指令 —— 提示模型先结合语境推断真实意图,而非
 * 直接反问。清晰且无乱码 → 不介入(系统提示词字节不变)。
 *
 * @param {object} input
 * @param {string} input.text
 * @param {boolean} [input.hasMedia]
 * @param {string[]} [input.modes]
 * @param {object} [input.options]
 * @returns {{
 *   enabled:boolean,
 *   clarity:{clear:boolean,reason:string},
 *   garble:{strong:string[],medium:string[],signals:string[]},
 *   modeActive:boolean,
 *   need:boolean,
 *   reason:string
 * }}
 */
function assessRepairNeed(input = {}) {
  const options = input.options || {};
  const enabled = _enabled(options);
  const text = String(input.text || '');
  const hasMedia = !!input.hasMedia;
  const modes = (Array.isArray(input.modes) ? input.modes : [])
    .map(m => String(m || '').trim().toLowerCase())
    .filter(Boolean);

  const clarity = assessPromptClarity(text, { hasMedia });
  const garble = detectGarbleSignals(text);
  const modeActive = modes.some(m => CLEAR_MODES.includes(m));

  const strongGarble = garble.strong.length > 0;
  const unclearDriven = !clarity.clear && !modeActive;
  const need = enabled && (strongGarble || unclearDriven);

  let reason;
  if (!enabled) reason = 'disabled';
  else if (strongGarble) reason = 'garble';
  else if (unclearDriven) reason = clarity.reason;
  else if (modeActive) reason = 'mode-active';
  else reason = 'prompt-clear';

  return { enabled, clarity, garble, modeActive, need, reason };
}

/**
 * 构建「乱提示词理解 / 奔赴真实意图」中文系统指令(确定性,无随机)。
 * @param {object} [ctx]
 * @param {string[]} [ctx.signals]   detectGarbleSignals 的可读信号(可选,列入提示)
 * @param {string} [ctx.cleanedHint] lightNormalize 后与原文不同的清理参考(可选)
 * @returns {string}
 */
function buildRepairDirective(ctx = {}) {
  const signals = Array.isArray(ctx.signals) ? ctx.signals.filter(Boolean) : [];
  const cleanedHint = String(ctx.cleanedHint || '').trim();

  const lines = [];
  lines.push('## 体察用户惰性 —— 先理解「乱」提示词,奔赴真实意图');
  lines.push('用户这次的提示词可能比较「乱」:可能有**错别字、漏字、语序颠倒**,或混入多余/乱码字符。请**先自己做一次善意理解**,不要因为小笔误就停下来反复追问:');
  lines.push('1. **结合前后文语境**,在心里纠正明显的错别字 / 补全漏掉的字 / 理顺语序,推断用户的**真实意图**;');
  lines.push('2. 用**一句话**简短复述你理解到的意图(例如「你的意思应该是……,我按这个来」),给用户一个纠偏机会即可,不要长篇分析;');
  lines.push('3. 若意图已基本可判,直接**奔赴真实意图**推进,别被表面笔误带偏;');
  lines.push('4. 仅当**关键信息**(对象 / 范围 / 目标)经语境推断后仍无法确定时,才就那一两个点用选项卡向用户澄清;能自己判断的不要反问。');
  lines.push('5. 不要臆造用户并未表达的诉求,也不要把善意纠错变成擅自改需求。');

  if (signals.length) {
    lines.push('');
    lines.push(`(已检测到可能的干扰信号:${signals.join('、')};仅供参考,请以语境判断为准。)`);
  }
  if (cleanedHint) {
    lines.push(`(去除乱码/多余空白后的参考版本:「${cleanedHint}」;这只是结构清理,语义仍以你的语境理解为准,且不要据此擅改用户原意。)`);
  }
  return lines.join('\n');
}

/**
 * 乱提示词理解路由主入口(单一真源)。
 * @param {object} input  同 assessRepairNeed
 * @returns {{...assessment, cleaned:{text:string,changed:boolean}, directive:(string|null)}}
 */
function routeIntentRepair(input = {}) {
  const assessment = assessRepairNeed(input);
  const cleaned = lightNormalize(String(input.text || ''));
  let directive = null;
  if (assessment.need) {
    directive = buildRepairDirective({
      signals: assessment.garble.signals,
      cleanedHint: cleaned.changed ? cleaned.text : '',
    });
  }
  return { ...assessment, cleaned, directive };
}

module.exports = {
  detectGarbleSignals,
  lightNormalize,
  assessRepairNeed,
  buildRepairDirective,
  routeIntentRepair,
};
