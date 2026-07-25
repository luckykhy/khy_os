'use strict';

/**
 * intentGate.js
 *
 * Keyword-triggered mode injection before the tool-use loop starts.
 * Mode support:
 *   - goal              — goal-driven fully autonomous execution (highest priority)
 *   - ultrawork / ulw   — high-agency autonomous execution
 *   - coding            — project creation / implementation tasks
 *   - analyze           — deep analysis / code review tasks
 *
 * Keywords inside fenced or indented code blocks are ignored.
 */

const CODE_BLOCK_RE = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[^\n]*|(?:(?:^|\n)(?:    |\t)[^\n]*)+/gm;
const GOAL_TRIGGER_RE = /^(?:goal|目标)[：:\s]+(.+)/is;
const ULTRAWORK_TRIGGER_RE = /(^|[^a-z0-9_])(ultrawork|ulw)(?=$|[^a-z0-9_])/i;

// Coding mode: project scaffolding, multi-file creation, build tasks
// 收窄触发范围：仅匹配明确的"创建/搭建/开发项目"意图
// 不再匹配单独的框架名（如 React/Vue/Express），避免讨论框架时误触发
const CODING_TRIGGER_RE = /(创建[\s\S]{0,10}(?:项目|工程|应用)|新建[\s\S]{0,10}(?:工程|项目)|scaffold|create\s+(?:a\s+)?(?:new\s+)?project|new\s+project|init\s+project|写一个[\s\S]{0,20}(?:项目|工程|应用|服务|系统|网站)|build\s+a[\s\S]{0,20}(?:app|project|server|website|api)|搭建[\s\S]{0,20}(?:项目|工程|环境|系统)|setup\s+(?:a\s+)?(?:new\s+)?project|bootstrap\s+(?:a\s+)?project|开发[\s\S]{0,10}(?:项目|应用|网站|后端|前端|系统|服务|小程序)|做一个[\s\S]{0,20}(?:项目|应用|网站|后端|前端|系统|服务)|帮我写[\s\S]{0,20}(?:项目|服务|后端|前端|网站)|full[\s-]?stack|create[-\s]react[-\s]app|vite\s+create|cargo\s+new|go\s+mod\s+init|npm\s+init|maven项目|gradle项目|create\s+(?:a\s+)?(?:react|vue|next(?:\.js)?|nestjs|gin|tauri|electron)[\s\S]{0,24}(?:app|project|api|server|service|microservice)?|setup\s+(?:a\s+)?(?:new\s+)?next(?:\.js)?[\s\S]{0,16}project|微信小程序|小程序)/i;

// Analyze mode: deep analysis, code review (excludes bare "分析" to avoid false positives)
const ANALYZE_TRIGGER_RE = /(深度分析|全面分析|综合分析|代码审查|code\s*review|architecture\s*review|性能分析|performance\s*analysis|安全审计|security\s*audit)/i;

// Learn mode: KHY OS learning / teaching requests
const LEARN_TRIGGER_RE = /(教我[\s\S]{0,20}(?:KHY|khy|Khy|项目|系统|架构|代码|工具|网关|CLI|REPL|量化|工具循环|前端|内核)|学习[\s\S]{0,10}(?:KHY|khy|Khy|项目|系统|架构)|KHY[\s\S]{0,10}(?:怎么|如何|是什么|原理|机制|设计)|teach\s+me[\s\S]{0,20}(?:KHY|khy|project|system|architecture)|learn\s+(?:about\s+)?(?:KHY|khy|the\s+project|the\s+system)|从零学习|从头学习|系统学习[\s\S]{0,10}KHY)/i;

// ── Teaching intent (借鉴分析 #5): teach-vs-delegate split ────────────────────
// A teaching statement records a preference / rule / persona trait onto the
// ACTIVE companion's AgentFS assets instead of being executed as a task.
//   persona-trait → persona.md, red line → principles.md, preference → memory.
// Persona has highest specificity, then principles (red lines), then memory.
const TEACH_PERSONA_RE = /^\s*(?:你是|你叫|你的名字(?:是|叫)?|你的角色是?|你扮演|你应该(?:是|扮演)|act\s+as\b|you\s+are\b|your\s+name\s+is\b)/i;
const TEACH_PRINCIPLE_RE = /(绝不|永远不(?:要|得|能)|从不|禁止|不准|不允许|never\s+(?:ever\s+)?|don'?t\s+ever|must\s+not|不可以)/i;
const TEACH_PREFERENCE_RE = /(以后|从现在(?:开始|起)|今后|往后|记住[:：]?|请记住|note\s+that|from\s+now\s+on|always\b|总是|每次都|默认(?:用|使用|采用))/i;

// ── Interrogative guard (anti-hijack) ────────────────────────────────────────
// A QUESTION about the model ("你是小米开发的模型吗？", "你是什么模型") is chitchat
// to be answered, NOT a teaching statement to record onto a companion. Two tiers
// keep a genuine DECLARATIVE teach ("你叫小爱同学", "你是我的专属助手") from being
// dropped:
//   STRONG — unambiguous yes/no questions: a question mark, a sentence-final
//     particle (吗/呢/吧), or an A-not-A / 是否 structure. These almost never
//     appear in a real teaching statement, so they veto ANY target.
//   WH — content-question words (什么/谁/哪/为什么/怎么…). These can sit inside a
//     declarative rule ("绝不要问我为什么"), so they only veto the PERSONA target,
//     whose match ("你是…") has no directive anchor and is the form that hijacks
//     chitchat like "你是什么模型".
const STRONG_QUESTION_RE = /[?？]|(?:吗|呢|吧)\s*[?？!！。.~～\s]*$|是不是|是否|有没有|能不能|会不会|可不可以|对不对|难道|莫非/u;
const WH_QUESTION_RE = /(什么|啥|为什么|为何|怎么|怎样|咋样?|如何|多少|哪(?:个|些|里|儿|样|种)?|谁)/;

// Task verbs short-circuit teaching: an imperative request to DO something wins.
const TASK_VERB_RE = /(帮我|帮忙|请(?:你)?(?:帮|写|做|生成|创建|执行|运行|查|找|改|修复|分析|总结)|写一[篇个封份]|生成|创建|执行|运行|跑一下|查一下|搜索|修复|重构|部署|发布|计算|画(?:一)?[个张]|\bwrite\s+(?:a|me|an)\b|\bcreate\b|\bgenerate\b|\brun\b|\bexecute\b|\bfix\b|\bbuild\b|\bmake\s+(?:me|a)\b|\bsearch\b|\bfind\b)/i;

/**
 * True when `text` reads as an interrogative that must NOT be captured as a
 * teaching statement. `target` is the tentatively-matched teach target; WH-word
 * questions only veto 'persona' (see the tier note above).
 * @param {string} text
 * @param {string} target
 * @returns {boolean}
 */
function looksInterrogative(text, target) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (STRONG_QUESTION_RE.test(t)) return true;
  if (target === 'persona' && WH_QUESTION_RE.test(t)) return true;
  return false;
}

// ── Role-framed request guard (anti-misfire) ─────────────────────────────────
// "你是一个客观严苛的架构师，请对X做一个公正的评价" assigns a ROLE only to FRAME a
// one-shot deliverable — it is delegation, not a durable persona to record onto a
// companion. The global TASK_VERB_RE misses this when 请 is not immediately
// followed by a listed verb ("请在…比较后…做") or the ask uses an evaluative verb
// (评价/评估/比较/点评…) that is outside that list. Like the WH interrogative tier,
// this guard vetoes ONLY the persona target: a genuine persona teaching
// ("你是我的专属助手", "你叫小爱同学", "你是一个善于总结的人") carries no concrete
// deliverable request and is therefore left untouched.
//   A — a polite request marker (请/麻烦/劳烦/please…) followed, in proximity, by an
//       output/evaluation verb (评价/比较/分析/review/compare…).
//   B — a "做/写/出/给出 一[个张份篇] …(评价|分析|报告…)" deliverable-noun construction.
// 帮我/帮忙 are deliberately NOT markers here: they already short-circuit earlier via
// TASK_VERB_RE, and a bare 帮 would misfire on traits like "善于帮人分析的助手".
const ROLE_REQUEST_MARKER = '请|麻烦你?|劳烦|烦请|有劳|\\bplease\\b';
const OUTPUT_VERB = [
  '评价', '评估', '测评', '点评', '评判', '评论', '评审', '审查', '审阅', '比较', '对比',
  '分析', '剖析', '总结', '复盘', '梳理', '概括', '综述', '盘点', '讲解', '介绍', '推荐',
  '描述', '说说', '谈谈', '聊聊', '打分', '排名', '排序', '看法', '建议', '意见',
  'evaluate', 'review', 'compare', 'contrast', 'analy[sz]e', 'assess', 'critique',
  'summari[sz]e', 'rate', 'rank', 'describe', 'recommend', 'give\\s+(?:a|an|your|me)\\b',
].join('|');
const DELIVERABLE_NOUN = [
  '评价', '评估', '分析', '总结', '报告', '点评', '对比', '比较', '建议', '意见', '看法',
  '方案', '综述', '复盘', '测评', '排名',
  'evaluation', 'review', 'comparison', 'assessment', 'critique', 'analysis', 'summary',
  'feedback', 'opinion', 'breakdown',
].join('|');
const ROLE_FRAMED_REQUEST_RE = new RegExp(
  // A: 请/please … (≤60 non-sentence-break chars) … output/evaluation verb
  `(?:${ROLE_REQUEST_MARKER})[^。！？.!?\\n]{0,60}?(?:${OUTPUT_VERB})`
  // B: 做/写/出/给出/来/提供 一[个张份篇] … deliverable noun  (or English give a/an <noun>)
  + `|(?:做|写|出|给出|来|提供)\\s*一?\\s*[个张份篇](?:[^。！？.!?\\n]{0,12}?)?(?:${DELIVERABLE_NOUN})`
  + `|\\bgive\\s+(?:a|an|your|me)\\s+[^.!?\\n]{0,16}?(?:${DELIVERABLE_NOUN})`,
  'i',
);

/**
 * True when a `你是…`-framed message is actually a one-shot delegated request
 * (role-play framing + a concrete deliverable ask) rather than a durable persona
 * to capture. Vetoes ONLY the persona target.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeRoleFramedRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return ROLE_FRAMED_REQUEST_RE.test(t);
}


const GOAL_DIRECTIVE = [
  '## GOAL MODE 已激活 — 目标驱动全自主执行模式。',
  '用户给定了一个明确目标，你必须全权自主完成，不主动询问用户。',
  '1. 先制定简洁执行计划 (3-8 步)。',
  '2. 按计划逐步执行，每步使用工具直接完成。',
  '3. 遇到阻碍时自行排查修复，不要停下来等待指示。',
  '4. 批量并行执行独立任务以提高效率。',
  '5. 完成后自行验证交付物的正确性和完整性。',
  '6. 最终输出简洁的完成报告: 做了什么、交付物清单、关键结果。',
].join('\n');

const ULTRAWORK_DIRECTIVE = [
  '## ULTRAWORK mode activated by user keyword.',
  'Operate in high-agency execution mode:',
  '1. Create a short execution plan (2-5 concrete steps) and keep it updated.',
  '2. Prefer direct tool actions over long speculation.',
  '3. Batch or parallelize independent work when safe.',
  '4. If a step fails, retry with a different tactic and explain the delta.',
  '5. Continue until the goal is completed or a real blocker is proven.',
].join('\n');

const CODING_DIRECTIVE = [
  '## CODING mode — 项目创建/实现任务。',
  '以高级工程师标准交付，核心原则：',
  '1. 先规划项目结构（目录、关键文件、分层），再动手写代码。',
  '2. 优先使用 projectTemplate + scaffoldFiles 批量创建，不要逐文件 Write。',
  '3. 写真实业务逻辑，禁止硬编码 mock 数据。配置文件必须完整可用。',
  '4. 缺少工具时自行安装，不要停下来等指示。',
  '5. 完成后运行构建/编译验证，失败则修复后重试。',
  '6. 最终输出: 做了什么、如何启动、关键文件说明。',
  '7. check required tools exist first; if missing, install it proactively.',
  '8. Backend layering: controller/service/model/config. Frontend layering: components/pages/hooks/utils.',
  '9. Include Dockerfile (multi-stage build), docker-compose.yml (docker compose up), and .dockerignore.',
  '10. Include test/runtime artifacts: unit_tests/, API_tests/, run_tests.sh, README.md.',
  '11. API responses should follow structured JSON format: {code, msg, data}.',
  '12. Add input validation, guard against SQL injection, and keep clear logging.',
  '13. When using UI framework, provide explicit loading states.',
  '14. NEVER use hardcoded mock data for delivered business logic.',
  '15. Final step: summarize key changes and run Post-Completion Gate to automatically verify.',
].join('\n');

const ANALYZE_DIRECTIVE = [
  '## ANALYZE mode activated — deep analysis/review task detected.',
  'Operate in thorough analysis mode:',
  '1. Read all relevant source files before forming conclusions.',
  '2. Use grep/glob to find related code across the codebase.',
  '3. Provide concrete evidence (file paths, line numbers, code snippets) for every claim.',
  '4. Structure output with clear sections: findings, impact, recommendations.',
  '5. Do not speculate — verify every assertion by reading the actual code.',
].join('\n');

const LEARN_DIRECTIVE = [
  '## LEARN mode — KHY OS 交互式教学模式。',
  '用户想从零学习 KHY OS 项目。你是 KHY OS 的教学助手。',
  '1. 根据用户的具体问题，先确定属于哪一层课程（0-9），推荐对应知识点。',
  '2. 读取实际源码讲解，不要凭空编造代码。',
  '3. 用通俗语言解释概念，面向零基础用户。',
  '4. 给出小练习让用户动手尝试。',
  '5. 提示用户使用 learn <层号> 或 learn next 继续学习。',
  '课程体系: 0-项目总览 1-启动链路 2-CLI路由 3-AI网关 4-工具系统 5-工具循环 6-REPL交互 7-量化核心 8-前端系统 9-高级子系统',
].join('\n');

function _firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text) return text;
  }
  return '';
}

function _parseBoolean(value) {
  if (value === true || value === false) return value;
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!text) return undefined;
  if (['1', 'true', 'yes', 'on', 'y'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(text)) return false;
  return undefined;
}

function _resolveUltraworkChatOpts(options = {}) {
  const preferredModel = _firstNonEmpty(
    options.ultraworkModel,
    process.env.KHY_ULTRAWORK_MODEL,
    process.env.KHY_ULTRAWORK_PREFERRED_MODEL,
  );
  const preferredAdapter = _firstNonEmpty(
    options.ultraworkAdapter,
    process.env.KHY_ULTRAWORK_ADAPTER,
    process.env.KHY_ULTRAWORK_PREFERRED_ADAPTER,
  );
  const strict = _parseBoolean(
    options.ultraworkStrict !== undefined
      ? options.ultraworkStrict
      : process.env.KHY_ULTRAWORK_PREFERRED_STRICT,
  );

  const patch = {};
  if (preferredModel) patch.preferredModel = preferredModel;
  if (preferredAdapter) patch.preferredAdapter = preferredAdapter;
  if (strict !== undefined) {
    patch.preferredStrict = strict;
    patch.strictPreferred = strict;
  }
  // Force tool use for first iterations in ultrawork mode
  const forceToolChoice = _parseBoolean(
    process.env.KHY_ULTRAWORK_FORCE_TOOL_CHOICE,
  );
  if (forceToolChoice !== false) patch._intentToolChoice = 'required';
  return patch;
}

function _resolveCodingChatOpts(options = {}) {
  const preferredModel = _firstNonEmpty(
    options.codingModel,
    process.env.KHY_CODING_MODEL,
  );
  const patch = {};
  if (preferredModel) patch.preferredModel = preferredModel;
  // Force tool use for first iterations in coding mode
  const forceToolChoice = _parseBoolean(
    process.env.KHY_CODING_FORCE_TOOL_CHOICE,
  );
  if (forceToolChoice !== false) patch._intentToolChoice = 'required';
  return patch;
}

function _resolveAnalyzeChatOpts(options = {}) {
  const preferredModel = _firstNonEmpty(
    options.analyzeModel,
    process.env.KHY_ANALYZE_MODEL,
  );
  const patch = {};
  if (preferredModel) patch.preferredModel = preferredModel;
  return patch;
}

function _resolveGoalChatOpts(options = {}) {
  const preferredModel = _firstNonEmpty(
    options.goalModel,
    process.env.KHY_GOAL_MODEL,
  );
  const patch = {};
  if (preferredModel) patch.preferredModel = preferredModel;
  // Goal mode always forces tool use
  patch._intentToolChoice = 'required';
  return patch;
}

function removeCodeBlocks(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(CODE_BLOCK_RE, '\n');
}

function detectModes(text) {
  const cleaned = removeCodeBlocks(String(text || ''));

  const goalMatch = cleaned.match(GOAL_TRIGGER_RE);
  const goal = !!goalMatch;

  const ultraworkMatch = cleaned.match(ULTRAWORK_TRIGGER_RE);
  const ultrawork = !!ultraworkMatch;

  const codingMatch = cleaned.match(CODING_TRIGGER_RE);
  const coding = !!codingMatch;

  const analyzeMatch = cleaned.match(ANALYZE_TRIGGER_RE);
  const analyze = !!analyzeMatch;

  const learnMatch = cleaned.match(LEARN_TRIGGER_RE);
  const learn = !!learnMatch;

  const modes = [];
  if (goal) modes.push('goal');
  if (ultrawork) modes.push('ultrawork');
  if (coding) modes.push('coding');
  if (analyze) modes.push('analyze');
  if (learn) modes.push('learn');

  return {
    goal,
    goalText: goal ? String(goalMatch[1] || '').trim() : null,
    ultrawork,
    coding,
    analyze,
    learn,
    trigger: ultrawork ? String(ultraworkMatch[2] || '').toLowerCase() : null,
    codingTrigger: coding ? String(codingMatch[1] || '') : null,
    analyzeTrigger: analyze ? String(analyzeMatch[1] || '') : null,
    learnTrigger: learn ? String(learnMatch[1] || '') : null,
    modes,
  };
}

function applyIntentGate(message, options = {}) {
  const original = String(message || '');
  const detected = detectModes(original);

  const directives = [];
  let chatOptsPatch = {};

  // goal: highest priority — fully autonomous goal-driven mode
  if (detected.goal) {
    const directive = String(options.goalDirective || GOAL_DIRECTIVE).trim();
    if (directive) directives.push({ mode: 'goal', trigger: detected.goalText, text: directive });
    chatOptsPatch = { ...chatOptsPatch, ..._resolveGoalChatOpts(options) };
  }

  // ultrawork: highest priority autonomous mode
  if (detected.ultrawork) {
    const directive = String(options.ultraworkDirective || ULTRAWORK_DIRECTIVE).trim();
    if (directive) directives.push({ mode: 'ultrawork', trigger: detected.trigger, text: directive });
    chatOptsPatch = { ...chatOptsPatch, ..._resolveUltraworkChatOpts(options) };
  }

  // coding: project creation / implementation mode (combinable with ultrawork)
  if (detected.coding) {
    let codingText = String(options.codingDirective || CODING_DIRECTIVE).trim();

    // Inject platform context so the AI knows the environment without a tool call
    try {
      const { getPlatform } = require('../tools/platformUtils');
      const platform = getPlatform();
      codingText += `\nEnvironment: Platform=${platform}, Node=${process.version}, Arch=${process.arch}.`;
    } catch { /* platformUtils not available — skip */ }

    // Append template hint if a matching template is available
    try {
      const { matchTemplate } = require('./projectTemplateService');
      const matched = matchTemplate(original);
      if (matched) {
        codingText += `\nTemplate "${matched.name}" is available. Use the projectTemplate tool to load it (template: "${matched.name}"), then pass the rendered output directly to scaffoldFiles.`;
      }
    } catch { /* projectTemplateService not available — skip hint */ }
    if (codingText) directives.push({ mode: 'coding', trigger: detected.codingTrigger, text: codingText });
    chatOptsPatch = { ...chatOptsPatch, ..._resolveCodingChatOpts(options) };
  }

  // analyze: deep analysis / review mode
  if (detected.analyze) {
    const directive = String(options.analyzeDirective || ANALYZE_DIRECTIVE).trim();
    if (directive) directives.push({ mode: 'analyze', trigger: detected.analyzeTrigger, text: directive });
    chatOptsPatch = { ...chatOptsPatch, ..._resolveAnalyzeChatOpts(options) };
  }

  // learn: KHY OS interactive learning mode
  if (detected.learn) {
    const directive = String(options.learnDirective || LEARN_DIRECTIVE).trim();
    if (directive) directives.push({ mode: 'learn', trigger: detected.learnTrigger, text: directive });
  }

  if (directives.length === 0) {
    return {
      message: original,
      systemDirective: '',
      activatedModes: detected.modes,
      directives: [],
      chatOptsPatch,
      detection: detected,
    };
  }

  const injected = directives.map(d => d.text).join('\n\n');
  return {
    message: original,
    systemDirective: injected,
    activatedModes: detected.modes,
    directives,
    chatOptsPatch,
    detection: detected,
  };
}

/**
 * Get combined acceptance criteria for a set of activated modes.
 * @param {string[]} modes - e.g. ['coding'], ['ultrawork', 'coding']
 * @returns {Array} Criterion objects from acceptanceCriteria.js
 */
function getAcceptanceCriteria(modes) {
  const { MODE_ACCEPTANCE } = require('./acceptanceCriteria');
  const criteria = [];
  for (const mode of (modes || [])) {
    const modeCriteria = MODE_ACCEPTANCE[mode];
    if (Array.isArray(modeCriteria)) {
      criteria.push(...modeCriteria);
    }
  }
  return criteria;
}

/**
 * Return mode-specific loop iteration boosts for toolUseLoop (outer) and ai.js (inner).
 * @param {string[]} modes - Activated mode names (e.g. ['coding', 'ultrawork'])
 * @returns {{ outerBoost: number, innerBoost: number }}
 */
function getLoopLimitBoost(modes) {
  if (!Array.isArray(modes) || modes.length === 0) return { outerBoost: 0, innerBoost: 0 };
  if (modes.includes('goal'))      return { outerBoost: 24, innerBoost: 10 };
  if (modes.includes('coding'))    return { outerBoost: 18, innerBoost: 8 };
  if (modes.includes('ultrawork')) return { outerBoost: 12, innerBoost: 6 };
  if (modes.includes('analyze'))   return { outerBoost: 6,  innerBoost: 4 };
  return { outerBoost: 0, innerBoost: 0 };
}

/**
 * Detect a teaching statement: a preference / rule / persona trait the user
 * wants the active companion to internalize, rather than a task to execute.
 *
 * Delegation wins: any explicit task verb (帮我/写一个/run/create…) → not teaching.
 *
 * @param {string} text
 * @returns {{ isTeaching:boolean, target?:'persona'|'principles'|'memory', content?:string }}
 */
function detectTeaching(text) {
  const cleaned = removeCodeBlocks(String(text || '')).trim();
  if (!cleaned) return { isTeaching: false };

  // A clear task request is delegation, never teaching.
  if (TASK_VERB_RE.test(cleaned)) return { isTeaching: false };

  // Persona is most specific (sentence-leading), then red lines, then preferences.
  let target = null;
  if (TEACH_PERSONA_RE.test(cleaned)) target = 'persona';
  else if (TEACH_PRINCIPLE_RE.test(cleaned)) target = 'principles';
  else if (TEACH_PREFERENCE_RE.test(cleaned)) target = 'memory';

  if (!target) return { isTeaching: false };

  // Anti-hijack: a question about the model ("你是小米开发的模型吗？") is chitchat,
  // not a teaching statement. A pure question routes to the normal chat path so
  // the model answers it directly, instead of being captured onto a companion.
  if (looksInterrogative(cleaned, target)) return { isTeaching: false };

  // Anti-misfire: a persona prefix used only to FRAME a one-shot deliverable
  // ("你是一个严苛的架构师，请做一个公正的评价") is delegation, not a durable
  // persona to record. Veto persona only (principles/preferences keep an explicit
  // directive anchor and are not framed this way).
  if (target === 'persona' && looksLikeRoleFramedRequest(cleaned)) {
    return { isTeaching: false };
  }

  return { isTeaching: true, target, content: cleaned };
}

module.exports = {
  GOAL_DIRECTIVE,
  ULTRAWORK_DIRECTIVE,
  CODING_DIRECTIVE,
  ANALYZE_DIRECTIVE,
  LEARN_DIRECTIVE,
  removeCodeBlocks,
  detectModes,
  detectTeaching,
  looksInterrogative,
  looksLikeRoleFramedRequest,
  applyIntentGate,
  getAcceptanceCriteria,
  getLoopLimitBoost,
  TEACH_PERSONA_RE,
  TEACH_PRINCIPLE_RE,
  TEACH_PREFERENCE_RE,
};
