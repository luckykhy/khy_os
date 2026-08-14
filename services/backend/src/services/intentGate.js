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
 *   - conversation      — purely conversational requests (negative gate, lowest priority)
 *
 * Keywords inside fenced or indented code blocks are ignored.
 */

const CODE_BLOCK_RE = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1[^\n]*|(?:(?:^|\n)(?: {4}|\t)[^\n]*)+/gm;
const GOAL_TRIGGER_RE = /^(?:goal|目标)[：:\s]+(.+)/is;
const ULTRAWORK_TRIGGER_RE = /(^|[^a-z0-9_])(ultrawork|ulw)(?=$|[^a-z0-9_])/i;

// Coding mode: project scaffolding, multi-file creation, build tasks
// 收窄触发范围：仅匹配明确的"创建/搭建/开发项目"意图
// 不再匹配单独的框架名（如 React/Vue/Express），避免讨论框架时误触发
const CODING_TRIGGER_RE =
  /(创建[\s\S]{0,10}(?:项目|工程|应用)|新建[\s\S]{0,10}(?:工程|项目)|scaffold|create\s+(?:a\s+)?(?:new\s+)?project|create\s+(?:a\s+)?(?:new\s+)?[\w-]+\s+project|new\s+project|init\s+project|写一个[\s\S]{0,20}(?:项目|工程|应用|服务|系统|网站)|build\s+a[\s\S]{0,20}(?:app|project|server|website|api)|搭建[\s\S]{0,20}(?:项目|工程|环境|系统)|setup\s+(?:a\s+)?(?:new\s+)?project|bootstrap\s+(?:a\s+)?project|开发[\s\S]{0,10}(?:项目|应用|网站|后端|前端|系统|服务|小程序)|做一个[\s\S]{0,20}(?:项目|应用|网站|后端|前端|系统|服务)|帮我写[\s\S]{0,20}(?:项目|服务|后端|前端|网站)|full[\s-]?stack|create[-\s]react[-\s]app|vite\s+create|cargo\s+new|go\s+mod\s+init|npm\s+init|maven项目|gradle项目|create\s+(?:a\s+)?(?:react|vue|next(?:\.js)?|nestjs|gin|tauri|electron)[\s\S]{0,24}(?:app|project|api|server|service|microservice)?|setup\s+(?:a\s+)?(?:new\s+)?next(?:\.js)?[\s\S]{0,16}project|微信小程序|小程序)/i;

// Analyze mode: deep analysis, code review (excludes bare "分析" to avoid false positives)
const ANALYZE_TRIGGER_RE =
  /(深度分析|全面分析|综合分析|代码审查|code\s*review|architecture\s*review|性能分析|performance\s*analysis|安全审计|security\s*audit)/i;

// Learn mode: KHY OS learning / teaching requests
const LEARN_TRIGGER_RE =
  /(教我[\s\S]{0,20}(?:KHY|khy|Khy|项目|系统|架构|代码|工具|网关|CLI|REPL|量化|工具循环|前端|内核)|学习[\s\S]{0,10}(?:KHY|khy|Khy|项目|系统|架构)|KHY[\s\S]{0,10}(?:怎么|如何|是什么|原理|机制|设计)|teach\s+me[\s\S]{0,20}(?:KHY|khy|project|system|architecture)|learn\s+(?:about\s+)?(?:KHY|khy|the\s+project|the\s+system)|从零学习|从头学习|系统学习[\s\S]{0,10}KHY)/i;

// Conversation mode (negative gate): purely conversational requests —
// storytelling, casual Q&A, explanation, translation, creative writing —
// should be answered with plain text; the model must not "output" the answer
// through writeFile/shell. Detection is deliberately conservative: it never
// fires when any high-energy mode matched or an explicit task verb is present.
const CONVERSATION_TRIGGER_RE =
  /(讲(?:个|一个|几个)?(?:故事|笑话|段子)|写(?:一)?首诗|写(?:一篇|篇|个)?(?:作文|散文|诗歌|小说)|解释(?:一下|下)?|是什么|什么是|为什么|翻译(?:一下|下)?|tell\s+me\s+a\s+(?:story|joke)|\bexplain\b|\bwhat\s+is\b|\bwhat\s+are\b|\bwhy\s+(?:is|are|do|does|did)\b|\btranslate\b|write\s+(?:me\s+)?a\s+(?:poem|story|haiku|song))/i;

// Explicit task verbs veto conversation mode: the user clearly wants a
// filesystem / execution side effect, not just a plain-text answer.
const CONVERSATION_TASK_VETO_RE =
  /(写入|写到|存到|存进|保存|另存|创建文件|新建文件|生成文件|文件里|文件中|修改|修复|重构|删除|运行|执行|部署|安装|编译|提交|推送|\bbuild\b|\bfix\b|\brun\b|\bexecute\b|\bcompile\b|\bdeploy\b|\binstall\b|\brefactor\b|\bdebug\b|\bcommit\b|\bpush\b|save\s+(?:to|as|it|this|the)|write\s+(?:to|into|it\s+to)|create\s+(?:a\s+)?(?:file|folder|directory)|output\s+(?:to|into)\s+a?\s*file)/i;

// ── Teaching intent (借鉴分析 #5): teach-vs-delegate split ────────────────────
// A teaching statement records a preference / rule / persona trait onto the
// ACTIVE companion's AgentFS assets instead of being executed as a task.
//   persona-trait → persona.md, red line → principles.md, preference → memory.
// Persona has highest specificity, then principles (red lines), then memory.
const TEACH_PERSONA_RE =
  /^\s*(?:你是|你叫|你的名字(?:是|叫)?|你的角色是?|你扮演|你应该(?:是|扮演)|act\s+as\b|you\s+are\b|your\s+name\s+is\b)/i;
// TEACH_PRINCIPLE_RE: strong (unambiguous) signals only.
// Directive signals (禁止/不准/不允许) are handled by isDirectiveTowardAi()
// which allows proximity-based AI targeting with external-prefix exclusion.
const TEACH_PRINCIPLE_RE =
  /绝不|永远不(?:要|得|能)|从不|不可以|必须不|never\s+(?:ever\s+)?|don'?t\s+ever|must\s+not/i;

// ── Directive-word helper for 禁止/不准/不允许 ───────────────────────────────
// Matches when these directive words are aimed at the AI:
//   (a) 你/你们/您 appears within 10 non-sentence-break chars before the word, OR
//   (b) a context marker (时/以后/之后/然后) appears within 6 chars before it
//       (covers subject-less sentences like "写代码时不允许用全局变量"), OR
//   (c) the word is at sentence-initial position (imperative mood).
// Excludes external-constraint subjects (平台/系统/规定/法律/公众号/又/也/还)
// appearing within 5 chars immediately before the directive word.
const DIRECTIVE_WORD_RE = /禁止|不准|不允许/g;
const EXTERNAL_PREFIX_RE =
  /(?:平台|系统|规定|法律|规则|政策|公司|商标局|微信|淘宝|京东|银行|学校|国家|公众号|又|也|还)[^。！？.!?\n]{0,4}$/;
// "你也/你又/你还/您也…": the adverb 又/也/还 follows an AI subject (你/您),
// so it is NOT an external constraint subject — it must fall through to AI
// targeting instead of being excluded by EXTERNAL_PREFIX_RE.
const AI_PREFIXED_ADVERB_RE = /(?:你|您)(?:又|也|还)[^。！？.!?\n]{0,4}$/;
const CONTEXT_MARKER_RE = /(?:时|以后|之后|然后)[^。！？.!?\n]{0,5}$/;

// ── Additional guards for isDirectiveTowardAi ──────────────────────────────
// Quoted speech / attribution: user is citing someone else's rule, not teaching AI
const QUOTE_PREFIX_RE =
  /(?:你(?:说|觉得|认为|提到)|他(?:说|觉得|认为)|她(?:说|觉得|认为)|有人说|据说|据称|别人说|人家说)[^。！？.!?\n]{0,10}$/;
// Conditional / hypothetical: not an actual rule being imposed
const CONDITIONAL_PREFIX_RE =
  /(?:如果|假如|假设|若是|要是|即使|就算|哪怕|万一)[^。！？.!?\n]{0,10}$/;
// Self-directed: user is constraining themselves, not the AI
const SELF_DIRECTED_RE =
  /(?:我自己|我本人|本人|我禁止自己|我要求自己|我强迫自己)[^。！？.!?\n]{0,5}$/;
// Negative request: user asks AI NOT to impose a restriction (double negation)
const NEGATIVE_REQUEST_RE =
  /(?:不要|别|不用|不能|不可以?)[^。！？.!?\n]{0,2}(?:禁止|不准|不允许|限制|阻止|反对)[^。！？.!?\n]{0,2}$/;

/**
 * True when a 禁止/不准/不允许 occurrence in `text` is directed at the AI
 * rather than describing an external platform/system rule.
 * @param {string} text
 * @returns {boolean}
 */
function isDirectiveTowardAi(text) {
  const t = String(text || '');
  DIRECTIVE_WORD_RE.lastIndex = 0;
  let m;
  while ((m = DIRECTIVE_WORD_RE.exec(t)) !== null) {
    const before = t.slice(0, m.index);
    // Exclude external-constraint subjects within 5 chars before the directive word
    const win5 = before.slice(-5);
    // "你也/你又/你还" — adverb after an AI subject, not an external subject.
    if (!AI_PREFIXED_ADVERB_RE.test(win5) && EXTERNAL_PREFIX_RE.test(win5)) {
      continue;
    }
    // Quoted speech: user is citing someone else's rule
    const winQuote = before.slice(-15);
    if (QUOTE_PREFIX_RE.test(winQuote)) {
      continue;
    }
    // Conditional / hypothetical: not an actual directive
    const winCond = before.slice(-15);
    if (CONDITIONAL_PREFIX_RE.test(winCond)) {
      continue;
    }
    // Self-directed: user constraining themselves
    const winSelf = before.slice(-12);
    if (SELF_DIRECTED_RE.test(winSelf)) {
      continue;
    }
    // Negative request: "不要禁止 me" — user asks to lift a restriction
    const winNeg = before.slice(-15);
    if (NEGATIVE_REQUEST_RE.test(winNeg)) {
      continue;
    }
    // Sentence-initial (imperative mood): at start or after sentence-ending punct
    if (before.length === 0 || /[。！？.!?\n]$/.test(before)) {
      return true;
    }
    // (a) AI pronoun within 10 chars
    const win10 = before.slice(-10);
    if (/(?:你(?:们)?|您)[^。！？.!?\n]{0,9}$/.test(win10)) {
      return true;
    }
    // (b) Context marker within 6 chars (covers subject-less sentences)
    const win6 = before.slice(-6);
    if (CONTEXT_MARKER_RE.test(win6)) {
      return true;
    }
  }
  return false;
}

// ── Principle keyword guard ──────────────────────────────────────────────────
// Checks whether TEACH_PRINCIPLE_RE keywords (绝不/必须不/不可以/从不/…) appear
// in a guarded context (quote, conditional, self-directed, question, external).
// This is separate from isDirectiveTowardAi because principle keywords are
// matched by a different regex path in detectTeaching.
const PRINCIPLE_KEYWORD_RE =
  /绝不|永远不(?:要|得|能)|从不|不可以|必须不|never\s+(?:ever\s+)?|don'?t\s+ever|must\s+not/gi;

/**
 * True when ALL principle-keyword occurrences in `text` are in guarded
 * (non-teaching) contexts. Returns false if at least one occurrence appears
 * to be a genuine directive.
 * @param {string} text
 * @returns {boolean}
 */
function isPrincipleGuarded(text) {
  const t = String(text || '');
  PRINCIPLE_KEYWORD_RE.lastIndex = 0;
  let m;
  let found = false;
  while ((m = PRINCIPLE_KEYWORD_RE.exec(t)) !== null) {
    found = true;
    const before = t.slice(0, m.index);
    // Quoted speech
    const winQuote = before.slice(-15);
    if (QUOTE_PREFIX_RE.test(winQuote)) {
      continue;
    }
    // Conditional / hypothetical
    const winCond = before.slice(-15);
    if (CONDITIONAL_PREFIX_RE.test(winCond)) {
      continue;
    }
    // Self-directed
    const winSelf = before.slice(-12);
    if (SELF_DIRECTED_RE.test(winSelf)) {
      continue;
    }
    // External subject within 5 chars — but "你也/你又/你还" is an AI-directed
    // adverb, not an external subject, so it is a genuine (unguarded) directive.
    const win5 = before.slice(-5);
    if (!AI_PREFIXED_ADVERB_RE.test(win5) && EXTERNAL_PREFIX_RE.test(win5)) {
      continue;
    }
    // At least one unguarded occurrence → not fully guarded
    return false;
  }
  // If no keywords found, treat as guarded (no principle keyword to protect)
  return true;
}
const TEACH_PREFERENCE_RE =
  /(以后|从现在(?:开始|起)|今后|往后|记住[:：]?|请记住|note\s+that|from\s+now\s+on|always\b|总是|每次都|默认(?:用|使用|采用))/i;

// Strong constraint signals used for:
//   1. PREFERENCE → principles escalation in detectTeaching
//   2. Interrogative override in looksInterrogative
const STRONG_CONSTRAINT_RE =
  /绝不|永远不(?:要|得|能)|从不|禁止|不准|不允许|不可以|必须不|never\s+(?:ever\s+)?|don'?t\s+ever|must\s+not/i;

// ── Interrogative guard (anti-hijack) ────────────────────────────────────────
// A QUESTION about the model ("你是小米开发的模型吗？", "你是什么模型") is chitchat
// to be answered, NOT a teaching statement to record onto a companion. Two tiers
// keep a genuine DECLARATIVE teach ("你叫小爱同学", "你是我的专属助手") from being
// dropped:
//   STRONG — unambiguous yes/no questions: a question mark, a sentence-final
//     particle (吗/呢/吧), an A-not-A / 是否 structure, or a sentence-final
//     question phrase (怎么办/如何/为什么). These almost never appear in a
//     real teaching statement, so they veto ANY target.
//   WH — content-question words (什么/谁/哪/为什么/怎么…). These can sit inside a
//     declarative rule ("绝不要问我为什么"), so they only veto the PERSONA target,
//     whose match ("你是…") has no directive anchor and is the form that hijacks
//     chitchat like "你是什么模型".
const STRONG_QUESTION_RE =
  /[?？]|(?:吗|呢|吧)\s*[?？!！。.~～\s]*$|是不是|是否|有没有|能不能|会不会|可不可以|对不对|难道|莫非|(?:怎么办|咋办|如何|为何|为什么)\s*[?？!！。.~～\s]*$/u;
const WH_QUESTION_RE =
  /(什么|啥|为什么|为何|怎么|怎样|咋样?|如何|多少|哪(?:个|些|里|儿|样|种)?|谁)/;

// ── Conditional-rule-toward-AI helper (anti-false-negative) ──────────────────
// A conditional prefix (如果/假如/…) normally marks a hypothetical that should NOT
// be captured. But "如果 X，你不可以 Y" / "如果 X，你绝不 Y" is a durable rule imposed
// on the AI, not a hypothetical. Recognize it as teaching WHEN all hold:
//   (a) a conditional prefix is present, AND
//   (b) an explicit "你/您 + strong-constraint/directive" rule structure exists, AND
//   (c) the sentence is NOT a genuine question (怎么办/如何/吗/？…).
// Questions and external-subject sentences stay excluded.
const CONDITIONAL_START_RE = /如果|假如|假设|若是|要是|即使|就算|哪怕|万一/;
const AI_RULE_STRUCTURE_RE =
  /(?:你(?:们)?|您)[^。！？.!?\n]{0,10}(?:绝不|永远不(?:要|得|能)?|从不|禁止|不准|不允许|不可以|必须不)/;

/**
 * True when a conditionally-framed sentence still expresses an explicit
 * AI-directed rule ("如果…你不可以…") and is not a question.
 * @param {string} text
 * @returns {boolean}
 */
function isConditionalRuleTowardAi(text) {
  const t = String(text || '').trim();
  if (!t) {
    return false;
  }
  if (!CONDITIONAL_START_RE.test(t)) {
    return false;
  }
  // Genuine questions (吗/？/怎么办/如何…) stay excluded.
  if (STRONG_QUESTION_RE.test(t)) {
    return false;
  }
  // Require an explicit "你/您 + strong constraint/directive" rule structure.
  return AI_RULE_STRUCTURE_RE.test(t);
}

// Task verbs short-circuit teaching: an imperative request to DO something wins.
const TASK_VERB_RE =
  /(帮我|帮忙|请(?:你)?(?:帮|写|做|生成|创建|执行|运行|查|找|改|修复|分析|总结)|写一[篇个封份]|生成|创建|执行|运行|跑一下|查一下|搜索|修复|重构|部署|发布|计算|画(?:一)?[个张]|\bwrite\s+(?:a|me|an)\b|\bcreate\b|\bgenerate\b|\brun\b|\bexecute\b|\bfix\b|\bbuild\b|\bmake\s+(?:me|a)\b|\bsearch\b|\bfind\b)/i;

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
  if (!t) {
    return false;
  }
  if (STRONG_QUESTION_RE.test(t)) {
    // Exception: if text also contains a strong constraint signal AND the
    // question is NOT an explicit yes-no / particle question, the sentence
    // may be a declarative rule that happens to contain a question word
    // (e.g. "绝不要问我为什么"), not a genuine question.
    // Explicit questions (particle 吗/呢/吧, or structural 是不是/是否/有没有)
    // are always genuine questions regardless of constraint signals.
    if (STRONG_CONSTRAINT_RE.test(t)) {
      // Question particle ending: always a real question
      if (/(?:吗|呢|吧)\s*[?？!！。.~～\s]*$/u.test(t)) {
        return true;
      }
      // Structural yes-no question: always a real question
      if (/^(?:是不是|是否|有没有|能不能|会不会|可不可以|对不对)/.test(t)) {
        return true;
      }
      return false;
    }
    return true;
  }
  if (target === 'persona' && WH_QUESTION_RE.test(t)) {
    return true;
  }
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
  '评价',
  '评估',
  '测评',
  '点评',
  '评判',
  '评论',
  '评审',
  '审查',
  '审阅',
  '比较',
  '对比',
  '分析',
  '剖析',
  '总结',
  '复盘',
  '梳理',
  '概括',
  '综述',
  '盘点',
  '讲解',
  '介绍',
  '推荐',
  '描述',
  '说说',
  '谈谈',
  '聊聊',
  '打分',
  '排名',
  '排序',
  '看法',
  '建议',
  '意见',
  'evaluate',
  'review',
  'compare',
  'contrast',
  'analy[sz]e',
  'assess',
  'critique',
  'summari[sz]e',
  'rate',
  'rank',
  'describe',
  'recommend',
  'give\\s+(?:a|an|your|me)\\b',
].join('|');
const DELIVERABLE_NOUN = [
  '评价',
  '评估',
  '分析',
  '总结',
  '报告',
  '点评',
  '对比',
  '比较',
  '建议',
  '意见',
  '看法',
  '方案',
  '综述',
  '复盘',
  '测评',
  '排名',
  'evaluation',
  'review',
  'comparison',
  'assessment',
  'critique',
  'analysis',
  'summary',
  'feedback',
  'opinion',
  'breakdown',
].join('|');
const ROLE_FRAMED_REQUEST_RE = new RegExp(
  // A: 请/please … (≤60 non-sentence-break chars) … output/evaluation verb
  `(?:${ROLE_REQUEST_MARKER})[^。！？.!?\\n]{0,60}?(?:${OUTPUT_VERB})` +
    // B: 做/写/出/给出/来/提供 一[个张份篇] … deliverable noun  (or English give a/an <noun>)
    `|(?:做|写|出|给出|来|提供)\\s*一?\\s*[个张份篇](?:[^。！？.!?\\n]{0,12}?)?(?:${DELIVERABLE_NOUN})` +
    `|\\bgive\\s+(?:a|an|your|me)\\s+[^.!?\\n]{0,16}?(?:${DELIVERABLE_NOUN})`,
  'i'
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
  if (!t) {
    return false;
  }
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

const CONVERSATION_DIRECTIVE = [
  '## CONVERSATION mode — 纯对话请求。',
  '本轮用户请求是纯对话（讲故事/问答/解释/翻译/创意写作等）：',
  '1. 直接用文字回复，把完整内容写在回答里。',
  '2. 不要调用任何文件写入（writeFile/editFile）或命令执行类工具，除非后续用户明确要求创建、保存或运行。',
  '3. 严禁把写文件当作「输出」或「展示」答案的方式。',
].join('\n');

// ── 桌面操控模式（DESKTOP）─────────────────────────────────────────────
// 用户请求涉及真实 GUI 桌面操作（打开/切换应用、点击按钮、输入文字、填表、
// 截图看屏幕、操控电脑等）时，注入指令引导模型使用 computer_use / DesktopControl
// 工具——实现「水到渠成、按需触发」，用户无需显式说 "computer use" 或指定应用。
const DESKTOP_TRIGGER_RE =
  /(?:帮我|请|麻烦)?(?:打开|启动|运行|关闭|激活|切换(?:到|至)?|最小化|最大化)\s*(?:应用|程序|软件)?\s*[^\s，。,.!?]{1,30}|(?:在|用)\s*(?:微信|qq|浏览器|火狐|chrome|edge|word|excel|ppt|outlook|记事本|计算器|画图|steam|钉钉|腾讯会议|网易云|potplayer|文件资源管理器)[^\n]{0,30}(?:发消息|输入|填写|点击|打开|发送|回复|操作|写|编辑|整理|查|看|统计|汇总|创建|新建)|(?:点击|点一下|按下|双击|右击|输入|键入|填写|填表|填写表单|截图|截屏|看(?:一下|看)?屏幕|操控(?:电脑|桌面|屏幕)|操作(?:电脑|桌面|屏幕)|模拟(?:鼠标|键盘|点击))[^\n]{0,20}(?:按钮|框|控件|表单|应用|程序|软件|窗口|桌面|屏幕|网页|浏览器)?/i;

// 跨应用协作句式："从 Chrome 复制报价到 Excel" / "把微信聊天记录导出到表格"
// 特征是出现两个应用名 + 搬运动词（复制/导出/汇总/整理/粘贴/导入/迁移/移动）。
const DESKTOP_CROSS_APP_RE =
  /(?:从|把|将|用)[^\n]{0,20}(?:chrome|firefox|edge|word|excel|ppt|outlook|微信|浏览器|网页|页面|记事本|计算器|画图|钉钉|qq|steam|收藏夹)[^\n]{0,30}(?:复制|导出|导入|粘贴|汇总|整理|迁移|移动|搬运|保存|写入|发送|拷贝|copy|export|paste)[^\n]{0,20}(?:到|至|进)[^\n]{0,20}(?:excel|word|ppt|chrome|firefox|edge|outlook|微信|浏览器|记事本|表格|文档|文件|计算器|钉钉|qq|steam|收藏夹)/i;
// 变体："整理浏览器收藏夹到 Excel 表格" / "汇总 Chrome 报价到表格"（动词开头，无 从/把/将/用 引导）
const DESKTOP_CROSS_APP_RE2 =
  /(?:整理|汇总|复制|导出|导入|迁移|搬运|保存|拷贝|copy|export|paste)[^\n]{0,20}(?:chrome|firefox|edge|word|excel|ppt|outlook|微信|浏览器|网页|页面|记事本|收藏夹|钉钉|qq|steam)[^\n]{0,30}(?:到|至|进)[^\n]{0,20}(?:excel|word|ppt|chrome|firefox|edge|outlook|微信|浏览器|记事本|表格|文档|文件|计算器|收藏夹)/i;
// 变体："从网页、微信、邮件三个来源收集信息到表格" / "将多个应用的数据汇总到一个表格"
// 多源收集（fan-in）：出现多个来源词（从X、Y、Z）或「多个应用/三个来源」+ 汇总动词 + 目标（到表格/到X）
const DESKTOP_FANIN_RE =
  /(?:从|将|把)[^\n]{0,40}(?:、|，|,|和|与|及)[^\n]{0,40}(?:来源|应用|软件|地方)[^\n]{0,20}(?:收集|汇总|整理|导入|合并|集中|整合)[^\n]{0,20}(?:到|至|进|成)[^\n]{0,20}(?:excel|word|ppt|表格|文档|文件|一处|一起)|(?:多个|三个|几个|多?个|所有)[^\n]{0,10}(?:应用|软件|来源|窗口)[^\n]{0,20}(?:数据|信息|内容|记录)[^\n]{0,20}(?:汇总|收集|合并|整合|整理)[^\n]{0,20}(?:到|至|进|成)[^\n]{0,20}(?:excel|word|ppt|表格|文档|文件|一处)|(?:多个|三个|几个|多?个)[^\n]{0,10}(?:应用|软件|来源)[^\n]{0,15}(?:收集|汇总|合并|整合|整理)[^\n]{0,15}(?:数据|信息|内容|记录)/i;

const DESKTOP_DIRECTIVE = [
  '## DESKTOP mode — 桌面 GUI 操控任务。',
  '用户请求涉及操作真实桌面应用（打开/切换应用、点击按钮、输入文字、填表、截图看屏幕等）。',
  '1. 优先使用 computer_use 工具执行：给它一个清晰目标，它会自动观察屏幕 → 决策 → 执行 → 验证。',
  '2. 目标里可以直接提及应用名（如"打开微信"、"@Excel 整理报表"），工具会自动识别并尝试激活。',
  '3. 简单单步窗口操作（关闭/激活/最小化某个应用、列出窗口）可直接用 DesktopControl 工具。',
  '4. 涉及账号/支付/凭据的操作全程保持谨慎，必要时停下向用户确认。',
  '5. 若桌面操控未授权（安全闸门关闭），按工具返回的指引提示用户启用 KHY_DESKTOP_CONTROL。',
].join('\n');

function _firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function _parseBoolean(value) {
  if (value === true || value === false) {
    return value;
  }
  const text = String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase();
  if (!text) {
    return undefined;
  }
  if (['1', 'true', 'yes', 'on', 'y'].includes(text)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'n'].includes(text)) {
    return false;
  }
  return undefined;
}

function _resolveUltraworkChatOpts(options = {}) {
  const preferredModel = _firstNonEmpty(
    options.ultraworkModel,
    process.env.KHY_ULTRAWORK_MODEL,
    process.env.KHY_ULTRAWORK_PREFERRED_MODEL
  );
  const preferredAdapter = _firstNonEmpty(
    options.ultraworkAdapter,
    process.env.KHY_ULTRAWORK_ADAPTER,
    process.env.KHY_ULTRAWORK_PREFERRED_ADAPTER
  );
  const strict = _parseBoolean(
    options.ultraworkStrict !== undefined
      ? options.ultraworkStrict
      : process.env.KHY_ULTRAWORK_PREFERRED_STRICT
  );

  const patch = {};
  if (preferredModel) {
    patch.preferredModel = preferredModel;
  }
  if (preferredAdapter) {
    patch.preferredAdapter = preferredAdapter;
  }
  if (strict !== undefined) {
    patch.preferredStrict = strict;
    patch.strictPreferred = strict;
  }
  // Force tool use for first iterations in ultrawork mode
  const forceToolChoice = _parseBoolean(process.env.KHY_ULTRAWORK_FORCE_TOOL_CHOICE);
  if (forceToolChoice !== false) {
    patch._intentToolChoice = 'required';
  }
  return patch;
}

function _resolveCodingChatOpts(options = {}) {
  const preferredModel = _firstNonEmpty(options.codingModel, process.env.KHY_CODING_MODEL);
  const patch = {};
  if (preferredModel) {
    patch.preferredModel = preferredModel;
  }
  // Force tool use for first iterations in coding mode
  const forceToolChoice = _parseBoolean(process.env.KHY_CODING_FORCE_TOOL_CHOICE);
  if (forceToolChoice !== false) {
    patch._intentToolChoice = 'required';
  }
  return patch;
}

function _resolveAnalyzeChatOpts(options = {}) {
  const preferredModel = _firstNonEmpty(options.analyzeModel, process.env.KHY_ANALYZE_MODEL);
  const patch = {};
  if (preferredModel) {
    patch.preferredModel = preferredModel;
  }
  return patch;
}

function _resolveGoalChatOpts(options = {}) {
  const preferredModel = _firstNonEmpty(options.goalModel, process.env.KHY_GOAL_MODEL);
  const patch = {};
  if (preferredModel) {
    patch.preferredModel = preferredModel;
  }
  // Goal mode always forces tool use
  patch._intentToolChoice = 'required';
  return patch;
}

function removeCodeBlocks(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }
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

  // desktop: 桌面 GUI 操控任务（打开/切换应用、点击、输入、填表、截图、操控电脑）
  // 保守触发——只在出现明确的 GUI 操作动词/目标时命中，避免误吞普通对话。
  // 跨应用句式（"从 Chrome 复制到 Excel"）由 DESKTOP_CROSS_APP_RE 单独捕获。
  const desktopMatch =
    cleaned.match(DESKTOP_TRIGGER_RE) ||
    cleaned.match(DESKTOP_CROSS_APP_RE) ||
    cleaned.match(DESKTOP_CROSS_APP_RE2) ||
    cleaned.match(DESKTOP_FANIN_RE);
  const desktop = !!desktopMatch;

  const modes = [];
  if (goal) {
    modes.push('goal');
  }
  if (ultrawork) {
    modes.push('ultrawork');
  }
  if (coding) {
    modes.push('coding');
  }
  if (analyze) {
    modes.push('analyze');
  }
  if (learn) {
    modes.push('learn');
  }
  if (desktop) {
    modes.push('desktop');
  }

  // conversation: negative gate — only when NO high-energy mode fired and the
  // text contains no explicit task verb, so task requests are never suppressed.
  const conversationMatch =
    modes.length === 0 && !CONVERSATION_TASK_VETO_RE.test(cleaned)
      ? cleaned.match(CONVERSATION_TRIGGER_RE)
      : null;
  const conversation = !!conversationMatch;
  if (conversation) {
    modes.push('conversation');
  }

  return {
    goal,
    goalText: goal ? String(goalMatch[1] || '').trim() : null,
    ultrawork,
    coding,
    analyze,
    learn,
    desktop,
    desktopTrigger: desktop ? String(desktopMatch[0] || '').trim() : null,
    conversation,
    trigger: ultrawork ? String(ultraworkMatch[2] || '').toLowerCase() : null,
    codingTrigger: coding ? String(codingMatch[1] || '') : null,
    analyzeTrigger: analyze ? String(analyzeMatch[1] || '') : null,
    learnTrigger: learn ? String(learnMatch[1] || '') : null,
    conversationTrigger: conversation ? String(conversationMatch[1] || '') : null,
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
    if (directive) {
      directives.push({ mode: 'goal', trigger: detected.goalText, text: directive });
    }
    chatOptsPatch = { ...chatOptsPatch, ..._resolveGoalChatOpts(options) };
  }

  // ultrawork: highest priority autonomous mode
  if (detected.ultrawork) {
    const directive = String(options.ultraworkDirective || ULTRAWORK_DIRECTIVE).trim();
    if (directive) {
      directives.push({ mode: 'ultrawork', trigger: detected.trigger, text: directive });
    }
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
    } catch {
      /* platformUtils not available — skip */
    }

    // Append template hint if a matching template is available
    try {
      const { matchTemplate } = require('./projectTemplateService');
      const matched = matchTemplate(original);
      if (matched) {
        codingText += `\nTemplate "${matched.name}" is available. Use the projectTemplate tool to load it (template: "${matched.name}"), then pass the rendered output directly to scaffoldFiles.`;
      }
    } catch {
      /* projectTemplateService not available — skip hint */
    }
    if (codingText) {
      directives.push({ mode: 'coding', trigger: detected.codingTrigger, text: codingText });
    }
    chatOptsPatch = { ...chatOptsPatch, ..._resolveCodingChatOpts(options) };
  }

  // analyze: deep analysis / review mode
  if (detected.analyze) {
    const directive = String(options.analyzeDirective || ANALYZE_DIRECTIVE).trim();
    if (directive) {
      directives.push({ mode: 'analyze', trigger: detected.analyzeTrigger, text: directive });
    }
    chatOptsPatch = { ...chatOptsPatch, ..._resolveAnalyzeChatOpts(options) };
  }

  // learn: KHY OS interactive learning mode
  if (detected.learn) {
    const directive = String(options.learnDirective || LEARN_DIRECTIVE).trim();
    if (directive) {
      directives.push({ mode: 'learn', trigger: detected.learnTrigger, text: directive });
    }
  }

  // desktop: 桌面 GUI 操控任务——引导模型使用 computer_use / DesktopControl 工具。
  // 与 coding 等互不冲突（桌面任务也可能含脚本执行）；但与 conversation 互斥（真操作不是闲聊）。
  if (detected.desktop) {
    const directive = String(options.desktopDirective || DESKTOP_DIRECTIVE).trim();
    if (directive) {
      directives.push({ mode: 'desktop', trigger: detected.desktopTrigger, text: directive });
    }
  }

  // conversation: soft negative gate — a purely conversational request should
  // be answered with plain text. Never fires when any other mode is active.
  if (detected.conversation && directives.length === 0) {
    const directive = String(options.conversationDirective || CONVERSATION_DIRECTIVE).trim();
    if (directive) {
      directives.push({
        mode: 'conversation',
        trigger: detected.conversationTrigger,
        text: directive,
      });
    }
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

  const injected = directives.map((d) => d.text).join('\n\n');
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
  for (const mode of modes || []) {
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
  if (!Array.isArray(modes) || modes.length === 0) {
    return { outerBoost: 0, innerBoost: 0 };
  }
  if (modes.includes('goal')) {
    return { outerBoost: 24, innerBoost: 10 };
  }
  if (modes.includes('coding')) {
    return { outerBoost: 18, innerBoost: 8 };
  }
  if (modes.includes('ultrawork')) {
    return { outerBoost: 12, innerBoost: 6 };
  }
  if (modes.includes('analyze')) {
    return { outerBoost: 6, innerBoost: 4 };
  }
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
  if (!cleaned) {
    return { isTeaching: false };
  }

  // A clear task request is delegation, never teaching.
  if (TASK_VERB_RE.test(cleaned)) {
    return { isTeaching: false };
  }

  // Persona is most specific (sentence-leading), then red lines, then preferences.
  let target = null;
  if (TEACH_PERSONA_RE.test(cleaned)) {
    target = 'persona';
  } else if (TEACH_PRINCIPLE_RE.test(cleaned)) {
    // Guard: principle keywords in quote/conditional/self-directed context.
    // Exception: an explicit conditional AI-directed rule ("如果…你不可以…")
    // overrides the conditional guard and IS a principle.
    if (!isPrincipleGuarded(cleaned) || isConditionalRuleTowardAi(cleaned)) {
      target = 'principles';
    }
  } else if (isDirectiveTowardAi(cleaned) || isConditionalRuleTowardAi(cleaned)) {
    target = 'principles';
  } else if (TEACH_PREFERENCE_RE.test(cleaned)) {
    // If text also contains a strong constraint signal, escalate to principles
    // (e.g. "以后不允许撒谎" → principles, not memory).
    target = STRONG_CONSTRAINT_RE.test(cleaned) ? 'principles' : 'memory';
  }

  if (!target) {
    return { isTeaching: false };
  }

  // Anti-hijack: a question about the model ("你是小米开发的模型吗？") is chitchat,
  // not a teaching statement. A pure question routes to the normal chat path so
  // the model answers it directly, instead of being captured onto a companion.
  if (looksInterrogative(cleaned, target)) {
    return { isTeaching: false };
  }

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
  CONVERSATION_DIRECTIVE,
  DESKTOP_DIRECTIVE,
  DESKTOP_TRIGGER_RE,
  DESKTOP_CROSS_APP_RE,
  DESKTOP_CROSS_APP_RE2,
  DESKTOP_FANIN_RE,
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
  isDirectiveTowardAi,
  isPrincipleGuarded,
  isConditionalRuleTowardAi,
  STRONG_CONSTRAINT_RE,
};
