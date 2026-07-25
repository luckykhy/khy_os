'use strict';

/**
 * modelIdentityTruth.js — 「模型身份不可伪装」的确定性单一真源(纯叶子:零 IO、确定性、
 * 绝不抛、可单测)。
 *
 * 立场(用户目标 2026-07-04「杜绝模型的一切伪装;问它你是什么模型时,必须回答真实的供应
 * 渠道与真实的模型」):khyos 网关会把请求路由到不同后端(deepseek / sensenova / ollama /
 * 中转聚合……),而这些模型可能被微调成自称「我是 GPT-4 / 我是 Claude」,或含糊其辞不肯说
 * 真实来源。真正的供应渠道(adapter/provider)与真实模型(网关路由到的 model id)只有 khy
 * 网关知道 —— 这才是权威真值,绝不能被模型的自我叙述覆盖。
 *
 * 与「不信任模型自报」族([[answerVerifier]]/groundTruth)同源:那一族在生成后复核模型写出
 * 的算式/动作声称;本叶子专司**身份**这一条 —— 一前一后两层闭合「杜绝伪装」:
 *   ① 生成前(A 层):formatIdentityDirective 注入系统提示,命令模型如实报真实渠道+模型,
 *      绝不冒充其他 AI(接线于 selfProfile.formatForSystemPrompt)。
 *   ② 生成后(B 层):用户问身份 + 答复伪装/隐瞒 → buildTruthFooter 用网关**实际路由**的
 *      adapter/model 追加一段确定性真值脚注(接线于 aiGateway.finishResult 成功分支)。
 *
 * 零编造铁律:真值(渠道/模型)缺失时降级 —— 不臆造模型名,footer 只陈述已知部分或整体
 * 回退 null(接缝字节不变)。厂商家族判定用**正则家族词**(gpt/claude/gemini…)而非完整
 * 模型 id 字面量,既够判伪装,又不触发模型名硬编码守卫。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_MODEL_IDENTITY_TRUTH(默认开,仅显式
 * 0/false/off/no 关闭;关闭后 isEnabled 返 false、footer 与 directive 构造器返 null 或空串 →
 * 两接缝逐字节回退到「不注入指令 / 不追加脚注」)。父门控经 flagRegistry 集中判定,fail-soft 回退本地 CANON。
 *
 * @module services/modelIdentityTruth
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
      return reg.isFlagEnabled('KHY_MODEL_IDENTITY_TRUTH', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_MODEL_IDENTITY_TRUTH;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 真值脚注 / 指令块的首行标记,用于去重(接缝据此判断是否已追加过本段)。
const IDENTITY_MARKER = '【khyos 模型身份';

// 视为「无真值」的占位符(网关未解析时的哨兵),归一后落入此集合 → 当作缺失。
const _UNKNOWN_TOKENS = new Set(['', 'auto', 'unknown', 'none', 'null', 'undefined', 'default', '自动']);

/** 归一一个渠道/模型串:trim;占位符(auto/unknown/…)→ 空。 */
function _clean(v) {
  const s = String(v == null ? '' : v).trim();
  if (_UNKNOWN_TOKENS.has(s.toLowerCase())) return '';
  return s;
}

/**
 * 把网关的原始字段归一成规范真值 `{channel, model}`。channel 取 adapter/provider 中先命中
 * 的非占位串;model 取 model/servedModel 中先命中的非占位串。全缺 → 两者皆 ''(调用方据此
 * 判断「无真值可陈述」→ 降级/回退)。
 * @param {object} raw  {adapter, provider, channel, model, servedModel, requestedModel}
 * @returns {{channel:string, model:string}}
 */
function resolveTruth(raw = {}) {
  const r = raw || {};
  const channel = _clean(r.channel) || _clean(r.adapter) || _clean(r.provider);
  // requestedModel 是兜底:网关未回填 result.model 时,至少是本次显式路由的模型 id(仍是真值,
  // 不是编造 —— 它就是 khy 请求上游的那个模型)。
  const model = _clean(r.model) || _clean(r.servedModel) || _clean(r.requestedModel);
  return { channel, model };
}

// ── 用户身份提问识别 ─────────────────────────────────────────────────────────
// 保守但覆盖 CJK + 英文的自我身份询问。要求「自指」(你/your/you are)以免把「哪个模型最好」
// 这类非自指问题误判成身份询问。
const _IDENTITY_QUESTION_RES = [
  // 中文:你是什么/哪个/啥 模型|大模型;你(用的|背后|基于)…模型
  /你\s*(是|用的?是?|用的|背后(是|用的?)?|基于的?)\s*(什么|哪个|哪家|啥|何种)?\s*(大)?模型/,
  /你\s*(基于|用的?|背后是?)\s*(什么|哪个|啥)/,
  // 中文:你是谁(做的/开发/训练/研发)|你是哪家公司|你的(供应商/厂商/提供商/供应渠道/提供方)
  /你\s*是\s*谁\s*(做|开发|训练|研发|造|设计|发布)?/,
  /你\s*(是|来自|属于)\s*(哪家|哪个|哪间)\s*(公司|厂商|机构|团队)/,
  /你\s*(的|背后的?)\s*(供应商|厂商|提供商|供应渠道|提供方|模型提供商|服务商)/,
  // 中文:你是不是 GPT / 你是 Claude 吗
  /你\s*是\s*(不是\s*)?(gpt|chatgpt|claude|gemini|qwen|deepseek|文心|通义|豆包|llama|kimi)/i,
  // 英文:what/which model are you;what are you (based on);what llm are you
  /\bwh(at|ich)\s+(ai\s+)?(model|llm)\s+(are|r)\s+you\b/i,
  /\bwhat\s+are\s+you\s+(based\s+on|running\s+on|powered\s+by)\b/i,
  // 英文:who made/created/trained/developed/built you
  /\bwho\s+(made|created|trained|developed|built|designed)\s+you\b/i,
  // 英文:are you gpt/claude/…
  /\bare\s+you\s+(gpt|chatgpt|claude|gemini|qwen|deepseek|llama|a\s+(gpt|claude|language\s+model))\b/i,
  // 英文:your provider / which provider / what provider
  /\b(your|which|what)\s+(model\s+)?provider\b/i,
];

/**
 * 用户这句话是否在问「你(这个助手)是什么模型 / 谁做的 / 供应商是谁」。零假阳性偏向:
 * 只匹配明确自指的身份询问。空/非串 → false。
 * @param {string} text
 * @returns {boolean}
 */
function isIdentityQuestion(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return false;
  try {
    return _IDENTITY_QUESTION_RES.some((re) => re.test(s));
  } catch {
    return false;
  }
}

// ── 供应商/模型家族(用于判定答复是否声称了冲突身份)──────────────────────────
// 家族键 → 匹配该家族的正则(家族词,而非完整模型 id 字面量,以免触发模型名硬编码守卫)。
const _FAMILY_RES = {
  openai: /\b(openai|open\s?ai)\b|\bgpt\b|chatgpt|\bo[1-4]\b/i,
  anthropic: /\banthropic\b|\bclaude\b/i,
  google: /\b(google|deepmind)\b|\bgemini\b|\bbard\b|\bpalm\b/i,
  meta: /\bmeta\b|\bllama\b/i,
  deepseek: /deepseek/i,
  qwen: /\bqwen\b|通义|阿里/i,
  baidu: /文心|ernie|百度/i,
  moonshot: /\bkimi\b|moonshot|月之暗面/i,
  bytedance: /豆包|doubao|字节/i,
  mistral: /\bmistral\b|\bmixtral\b/i,
  xai: /\bgrok\b|\bx\.?ai\b/i,
};

/** 一段文本命中的家族键集合。 */
function _familiesIn(text) {
  const s = String(text || '');
  const out = new Set();
  for (const [key, re] of Object.entries(_FAMILY_RES)) {
    try { if (re.test(s)) out.add(key); } catch { /* skip */ }
  }
  return out;
}

/**
 * 归一模型/渠道串以便包含判定:小写、去空白与常见分隔符,便于「答复是否已含真实模型 id」比对。
 */
function _norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[\s._/:-]+/g, '');
}

/**
 * 判定答复相对真值是否「伪装或隐瞒」。真值缺 model 与 channel → 无从判定 → 不算伪装(disguised:false)。
 * 判据(满足其一即 disguised):
 *   - 答复声称了与真值家族**冲突**的供应商/模型家族(如真值 deepseek,答复自称 openai/claude);
 *   - 答复既未包含真实模型 id、也未包含真实渠道名 —— 即对身份问题避而不谈真实来源(隐瞒)。
 * @param {string} answer
 * @param {{channel:string, model:string}} truth
 * @returns {{disguised:boolean, reason:string}}
 */
function detectDisguise(answer, truth) {
  const t = truth || {};
  const channel = _clean(t.channel);
  const model = _clean(t.model);
  if (!channel && !model) return { disguised: false, reason: 'no-truth' };

  const ans = String(answer == null ? '' : answer);
  const ansNorm = _norm(ans);

  // 答复是否已如实点到真实模型 id 或真实渠道名 → 视为已透明。
  const mentionsModel = !!model && ansNorm.includes(_norm(model));
  const mentionsChannel = !!channel && ansNorm.includes(_norm(channel));

  // 真值自身命中的家族(渠道 + 模型合起来判定「我方阵营」)。
  const truthFamilies = new Set([..._familiesIn(channel), ..._familiesIn(model)]);
  const answerFamilies = _familiesIn(ans);

  // 冲突:答复声称了某家族,而该家族不在真值阵营里(且真值确有可比家族)。
  let conflict = false;
  if (answerFamilies.size > 0) {
    for (const fam of answerFamilies) {
      if (!truthFamilies.has(fam)) { conflict = true; break; }
    }
    // 真值无可辨家族时,无法据家族判冲突(避免误报),交由「隐瞒」判据处理。
    if (truthFamilies.size === 0) conflict = false;
  }

  if (conflict && !mentionsModel && !mentionsChannel) {
    return { disguised: true, reason: 'conflicting-family' };
  }
  if (!mentionsModel && !mentionsChannel) {
    return { disguised: true, reason: 'omits-truth' };
  }
  return { disguised: false, reason: mentionsModel ? 'mentions-model' : 'mentions-channel' };
}

/** 依据用户提问文本粗判 locale:含 CJK → 'zh',否则 'en'。 */
// 收敛到 utils/pickLocale 单一真源(逐字节委托,调用点不变)
const pickLocale = require('../utils/pickLocale');

/**
 * 从网关调用的 prompt / options 里挑出「用户当前这句话」。委托共享叶子 latestUserText:
 * 启用时优先取 options.messages 末轮 user 消息(修「footer 每轮都来」——网关传入的 prompt 是
 * 整条拍平会话,含引用触发问句的 system 指令,会让 isIdentityQuestion 每轮自命中);门控关 /
 * 叶子不可用 → 逐字节回退原「prompt 优先」行为。
 * @param {string} prompt
 * @param {object} [options]
 * @returns {string}
 */
function pickUserText(prompt, options) {
  try {
    return require('./latestUserText').pickUserText(prompt, options, process.env);
  } catch {
    // fail-soft(叶子不可用):原 prompt 优先行为
    const direct = String(prompt == null ? '' : prompt).trim();
    if (direct) return direct;
    try {
      const msgs = options && Array.isArray(options.messages) ? options.messages : [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content.trim();
        if (Array.isArray(m.content)) {
          const parts = m.content
            .map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content) || '')))
            .filter(Boolean);
          if (parts.length) return parts.join(' ').trim();
        }
      }
    } catch { /* fail-soft */ }
    return '';
  }
}

/**
 * 真值脚注:陈述真实供应渠道 + 真实模型。门控关 / 真值全缺 → null(接缝字节回退)。
 * 渠道或模型任一缺失 → 只陈述已知部分并诚实标注未解析,绝不编造。
 * @param {{channel:string, model:string}} truth
 * @param {object} [opts]  {locale, env}
 * @returns {string|null}
 */
function buildTruthFooter(truth, opts = {}) {
  if (!isEnabled(opts.env)) return null;
  const t = resolveTruth(truth);
  if (!t.channel && !t.model) return null;
  const locale = opts.locale === 'en' ? 'en' : 'zh';

  if (locale === 'en') {
    const chan = t.channel || '(unresolved by gateway)';
    const mdl = t.model || '(unresolved by gateway)';
    return `\n\n${IDENTITY_MARKER} · verified】This reply was generated by the real model "${mdl}" over the real supply channel "${chan}", as routed by the khy gateway. khyos does not allow models to disguise their identity — treat the gateway-routed backend above as authoritative.`;
  }
  const chan = t.channel || '(网关未解析)';
  const mdl = t.model || '(网关未解析)';
  return `\n\n${IDENTITY_MARKER} · 确定性核对】本次回复由真实供应渠道「${chan}」上的真实模型「${mdl}」生成(khy 网关实际路由)。khyos 不允许模型伪装身份;以上为网关路由的实际后端,以此为准。`;
}

/**
 * 系统提示反伪装指令块(A 层)。门控关 → ''(不注入,字节回退)。truth 的具体值可缺(系统
 * 提示装配时尚未发起请求),指令仍成立 —— 它命令模型以「运行时真实渠道/模型」为准并禁止冒充。
 * @param {{channel:string, model:string}} truth
 * @param {object} [opts]  {locale, env}
 * @returns {string}
 */
function formatIdentityDirective(truth, opts = {}) {
  if (!isEnabled(opts.env)) return '';
  const t = resolveTruth(truth || {});
  const locale = opts.locale === 'en' ? 'en' : 'zh';

  if (locale === 'en') {
    const known = [];
    if (t.channel) known.push(`channel = ${t.channel}`);
    if (t.model) known.push(`model = ${t.model}`);
    const knownLine = known.length
      ? `Your real runtime identity (from the khy gateway): ${known.join(', ')}.`
      : 'Your real runtime identity is set by the khy gateway (real supply channel + real model, resolved at request time; see the Adapter/Model line above).';
    return [
      '## Model identity is not to be disguised',
      `- ${knownLine}`,
      '- When the user asks what model you are, who made you, or which provider/channel you run on, answer with that REAL supply channel and REAL model. Do not deflect.',
      '- Never claim to be a different model or vendor, and never impersonate another AI (e.g. asserting you are GPT/Claude/Gemini without basis). State the truth from your runtime.',
      '- Your identity is PER-TURN and reflects the CURRENT route: the user can switch models/channels at any time, so reporting a different real model on a different turn is normal — NOT a self-contradiction.',
      '- If an earlier reply reported a different model, that was its real route AT THAT TIME and was correct. Do NOT apologize or say you "were wrong before"; just state your current model and, if relevant, note that the model was switched.',
      '- If you are unsure of the exact model id, say so plainly and point to the gateway — do not invent one.',
    ].join('\n');
  }

  const known = [];
  if (t.channel) known.push(`渠道 = ${t.channel}`);
  if (t.model) known.push(`模型 = ${t.model}`);
  const knownLine = known.length
    ? `你的真实运行身份(由 khy 网关决定):${known.join('、')}。`
    : '你的真实运行身份由 khy 网关决定:真实供应渠道见上方 Adapter、真实模型见上方 Model(具体值在请求时解析)。';
  return [
    '## 模型身份透明(不可伪装)',
    `- ${knownLine}`,
    '- 当用户问「你是什么模型 / 你是谁做的 / 你背后是什么模型 / 供应商(供应渠道)是谁」时,必须如实回答该真实供应渠道与真实模型,不得回避、不得含糊。',
    '- 绝不声称自己是另一个模型或厂商,绝不冒充其他 AI(如无依据地自称 GPT/Claude/Gemini 等);以你运行时的真实后端为准。',
    '- 你的身份**按轮次**取当前路由:用户可随时切换模型/渠道,不同轮次报不同的真实模型是正常的,不是前后矛盾。',
    '- 若某个较早的回复报的是另一个模型,那是它**当时**的真实路由、当时正确;**不要**因此道歉、不要说自己「之前说错了」——只需说明当前模型,必要时点出「已切换模型」。',
    '- 若你不确定确切的模型标识,直说不确定并指向网关,而不是编造一个。',
  ].join('\n');
}

module.exports = {
  isEnabled,
  IDENTITY_MARKER,
  resolveTruth,
  isIdentityQuestion,
  detectDisguise,
  pickLocale,
  pickUserText,
  buildTruthFooter,
  formatIdentityDirective,
};
