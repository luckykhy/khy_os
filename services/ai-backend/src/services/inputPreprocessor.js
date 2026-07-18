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

  // Check multi-step indicators (these are inherently complex)
  for (const pattern of COMPLEXITY_INDICATORS.multiStep) {
    if (pattern.test(text)) {
      score += 2;  // Multi-step tasks always need planning
      reasons.push('multi_step');
      break;
    }
  }

  // Check deep analysis indicators
  for (const pattern of COMPLEXITY_INDICATORS.deepAnalysis) {
    if (pattern.test(text)) {
      score += 1;
      reasons.push('deep_analysis');
      break;
    }
  }

  // Check research indicators
  for (const pattern of COMPLEXITY_INDICATORS.research) {
    if (pattern.test(text)) {
      score += 1;
      reasons.push('research');
      break;
    }
  }

  // Length-based complexity (long prompts often need planning)
  if (text.length > 40) score += 1;
  if (text.length > 80) { score += 1; reasons.push('long_input'); }

  // Multiple stock codes = comparison task
  const codeCount = (text.match(/(sh|sz)\d{6}/gi) || []).length;
  if (codeCount >= 2) { score += 1; reasons.push('multi_symbol'); }

  // Multiple question marks = multiple questions
  const questionCount = (text.match(/[？?]/g) || []).length;
  if (questionCount >= 2) { score += 1; reasons.push('multi_question'); }

  return { score, reasons, needsPlan: score >= 2 && reasons.length >= 1 };
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

module.exports = {
  preprocess,
  formatPlanDisplay,
  isPlanResponse,
  getContextEnrichment,
};
