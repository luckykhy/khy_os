/**
 * Input Preprocessor — Normalize, enhance, and plan user input.
 *
 * Responsibilities:
 * 1. Normalize: fix common typos, expand abbreviations, standardize stock codes
 * 2. Enhance: add relevant context from growth data and conversation history
 * 3. Plan: detect large/complex tasks and generate execution plans
 *
 * The preprocessor ensures AI receives well-structured, context-rich prompts
 * regardless of how casually the user types.
 */

const path = require('path');
const os = require('os');

// ─── Stock Code Normalization ────────────────────────────────────────────────

const STOCK_PATTERNS = [
  // Match 6-digit codes with or without prefix
  { pattern: /(?:^|\s)(\d{6})(?:\s|$|[,，。.!！?？])/g, normalize: (code) => _addExchangePrefix(code) },
  // Match codes with prefix like sh600519, sz000001
  { pattern: /(?:^|\s)((?:sh|sz|SH|SZ)\d{6})(?:\s|$|[,，。.!！?？])/g, normalize: (code) => code.toLowerCase() },
];

function _addExchangePrefix(code) {
  // 6/9 开头 → 上海, 0/3 开头 → 深圳
  if (code.startsWith('6') || code.startsWith('9')) return `sh${code}`;
  if (code.startsWith('0') || code.startsWith('3')) return `sz${code}`;
  return code;
}

// ─── Common Abbreviation Expansion ──────────────────────────────────────────

const ABBREVIATIONS = {
  // Chinese abbreviations
  '茅台': '贵州茅台(sh600519)',
  '平安': '中国平安(sh601318)',
  '宁德': '宁德时代(sz300750)',
  '比亚迪': '比亚迪(sz002594)',
  '中芯': '中芯国际(sh688981)',
  '腾讯': '腾讯控股(港股)',
  '阿里': '阿里巴巴(港股/美股)',

  // Technical term abbreviations
  'MA': '移动平均线(MA)',
  'KDJ': 'KDJ随机指标',
  'BOLL': '布林带(Bollinger Bands)',
  'VOL': '成交量(Volume)',
};

// ─── Complexity Detection (for task planning) ───────────────────────────────

const COMPLEXITY_INDICATORS = {
  // Keywords indicating multi-step tasks
  multiStep: [
    /同时.*又.*还/,
    /第一.*第二.*第三/,
    /首先.*然后.*最后/,
    /先.*再.*接着/,
    /并且.*而且/,
    /多个|多只|批量|全部/,
    /比较.*和.*的|对比.*与/,
  ],

  // Keywords indicating analysis depth
  deepAnalysis: [
    /深入分析|详细分析|全面分析|综合分析/,
    /从.*角度.*分析/,
    /基本面.*技术面.*情绪面/,
    /长期.*短期.*中期/,
    /历史.*趋势.*预测/,
  ],

  // Keywords indicating research tasks
  research: [
    /研究|调研|报告|总结/,
    /比较.*优劣|哪个更好/,
    /推荐.*策略|选择.*方案/,
    /设计.*系统|构建.*模型/,
  ],
};

// ─── Task Plan Template ─────────────────────────────────────────────────────

const PLAN_PROMPT_TEMPLATE = `作为量化分析助手，我将为你制定执行计划。

用户请求: {userRequest}

请按以下格式输出执行计划:
## 任务分解
1. [步骤1描述]
2. [步骤2描述]
...

## 需要的数据
- [数据需求列表]

## 分析方法
- [使用的方法/指标]

## 预计输出
- [最终交付物描述]

注意: 计划完成后我会逐步执行。先确认计划是否合适。`;

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Preprocess user input: normalize, enhance, detect complexity.
 *
 * @param {string} input - Raw user input
 * @param {object} context - { conversationHistory, userPreferences }
 * @returns {{ processed: string, enhanced: boolean, needsPlan: boolean, plan: string|null, metadata: object }}
 */
function preprocess(input, context = {}) {
  if (!input || typeof input !== 'string') {
    return { processed: input, enhanced: false, needsPlan: false, plan: null, metadata: {} };
  }

  let processed = input.trim();
  const metadata = {
    originalLength: processed.length,
    normalizations: [],
    enhancements: [],
  };

  // Step 1: Normalize stock codes
  processed = _normalizeStockCodes(processed, metadata);

  // Step 2: Expand known abbreviations (only when they appear as whole entities)
  processed = _expandAbbreviations(processed, metadata);

  // Step 3: Fix common input issues
  processed = _fixCommonIssues(processed, metadata);

  // Step 3.5: Infer intent for ambiguous input
  processed = _inferIntent(processed, metadata);

  // Step 4: Add context enrichment
  processed = _enrichContext(processed, context, metadata);

  // Step 5: Detect complexity — does this need a plan?
  const complexity = _assessComplexity(processed);

  // Step 6: If complex, generate plan prompt
  let plan = null;
  let needsPlan = false;
  if (complexity.needsPlan) {
    needsPlan = true;
    plan = PLAN_PROMPT_TEMPLATE.replace('{userRequest}', processed);
  }

  return {
    processed,
    enhanced: metadata.normalizations.length > 0 || metadata.enhancements.length > 0,
    needsPlan,
    plan,
    complexity,
    metadata,
  };
}

/**
 * Format a planning response for display.
 */
function formatPlanDisplay(planText) {
  // Parse the plan structure for pretty display
  const lines = planText.split('\n');
  const formatted = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      formatted.push({ type: 'header', text: line.slice(3) });
    } else if (line.match(/^\d+\.\s/)) {
      formatted.push({ type: 'step', text: line });
    } else if (line.startsWith('- ')) {
      formatted.push({ type: 'bullet', text: line });
    } else if (line.trim()) {
      formatted.push({ type: 'text', text: line });
    }
  }

  return formatted;
}

/**
 * Check if a task response contains a plan structure.
 */
function isPlanResponse(text) {
  return text.includes('## 任务分解') || text.includes('## 执行计划') ||
         (text.includes('1.') && text.includes('2.') && text.includes('3.'));
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function _normalizeStockCodes(text, metadata) {
  let result = text;

  // Standalone 6-digit numbers → add exchange prefix
  result = result.replace(/(?<![a-zA-Z\d])(\d{6})(?![a-zA-Z\d])/g, (match, code) => {
    const normalized = _addExchangePrefix(code);
    if (normalized !== code) {
      metadata.normalizations.push({ type: 'stock_code', from: code, to: normalized });
    }
    return normalized;
  });

  // Uppercase exchange prefix → lowercase
  result = result.replace(/(?:SH|SZ)(\d{6})/g, (match) => {
    const lower = match.toLowerCase();
    if (lower !== match) {
      metadata.normalizations.push({ type: 'case', from: match, to: lower });
    }
    return lower;
  });

  return result;
}

function _expandAbbreviations(text, metadata) {
  let result = text;

  // Only expand if the abbreviation is a standalone word/phrase
  for (const [abbr, expanded] of Object.entries(ABBREVIATIONS)) {
    if (result.includes(abbr) && !result.includes(expanded)) {
      // Don't replace if it's already part of a longer context
      const context = result.slice(
        Math.max(0, result.indexOf(abbr) - 5),
        result.indexOf(abbr) + abbr.length + 5
      );
      // Only expand single-word references (not in complex sentences)
      if (context.length < abbr.length + 15) {
        metadata.enhancements.push({ type: 'abbreviation', from: abbr, to: expanded });
        // Don't replace in text — just track for context. AI will know from history.
      }
    }
  }

  return result;
}

function _fixCommonIssues(text, metadata) {
  let result = text;

  // Fix common Chinese-English mixing issues
  // e.g., "分析一下sh 600519" → "分析一下sh600519"
  result = result.replace(/(sh|sz)\s+(\d{6})/gi, '$1$2');

  // Standardize date formats (2024.1.1 → 2024-01-01)
  result = result.replace(/(\d{4})[./](\d{1,2})[./](\d{1,2})/g, (match, y, m, d) => {
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  });

  // Remove excessive punctuation
  result = result.replace(/([。！？!?]){3,}/g, '$1');

  return result;
}

/**
 * Infer user intent for ambiguous/unclear input.
 * When user's message is vague, add context hints guiding the AI
 * toward the most likely interpretation based on:
 * - Conversation context (recent commands)
 * - User habits (frequent topics)
 * - Input patterns (stock code presence, keywords)
 */
function _inferIntent(text, metadata) {
  if (!text || text.length > 60) return text; // Clear enough if long

  // Greetings are not ambiguous — skip inference to avoid misrouting
  try {
    const { isGreeting } = require('./textHeuristics');
    if (isGreeting(text)) return text;
  } catch { /* best effort */ }

  let inferred = null;

  // Pattern: bare stock code only (e.g., "sh600519" or "茅台")
  // Intent: likely wants current quote or quick analysis
  if (/^(sh|sz)\d{6}$/i.test(text.trim())) {
    inferred = `查询 ${text} 的当前行情和简要分析`;
    metadata.enhancements.push({ type: 'intent_infer', from: text, to: inferred, reason: 'bare_stock_code' });
    return inferred;
  }

  // Pattern: single Chinese stock name (short, no verb)
  const KNOWN_STOCKS = ['茅台', '平安', '宁德', '比亚迪', '中芯', '腾讯', '阿里', '招商', '格力', '万科', '恒瑞', '五粮液'];
  const matchedStock = KNOWN_STOCKS.find(s => text.trim() === s);
  if (matchedStock) {
    inferred = `分析${matchedStock}的当前行情走势`;
    metadata.enhancements.push({ type: 'intent_infer', from: text, to: inferred, reason: 'stock_name_only' });
    return inferred;
  }

  // Pattern: ambiguous short phrase with stock context
  // "怎么样" / "好不好" / "能买吗" — need a subject from context
  if (/^(怎么样|好不好|能买吗|行不行|涨不涨|能不能买|还行吗|咋样)$/.test(text.trim())) {
    // Try to get recent context from habits
    try {
      const habits = require('./usageHabitService');
      const topics = Object.entries(habits.getHabitSummary().topics || {});
      if (topics.length > 0) {
        const recentTopic = topics[0];
        inferred = `${text}（结合最近分析的内容回答，如果不确定请询问具体标的）`;
        metadata.enhancements.push({ type: 'intent_infer', from: text, to: inferred, reason: 'ambiguous_question_with_context' });
        return inferred;
      }
    } catch { /* ignore */ }

    // Fallback: ask AI to clarify but also attempt to answer
    inferred = `${text}（请结合上下文理解，若无法确定则礼貌询问指的是哪只股票或哪个策略）`;
    metadata.enhancements.push({ type: 'intent_infer', from: text, to: inferred, reason: 'ambiguous_no_context' });
    return inferred;
  }

  // Pattern: verb without clear object (e.g., "回测一下", "分析下")
  const verbMatch = text.match(/^(回测|分析|看看|查一下|买|卖|跟踪)(一下|下|看|看看)?$/);
  if (verbMatch) {
    const action = verbMatch[1];
    // Attach a hint to use recent symbol from growth
    try {
      const growthService = require('./growthService');
      const prefs = growthService.loadComponent('user_preferences.json');
      if (prefs.frequentSymbols && prefs.frequentSymbols.length > 0) {
        const recent = prefs.frequentSymbols[0];
        inferred = `${action} ${recent}（用户最近关注的标的）`;
        metadata.enhancements.push({ type: 'intent_infer', from: text, to: inferred, reason: 'verb_only_with_recent_symbol' });
        return inferred;
      }
    } catch { /* ignore */ }

    inferred = `${text}（请询问用户想${action}哪个标的）`;
    metadata.enhancements.push({ type: 'intent_infer', from: text, to: inferred, reason: 'verb_only_no_symbol' });
    return inferred;
  }

  // Pattern: number that looks like a stock code but isn't prefixed
  if (/^\d{6}$/.test(text.trim())) {
    // Already handled by stock code normalization, but add intent
    const normalized = text.trim();
    inferred = `查询 ${normalized} 的行情`;
    metadata.enhancements.push({ type: 'intent_infer', from: text, to: inferred, reason: 'bare_digits' });
    return inferred;
  }

  // Pattern: "那个"/"这个" referencing something from context
  if (/^(那个|这个|上次那个|之前的)/.test(text.trim())) {
    inferred = `${text}（请根据对话上下文理解用户指代的对象，如果不确定请询问）`;
    metadata.enhancements.push({ type: 'intent_infer', from: text, to: inferred, reason: 'pronoun_reference' });
    return inferred;
  }

  return text;
}

function _enrichContext(text, context, metadata) {
  // Add user preference context for the AI (not modifying user's text)
  // This enrichment is appended as hidden context, not shown to user
  const enrichments = [];

  // If user mentions a stock, check if they've analyzed it before
  try {
    const growthService = require('./growthService');
    const prefs = growthService.loadComponent('user_preferences.json');

    // Add frequent symbols context
    if (prefs.frequentSymbols && prefs.frequentSymbols.length > 0) {
      const mentioned = prefs.frequentSymbols.filter(s => text.includes(s.replace(/^(sh|sz)/, '')));
      if (mentioned.length > 0) {
        enrichments.push(`[用户常关注: ${mentioned.join(', ')}]`);
      }
    }
  } catch { /* best effort */ }

  // Add knowledge level context
  try {
    const { getLevelProgress } = require('./knowledgeTeachingService');
    const level = getLevelProgress();
    if (level.level !== 'beginner') {
      enrichments.push(`[用户量化水平: ${level.levelName}]`);
    }
  } catch { /* best effort */ }

  if (enrichments.length > 0) {
    metadata.enhancements.push({ type: 'context', items: enrichments });
  }

  // Return original text — enrichment goes into system context separately
  return text;
}

function _assessComplexity(text) {
  let score = 0;
  const reasons = [];

  // When input contains pasted content wrapped in <pasted-content> markers,
  // only evaluate the user's instruction (supplement), not the paste body.
  // The paste is context, not the user's task — its keywords shouldn't
  // inflate the complexity score.
  const pasteRe = /<pasted-content>\n[\s\S]*?\n<\/pasted-content>/;
  const evalText = pasteRe.test(text) ? text.replace(pasteRe, '').trim() : text;

  // Check multi-step indicators (these are inherently complex)
  for (const pattern of COMPLEXITY_INDICATORS.multiStep) {
    if (pattern.test(evalText)) {
      score += 2;  // Multi-step tasks always need planning
      reasons.push('multi_step');
      break;
    }
  }

  // Check deep analysis indicators
  for (const pattern of COMPLEXITY_INDICATORS.deepAnalysis) {
    if (pattern.test(evalText)) {
      score += 1;
      reasons.push('deep_analysis');
      break;
    }
  }

  // Check research indicators
  for (const pattern of COMPLEXITY_INDICATORS.research) {
    if (pattern.test(evalText)) {
      score += 1;
      reasons.push('research');
      break;
    }
  }

  // Length-based complexity (long prompts often need planning)
  if (evalText.length > 80) score += 1;
  if (evalText.length > 160) { score += 1; reasons.push('long_input'); }

  // Multiple stock codes = comparison task
  const codeCount = (evalText.match(/(sh|sz)\d{6}/gi) || []).length;
  if (codeCount >= 2) { score += 1; reasons.push('multi_symbol'); }

  // Multiple question marks = multiple questions
  const questionCount = (evalText.match(/[？?]/g) || []).length;
  if (questionCount >= 2) { score += 1; reasons.push('multi_question'); }

  // Simple coding/file tasks should NOT trigger plan mode — reduce score
  // when the request is a direct "write file" / "create function" task.
  if (/^(帮我|请|写|创建|生成|实现|添加).{0,10}(写|创建|生成|实现|添加|修改|修复|删除)/.test(evalText)
      || /\.(js|ts|py|c|h|vue|css|json|md)\b/.test(evalText)) {
    score = Math.max(0, score - 1);
    reasons.push('simple_coding_task');
  }

  return { score, reasons, needsPlan: score >= 3 && reasons.length >= 2 };
}

/**
 * Get context enrichment string to append to system prompt.
 */
function getContextEnrichment(userMessage) {
  const enrichments = [];

  try {
    const growthService = require('./growthService');
    const prefs = growthService.loadComponent('user_preferences.json');
    const perf = growthService.loadComponent('strategy_performance.json');

    if (prefs.frequentSymbols && prefs.frequentSymbols.length > 0) {
      enrichments.push(`用户常关注标的: ${prefs.frequentSymbols.slice(0, 5).join(', ')}`);
    }

    if (perf.insights && perf.insights.bestStrategyByCondition) {
      const best = Object.entries(perf.insights.bestStrategyByCondition);
      if (best.length > 0) {
        enrichments.push(`用户历史最佳策略: ${best.map(([k, v]) => `${k}→${v}`).join(', ')}`);
      }
    }
  } catch { /* best effort */ }

  try {
    const { getLevelProgress } = require('./knowledgeTeachingService');
    const level = getLevelProgress();
    enrichments.push(`用户量化水平: ${level.levelName} (XP: ${level.xp})`);
  } catch { /* best effort */ }

  return enrichments.length > 0 ? `\n\n[用户画像]\n${enrichments.join('\n')}` : '';
}

// ─── G10: 意图预分类 — 自然语言关键词 → 命令路由映射 ─────────────────────────

const INTENT_MAP = [
  // 每条：{ tokens: string[], route: string, label: string }
  { tokens: ['密钥', 'key', 'apikey', 'api-key', 'api_key', 'api密钥'], route: 'gateway config', label: 'API 密钥配置' },
  { tokens: ['模型', 'model', 'models', '模型状态', 'modelstatus', 'model-status'], route: 'gateway status', label: '模型状态' },
  { tokens: ['代理', 'proxy', 'clash', '翻墙', '梯子', '代理设置'], route: 'proxy', label: '代理设置' },
  { tokens: ['初始化', 'init', 'setup', '搭建', '项目初始化'], route: 'init', label: '项目初始化' },
  { tokens: ['帮助', 'help', '怎么用', '怎么使用', '教程', '使用说明'], route: 'help', label: '帮助' },
  { tokens: ['网关', 'gateway', '网关状态', 'gatewaystatus', 'gateway-status'], route: 'gateway status', label: 'AI 网关状态' },
  { tokens: ['历史', 'history', '对话记录', '会话历史'], route: 'history list', label: '对话历史' },
  { tokens: ['费用', 'cost', 'token', '花费', '余额', '用量', 'token用量'], route: 'cost', label: '费用统计' },
  { tokens: ['更新', 'update', '升级', '检查更新'], route: 'update', label: '检查更新' },
  { tokens: ['诊断', 'doctor', '检查环境', '系统诊断'], route: 'doctor', label: '系统诊断' },
  { tokens: ['清理', 'cleanup', '清除', '释放空间', '清理存储'], route: 'cleanup status', label: '清理存储' },
  { tokens: ['技能', 'skill', '插件', 'plugin', '技能管理', '插件管理'], route: 'skill list', label: '技能管理' },
  { tokens: ['安全', 'security', '权限', 'permission', '安全权限'], route: 'security status', label: '安全权限' },
  { tokens: ['登录', 'login', 'signin'], route: 'login', label: '登录' },
  { tokens: ['退出登录', 'logout', 'signout'], route: 'logout', label: '退出登录' },
  { tokens: ['审查', 'review', '代码审查', 'codereview', 'code-review', 'code_review'], route: 'review', label: '代码审查' },
  { tokens: ['定时', 'cron', '定时任务', '计划任务'], route: 'cron list', label: '定时调度' },
  { tokens: ['主题', 'theme', '皮肤', 'skin', '配色'], route: 'skin list', label: '主题皮肤' },
  { tokens: ['会话', 'session', '搜索会话', '会话搜索'], route: 'session search', label: '会话搜索' },
  { tokens: ['发布', 'publish', '打包', 'release', '发布工具'], route: 'publish check', label: '发布工具' },
];

const INTENT_ROUTE_MODES = new Set(['strict', 'balanced', 'aggressive']);
const COMMAND_INTENT_PREFIX = /^(查看|看|查|打开|配置|设置|切换|显示|列出|执行|帮我|请|show|check|list|open|get|set|switch|configure|status)/i;
const CONVERSATIONAL_SIGNAL = /(怎么|为什么|原理|思考|解释|是什么|是啥|如何|可以吗|能吗|吗|呢|？|\?|why|how|what is|explain)/i;

function _normalizeIntentToken(text = '') {
  return String(text || '').trim().toLowerCase().replace(/[\s_-]/g, '');
}

function _resolveIntentRouteMode() {
  const raw = String(process.env.KHY_INTENT_ROUTE_MODE || 'balanced').trim().toLowerCase();
  return INTENT_ROUTE_MODES.has(raw) ? raw : 'balanced';
}

function _getTokenMatchKind(rawText, entry = null) {
  if (!entry || !Array.isArray(entry.tokens) || entry.tokens.length === 0) return '';
  const normalizedText = _normalizeIntentToken(rawText);
  for (const token of entry.tokens) {
    const normalizedToken = _normalizeIntentToken(token);
    if (!normalizedToken) continue;
    if (normalizedText === normalizedToken) return 'exact';
    if (normalizedText.includes(normalizedToken)) return 'contains';
  }
  return '';
}

/**
 * G10: 匹配自然语言输入到命令路由。
 * @param {string} input — 用户原始输入
 * @returns {Array<{route: string, label: string}>} 匹配的命令路由（可能 0-N 条）
 */
function matchIntentRoutes(input) {
  if (!input || typeof input !== 'string') return [];
  const raw = input.trim();
  const text = raw.toLowerCase();
  // 排除已经是 slash 命令或明确的路由命令
  if (text.startsWith('/')) return [];
  // 排除很长输入（很可能是 AI 对话而非命令意图）
  if (text.length > 40) return [];

  const mode = _resolveIntentRouteMode();
  const isCommandLike = COMMAND_INTENT_PREFIX.test(raw);
  const looksConversational = CONVERSATIONAL_SIGNAL.test(raw);

  const matches = [];
  for (const entry of INTENT_MAP) {
    const matchKind = _getTokenMatchKind(raw, entry);
    if (!matchKind) continue;

    if (mode === 'strict') {
      if (matchKind !== 'exact') continue;
    } else if (mode === 'balanced') {
      const allowContains = isCommandLike && !looksConversational && raw.length <= 24;
      if (matchKind !== 'exact' && !allowContains) continue;
      if (looksConversational && !isCommandLike) continue;
    } else {
      // aggressive
      if (raw.length > 24) continue;
    }

    matches.push({ route: entry.route, label: entry.label });
  }
  return matches;
}

/**
 * G8: 意图澄清 + 超时降级。
 * 当 matchIntentRoutes 返回 ≥2 个候选时调用，弹出选择菜单。
 * 15s 超时后自动选择第一个候选。
 *
 * @param {Array<{route: string, label: string}>} candidates
 * @param {string} originalInput
 * @returns {Promise<{route: string, label: string}|null>} 用户选择的路由，null=发送给 AI
 */
async function clarifyIntent(candidates, originalInput) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // 非 TTY 环境直接返回第一匹配
  if (!process.stdin.isTTY) return candidates[0];

  const TIMEOUT_MS = 15000;
  let timedOut = false;

  try {
    const chalk = require('chalk').default || require('chalk');
    console.log('');
    console.log(chalk.yellow(`  检测到 "${originalInput}" 可能对应多个操作:`));

    const result = await Promise.race([
      _showClarifyMenu(candidates, chalk),
      new Promise((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve({ auto: true });
        }, TIMEOUT_MS);
      }),
    ]);

    if (timedOut || (result && result.auto)) {
      console.log(chalk.dim(`  超时 ${TIMEOUT_MS / 1000}s，自动执行: ${candidates[0].label}`));
      return candidates[0];
    }

    return result;
  } catch {
    return candidates[0];
  }
}

async function _showClarifyMenu(candidates, chalk) {
  try {
    // Dependency inversion (DESIGN-ARCH-057): the interactive menu is provided by
    // cli/ui/inkComponents via interactiveMenuPort, never required from the service
    // layer. Null when headless → fall through to the inquirer/first-candidate path.
    const selectMenu = require('./interactiveMenuPort').getMenuPrompter();
    if (!selectMenu) throw new Error('no interactive menu registered');
    const choices = [
      ...candidates.map(c => ({ name: c.label, value: c })),
      { name: '发送给 AI 对话', value: null },
    ];
    const picked = await selectMenu({ message: '请选择操作:', choices });
    return picked;
  } catch {
    // 降级到 inquirer
    try {
      const inquirer = require('inquirer');
      const choices = [
        ...candidates.map(c => ({ name: c.label, value: c })),
        { name: '发送给 AI 对话', value: null },
      ];
      const { picked } = await inquirer.prompt([{
        type: 'list', name: 'picked', message: '请选择操作:', choices,
      }]);
      return picked;
    } catch {
      return candidates[0];
    }
  }
}

module.exports = {
  preprocess,
  formatPlanDisplay,
  isPlanResponse,
  getContextEnrichment,
  matchIntentRoutes,
  clarifyIntent,
  INTENT_MAP,
};
