'use strict';

/**
 * multimodalIntentRouter.js
 *
 * 当用户**同时**给出多种异构输入(文本 + 图片 + 音频 + 视频 + 文档),外加对 khyos
 * 底座/内核的引用,而提示词又**不清晰**时,确定性地「分别识别每一路输入,并给出不混乱
 * 的处理指令」。
 *
 * 纯叶子:无 I/O、无随机、单一真源。给定已探测的模态种类 + 用户文本 + 已激活意图模式,
 * 产出一个结构化裁决 + 一段中文系统指令(由上层注入**系统提示词**而非用户消息,避免被
 * 模型当作 prompt injection)。
 *
 * 防混乱设计要点:
 *  - 「khyos」作为**第 5 路输入**被显式识别(此前完全无识别,仅当普通文字)。
 *  - 每一路输入在指令里被列为彼此独立的通道,模型被要求「勿混淆 / 勿张冠李戴 / 勿丢弃
 *    任一路」。
 *  - **仅当**「提示词不清 且 ≥2 路异构输入」才注入(零误触:提示词清晰、单一输入、或
 *    已由意图模式给出明确指令 → 不注入,系统提示词字节不变)。
 *  - 确定性优先级排序,使路由稳定而非随机。
 *
 * 与既有件正交:
 *  - intentGate.detectModes —— 关键词触发的 goal/coding/... 模式(文本意图)。模式活跃
 *    即视为「提示词已明确」,本路由让位不注入。
 *  - cli/repl/imageIntent.buildContextualImagePrompt —— 单张图片的提示词改写(单模态),
 *    本路由只在「≥2 路异构输入」时介入,二者不冲突。
 */

// 各输入通道的中文标签(供 inventory 与指令枚举)。
const CHANNEL_LABELS = Object.freeze({
  khyos: 'khyos 底座/内核(本项目引用,非媒体文件)',
  text: '文本指令',
  image: '图片',
  document: '文档',
  archive: '压缩包(归档:zip/tar 等,内含多个文件)',
  audio: '音频',
  video: '视频',
});

// 确定性处理优先级:khyos 项目上下文 → 文本 → 图片 → 文档 → 压缩包 → 音频 → 视频。
const CHANNEL_ORDER = Object.freeze(['khyos', 'text', 'image', 'document', 'archive', 'audio', 'video']);

// 「khyos」第 5 路输入的保守识别:只认明确的 khyos 令牌或中文「khy 内核/系统/底座/操作
// 系统」引用。绝不误伤 khyquant(应用,非底座)、macos、裸 os 等普通词汇 —— 零假阳性优先。
const KHYOS_TOKEN_RE = /(^|[^a-z0-9])khy[\s\-_]?os([^a-z0-9]|$)/i;
const KHYOS_CN_RE = /khy\s*(?:内核|系统|底座|操作系统|os)/i;

// 「具体指令」:出现「动作 + 明确对象」即视为提示词清晰,无论长短。覆盖典型跨模态动作,
// 这类提示词不需要消歧介入。
const CONCRETE_INSTRUCTION_RE = /(转(?:成|为|换)|生成|制作|做成|总结|概括|提炼|识别|提取|翻译|分析(?:一下)?(?:这段|这张|这个|内容|代码|架构|图)|解释|改写|重构|修复|部署|对比|比较|转写|配音|剪辑|裁剪|合并|导出|保存|写(?:成|个|一)|画(?:一|个|出)|搭建|实现|讲解|教我|复刻|还原成?网页|to\s+(?:html|web|text|markdown)|transcribe|summari[sz]e|translate|convert|extract|generate|analy[sz]e\s+(?:this|the)|explain|refactor|build|deploy)/i;

// 「模糊动作词」信号:出现敷衍/指代式动词(看看/搞定/处理/弄/整…)即视为「没说清要做
// 什么」。非锚定匹配 —— 即便夹带「顺便用在…上 / 用 khyos」之类连接口水话,只要主动作是
// 模糊动词且无具体指令动词(CONCRETE 优先),仍判为不清。注意只收敷衍动词,不收「查看
// a.txt」这类带明确对象的实义动词。
const VAGUE_VERB_RE = /(看看|看一?下|瞧瞧|瞅瞅|处理一?下|处理处理|搞定|搞一?下|搞搞|搞起|弄一?下|弄弄|整一?下|整整|帮我搞|帮我弄|帮我整|怎么弄|怎么搞|咋整|咋弄|你看着办|看着办|随便(?:弄|搞|整))/;

function _enabled(options = {}) {
  if (options && options.multimodalIntentRouter !== undefined) {
    return !['0', 'false', 'off', 'no'].includes(
      String(options.multimodalIntentRouter).trim().toLowerCase()
    );
  }
  const raw = String(process.env.KHY_MULTIMODAL_INTENT_ROUTER || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * 是否引用了 khyos 底座/内核(第 5 路输入)。保守 —— 零假阳性优先。
 * @param {string} text
 * @returns {boolean}
 */
function detectKhyosReference(text) {
  const t = String(text || '');
  if (!t) return false;
  if (KHYOS_TOKEN_RE.test(t)) return true;
  if (KHYOS_CN_RE.test(t)) return true;
  return false;
}

/**
 * 评估提示词是否清晰。保守:默认偏「清晰(不介入)」,只有空文本配媒体、或纯模糊指代
 * 才判为不清,避免把真正明确的提示词误判为模糊。
 * @param {string} text
 * @param {{hasMedia?:boolean}} [opts]
 * @returns {{clear:boolean, reason:string}}
 */
function assessPromptClarity(text, opts = {}) {
  const hasMedia = !!opts.hasMedia;
  const t = String(text || '').trim();
  if (!t) {
    return hasMedia
      ? { clear: false, reason: 'empty-prompt-with-media' }
      : { clear: true, reason: 'empty-no-media' };
  }
  // 具体动作+对象 → 清晰,无论长短。
  if (CONCRETE_INSTRUCTION_RE.test(t)) return { clear: true, reason: 'concrete-instruction' };
  // 剥离「khyos 引用令牌」与内联媒体路径后再判模糊:khyos / 媒体路径只是「输入对象引用」,
  // 不构成「要做什么」的指令,不应让一句模糊提示被误判为清晰。
  const residual = t
    .replace(KHYOS_TOKEN_RE, ' ')
    .replace(KHYOS_CN_RE, ' ')
    .replace(/["'`]?(?:file:\/\/|[A-Za-z]:[\\/]|\.{0,2}\/)[^\s"'`]+["'`]?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 剥离后为空(只剩对象引用,没有任何诉求)→ 不清。
  if (!residual) return { clear: false, reason: 'reference-only-no-instruction' };
  // 主动作是敷衍/指代式动词 → 不清(没说清要做什么)。
  if (VAGUE_VERB_RE.test(residual)) return { clear: false, reason: 'vague-verb' };
  // 其余视为足够具体,不介入。
  return { clear: true, reason: 'specific-enough' };
}

function _hasMeaningfulText(text) {
  // 去掉常见内联媒体路径令牌后仍有 ≥2 个非空白字符 → 视为有真实文本指令通道。
  const stripped = String(text || '')
    .replace(/["'`]?(?:file:\/\/|[A-Za-z]:[\\/]|\.{0,2}\/)[^\s"'`]+["'`]?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length >= 2;
}

/**
 * 构建分路 inventory(去重、按确定性优先级排序)。
 * @param {{mediaKinds?:string[], khyos?:boolean, hasText?:boolean}} input
 * @returns {Array<{channel:string,label:string}>}
 */
function buildInventory(input = {}) {
  const present = new Set();
  if (input.khyos) present.add('khyos');
  if (input.hasText) present.add('text');
  for (const kind of Array.isArray(input.mediaKinds) ? input.mediaKinds : []) {
    const k = String(kind || '').trim().toLowerCase();
    if (k === 'image' || k === 'audio' || k === 'video' || k === 'document' || k === 'archive') present.add(k);
  }
  return CHANNEL_ORDER
    .filter(ch => present.has(ch))
    .map(ch => ({ channel: ch, label: CHANNEL_LABELS[ch] || ch }));
}

/**
 * 构建「提示词不清 + 多路异构输入」的中文消歧指令(确定性,无随机)。
 * @param {Array<{channel:string,label:string}>} inventory
 * @returns {string}
 */
function buildMultimodalDisambiguationDirective(inventory = []) {
  const lines = [];
  lines.push('## 多模态输入识别 —— 提示词不清晰,务必「不混乱」地分别识别每一路输入');
  lines.push('本次用户**同时**提供了以下相互独立的输入通道。请分别对待:切勿张冠李戴、切勿相互混淆、切勿丢弃任何一路。');
  inventory.forEach((c, i) => {
    lines.push(`${i + 1}. ${c.label}`);
  });
  lines.push('');
  lines.push('处理规则:');
  lines.push('1. **逐路识别**:动手前,先用一句话分别说明你对每一路输入的理解(文本要表达什么诉求 / 图片画的是什么 / 音频与视频转写讲了什么 / 文档要点 / 压缩包内含哪些文件 / 「khyos」指的是本项目 KHY-OS 底座或内核,而**不是**某个媒体文件或文件名)。');
  lines.push('2. **不混淆**:图片内容不要当成音频内容;音频/视频转写不要当成文本指令;文档片段不要与图片 OCR 混为一谈;压缩包里的文件清单不是用户的文本指令;「khyos」是对本项目的引用,不是输入文件。');
  lines.push('3. **意图不清时**:用一行给出你对「用户最可能的综合意图」的判断,然后按**最稳妥、最可能有用**的方式推进;**绝不**静默地只挑其中一路而忽略其余,也**绝不**把多路内容混为一谈。');
  lines.push('4. 若多路之间确实无法判断关联,简要说明你的理解并就**最关键的一点**请用户确认,但仍要先给出可用的初步处理,不要空等。');
  lines.push('5. **确定性处理顺序**: khyos 项目上下文 → 文本指令 → 图片 → 文档 → 压缩包 → 音频 → 视频。');
  return lines.join('\n');
}

/**
 * 多模态意图路由主入口(单一真源)。
 * @param {object} input
 * @param {string} input.text           用户原始消息
 * @param {string[]} input.mediaKinds   已探测的模态种类(image/audio/video/document)
 * @param {number} [input.imageCount]
 * @param {Array} [input.nonImageMedia]
 * @param {string[]} [input.modes]      intentGate.detectModes().modes(模式活跃=提示词已明确)
 * @param {object} [input.options]      env 覆盖({multimodalIntentRouter})
 * @returns {{
 *   enabled:boolean, khyos:boolean,
 *   inventory:Array<{channel:string,label:string}>,
 *   heterogeneousCount:number,
 *   clarity:{clear:boolean,reason:string},
 *   modeActive:boolean,
 *   ambiguousMultimodal:boolean,
 *   directive:(string|null)
 * }}
 */
function routeMultimodalIntent(input = {}) {
  const options = input.options || {};
  const enabled = _enabled(options);
  const text = String(input.text || '');
  const mediaKinds = [...new Set((Array.isArray(input.mediaKinds) ? input.mediaKinds : [])
    .map(x => String(x || '').trim().toLowerCase())
    .filter(k => k === 'image' || k === 'audio' || k === 'video' || k === 'document' || k === 'archive'))];
  const modes = (Array.isArray(input.modes) ? input.modes : [])
    .map(m => String(m || '').trim().toLowerCase())
    .filter(Boolean);

  const khyos = detectKhyosReference(text);
  const hasText = _hasMeaningfulText(text);
  const inventory = buildInventory({ mediaKinds, khyos, hasText });

  // 异构通道计数:每一种 media kind + khyos 各算一路(文本通道不计入异构,因「媒体+文本」
  // 是常态)。≥2 路异构 → 多模态。
  const heterogeneousCount = mediaKinds.length + (khyos ? 1 : 0);

  const clarity = assessPromptClarity(text, { hasMedia: mediaKinds.length > 0 });
  // 任一意图模式活跃即代表用户已给出明确指令(goal/coding/...),本路由让位。
  const modeActive = modes.some(m => ['goal', 'ultrawork', 'coding', 'analyze', 'learn'].includes(m));

  const ambiguousMultimodal = enabled
    && !clarity.clear
    && !modeActive
    && heterogeneousCount >= 2;

  const directive = ambiguousMultimodal
    ? buildMultimodalDisambiguationDirective(inventory)
    : null;

  return {
    enabled,
    khyos,
    inventory,
    heterogeneousCount,
    clarity,
    modeActive,
    ambiguousMultimodal,
    directive,
  };
}

module.exports = {
  CHANNEL_LABELS,
  CHANNEL_ORDER,
  detectKhyosReference,
  assessPromptClarity,
  buildInventory,
  buildMultimodalDisambiguationDirective,
  routeMultimodalIntent,
};
