'use strict';

/**
 * visionRoutingTruth.js — 「视觉能力路由透明」的确定性单一真源(纯叶子:零 IO、确定性、
 * 绝不抛、可单测)。
 *
 * 立场(khyos 自审报告 #6「无原生多模态能力 + 路由链路不透明·当前主模型 glm-5.2 纯文本,
 * 视觉靠路由到别的模型,但路由目标/可用性/时延不可见,答不出『哪个 agnes 模型能看图』」)。
 *
 * 取证:项目**已有** `gateway/visionCapability.isVisionCapableModel` 这一「某 model 是否收图」
 * 的判定 SSOT,`multiFreeService.providers` 是各渠道 + availableModels 的注册表。缺的不是数据,
 * 是**回答层**:用户问「哪些模型支持图像识别 / 你能看图吗」时,`imageRecognitionIntent`
 * 的 `_META_QUESTION_RE` 只把它从「未检测到图片」误引导里**排除**(不劫持),却没人**据实回答**
 * ——正是报告说的「答不出哪个模型能看图 + 路由不透明」。
 *
 * 与「模型身份不可伪装」([[modelIdentityTruth]])、「缓存命中率如实上报」([[cacheMetricsTruth]])
 * 同族两层闭合,把「视觉能力 + 实际路由」变成确定性真值:
 *   ① 生成前(A 层):formatVisionDirective 注入系统提示,告知模型「本机主模型可能纯文本、
 *      视觉经网关改选视觉模型或本地 OCR 兜底」,被问视觉能力时据实答、并回显实际使用的模型
 *      (接线于 selfProfile.formatForSystemPrompt)。
 *   ② 生成后(B 层):用户问视觉能力 → buildVisionFooter 用 visionCapability SSOT 过滤注册表,
 *      确定性列出**具备视觉能力的真实模型**,并回显本轮**实际路由**的模型与其能否收图
 *      (接线于 aiGateway.finishResult 成功分支)。
 *
 * 零编造铁律:候选模型清单由接线层从真实注册表传入,叶子只做「用 SSOT 过滤 + 排序 + 措辞」;
 * 注册表空 + 实际模型未知 → footer 返 null(接缝字节不变)。绝不凭空杜撰模型名。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_VISION_ROUTING_TRUTH(默认开,仅显式
 * 0/false/off/no 关闭;关闭后 isEnabled 返 false、footer 与 directive 构造器
 * 返 null/'' → 两接缝逐字节回退)。父门控经 flagRegistry 集中判定(CANON 词表),fail-soft 回退本地 CANON。
 *
 * @module services/visionRoutingTruth
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。优先走 flagRegistry(集中优先级 + dogfood),不可用时回退本地 CANON 词表。
 * 默认开,仅显式 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_VISION_ROUTING_TRUTH', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_VISION_ROUTING_TRUTH;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 视觉真值脚注 / 指令块的首行标记,用于去重(接缝据此判断是否已追加过本段)。
const VISION_MARKER = '【khyos 视觉能力';

// ── 用户视觉能力提问识别 ─────────────────────────────────────────────────────
// 保守但覆盖 CJK + 英文的「问视觉/多模态能力」。要求**问句语气**或明确的能力询问,
// 以免把「识别这张图」(命令、非提问)误判成能力提问 —— 那类由 imageRecognitionIntent 处理。
const _VISION_QUESTION_RES = [
  // 中文:哪些/那些 模型 支持 图像识别/视觉/看图/多模态
  /(哪些|那些|哪个|什么)\s*模型?.{0,8}(支持|能|可以)?.{0,4}(图像识别|图片识别|识别图|视觉|看图|读图|多模态)/,
  // 中文:你(能|可以|支持)…看图/图像识别/多模态(吗/么/?)
  /你.{0,6}(能|可以|支持|会|是)?.{0,6}(看图|读图|图像识别|图片识别|识别图片|视觉输入|多模态).{0,4}(吗|么|不|嘛|\?|？)?/,
  // 中文:你是(不是)多模态(模型)吗
  /你\s*是\s*(不是\s*)?多模态/,
  // 中文:支持视觉/图像 输入 吗
  /(支持|有).{0,4}(视觉|图像|图片)\s*(输入|识别|能力)/,
  // 英文:which/what models support vision/images/multimodal
  /\bwh(ich|at)\s+models?\b.{0,20}\b(vision|image|images|multimodal|see\s+images?|ocr)\b/i,
  // 英文:can you / do you (see|read) images ; are you multimodal ; do you support vision
  /\b(can|do)\s+you\b.{0,16}\b(see|read|understand|process|analy[sz]e|support)\b.{0,12}\b(image|images|picture|photo|vision|screenshot)\b/i,
  /\bare\s+you\s+(a\s+)?multimodal\b/i,
  /\bdo\s+you\s+support\s+(vision|image|multimodal)\b/i,
];

/**
 * 用户这句是否在问「哪些模型支持视觉 / 你能不能看图 / 你是多模态吗」。零假阳性偏向:
 * 只匹配明确的能力**提问**,不匹配「识别这张图」这类识图**命令**。空/非串 → false。
 * @param {string} text
 * @returns {boolean}
 */
function isVisionQuestion(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return false;
  try {
    return _VISION_QUESTION_RES.some((re) => re.test(s));
  } catch {
    return false;
  }
}

/** 依据用户提问文本粗判 locale:含 CJK → 'zh',否则 'en'。 */
// 收敛到 utils/pickLocale 单一真源(逐字节委托,调用点不变)
const pickLocale = require('../utils/pickLocale');

/**
 * 从网关调用的 prompt / options 里挑出「用户当前这句话」。委托共享叶子 latestUserText(修
 * 「footer 每轮都来」:网关传入的 prompt 是整条拍平会话,含引用触发问句的 system 指令,会让
 * isVisionQuestion 每轮自命中)。门控关 / 叶子不可用 → 逐字节回退原「prompt 优先」行为。
 * @param {string} prompt
 * @param {object} [options]
 * @returns {string}
 */
const pickUserText = require('../utils/pickUserTextSafe');

/** 取候选项的 model id(串,或 {id/model/name} 对象)。 */
function _candidateId(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim();
  if (typeof item === 'object') return String(item.id || item.model || item.name || '').trim();
  return '';
}

/** 取候选项附带的渠道名(便于分组展示),缺则空串。 */
function _candidateChannel(item) {
  if (item && typeof item === 'object') {
    return String(item.provider || item.channel || item.adapter || '').trim();
  }
  return '';
}

/**
 * 用 visionCapability SSOT 把候选模型清单分成「具备视觉能力」与「纯文本」两组。
 * 去重(按小写 id),保持传入顺序=优先级。SSOT 不可用 → 空分组(调用方据此降级)。
 *
 * @param {Array<string|{id?:string,model?:string,name?:string,provider?:string}>} candidates
 * @param {{env?:object}} [opts]
 * @returns {{vision:Array<{id:string,channel:string}>, textOnly:Array<{id:string,channel:string}>}}
 */
function classifyModels(candidates, opts = {}) {
  const o = opts || {};
  const out = { vision: [], textOnly: [] };
  if (!Array.isArray(candidates)) return out;
  let vc = null;
  try { vc = require('./gateway/visionCapability'); } catch { vc = null; }
  if (!vc || typeof vc.isVisionCapableModel !== 'function') return out;

  const seen = new Set();
  for (const item of candidates) {
    const id = _candidateId(item);
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { id, channel: _candidateChannel(item) };
    let capable = false;
    try { capable = !!vc.isVisionCapableModel(id, { env: o.env || process.env }); } catch { capable = false; }
    (capable ? out.vision : out.textOnly).push(entry);
  }
  return out;
}

/** 一组 {id,channel} 渲染为「id(渠道)」短串,去重后按 id 排序,capped。 */
function _renderModelList(entries, cap) {
  const items = Array.isArray(entries) ? entries.slice() : [];
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const limit = Number.isFinite(cap) && cap > 0 ? cap : 12;
  const shown = items.slice(0, limit).map((e) => (e.channel ? `${e.id}(${e.channel})` : e.id));
  const extra = items.length - shown.length;
  return { text: shown.join('、'), extra: extra > 0 ? extra : 0 };
}

/**
 * 视觉能力真值脚注(B 层)。用 SSOT 过滤后的候选,确定性列出具备视觉能力的真实模型,
 * 并回显本轮实际路由的模型与其能否收图。门控关 / 无任何可陈述真值 → null(接缝字节回退)。
 *
 * @param {object} facts
 * @param {Array} [facts.candidates]        真实注册表模型清单(接线层传入)
 * @param {string} [facts.activeModel]      本轮实际路由的模型 id
 * @param {boolean}[facts.activeSupportsVision] 本轮实际模型能否收图(接线层用 SSOT 判定后传入)
 * @param {object} [opts]  {locale, env}
 * @returns {string|null}
 */
function buildVisionFooter(facts = {}, opts = {}) {
  const o = opts || {};
  if (!isEnabled(o.env)) return null;
  const f = facts || {};
  const cls = classifyModels(Array.isArray(f.candidates) ? f.candidates : [], { env: o.env });
  const active = String(f.activeModel == null ? '' : f.activeModel).trim();
  const activeKnown = active && !/^(auto|unknown|none|default|自动)$/i.test(active);
  const hasVisionList = cls.vision.length > 0;

  // 无任何可陈述真值(既无视觉模型清单,又不知实际模型)→ 降级不追加。
  if (!hasVisionList && !activeKnown) return null;

  const locale = o.locale === 'en' ? 'en' : 'zh';
  const activeVision = f.activeSupportsVision === true;

  if (locale === 'en') {
    const lines = [`\n\n${VISION_MARKER} · verified】khy gateway vision routing (authoritative):`];
    if (activeKnown) {
      lines.push(`- This turn's actual model: "${active}" — ${activeVision ? 'CAN accept image input' : 'text-only (cannot accept images directly)'}.`);
    }
    if (hasVisionList) {
      const { text, extra } = _renderModelList(cls.vision, 12);
      lines.push(`- Vision-capable models available for routing: ${text}${extra ? ` (+${extra} more)` : ''}.`);
    } else {
      lines.push('- No vision-capable model is currently registered for routing.');
    }
    if (!activeVision) {
      lines.push('- For images, the gateway auto-selects a vision-capable model above; if none is reachable it falls back to local OCR (Tesseract) for text in the image.');
    }
    return lines.join('\n');
  }

  const lines = [`\n\n${VISION_MARKER} · 确定性核对】khy 网关视觉路由(以此为准):`];
  if (activeKnown) {
    lines.push(`- 本轮实际模型:「${active}」——${activeVision ? '可直接接受图像输入' : '纯文本模型,不能直接收图'}。`);
  }
  if (hasVisionList) {
    const { text, extra } = _renderModelList(cls.vision, 12);
    lines.push(`- 可路由的具备视觉能力的真实模型:${text}${extra ? `(另有 ${extra} 个)` : ''}。`);
  } else {
    lines.push('- 当前注册表中没有可路由的视觉模型。');
  }
  if (!activeVision) {
    lines.push('- 识图时网关会自动改选上述视觉模型;若都不可达,则回退本地 OCR(Tesseract)识别图中文字。');
  }
  return lines.join('\n');
}

/**
 * 系统提示视觉透明指令块(A 层)。门控关 → ''(不注入,字节回退)。
 * @param {object} [opts]  {locale, env}
 * @returns {string}
 */
function formatVisionDirective(opts = {}) {
  const o = opts || {};
  if (!isEnabled(o.env)) return '';
  const locale = o.locale === 'en' ? 'en' : 'zh';

  if (locale === 'en') {
    return [
      '## Vision capability is routed, not native — be transparent',
      '- Your primary model may be TEXT-ONLY. Image input is handled by the khy gateway, which auto-selects a vision-capable model, or falls back to local OCR (Tesseract) for text in the image.',
      '- When the user asks whether you can see images, which models support vision, or if you are multimodal, answer truthfully from the gateway: name the real vision-capable model(s) and the actual model used this turn. Do not claim native vision you do not have, and do not deny a capability the gateway can route.',
      '- If no vision model is reachable, say so plainly and mention the OCR fallback — do not pretend to have seen an image you could not.',
    ].join('\n');
  }
  return [
    '## 视觉能力是「路由」而非原生 —— 保持透明',
    '- 你的主模型可能是**纯文本**。图像输入由 khy 网关处理:网关会自动改选具备视觉能力的模型,或回退本地 OCR(Tesseract)识别图中文字。',
    '- 当用户问「你能不能看图 / 哪些模型支持图像识别 / 你是不是多模态」时,据网关如实回答:说出真实具备视觉能力的模型、以及本轮实际使用的模型。不要谎称拥有你并不具备的原生视觉,也不要否认网关其实能路由的能力。',
    '- 若当前没有可用的视觉模型,直说,并说明会用 OCR 兜底 —— 绝不假装看到了其实没看到的图。',
  ].join('\n');
}

module.exports = {
  isEnabled,
  VISION_MARKER,
  isVisionQuestion,
  pickLocale,
  pickUserText,
  classifyModels,
  buildVisionFooter,
  formatVisionDirective,
};
