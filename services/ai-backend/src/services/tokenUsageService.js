/**
 * Token Usage Tracking Service
 *
 * Tracks AI token consumption per session, per day, and per month.
 * Persists daily aggregates to ~/.khyquant/token_usage.json.
 * Provides remaining quota based on subscription tier.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const USAGE_FILE = path.join(os.homedir(), '.khyquant', 'token_usage.json');

// USD to CNY exchange rate (approximate, updated periodically)
const USD_TO_CNY = 7.25;

// Per-token pricing by provider (USD per 1M tokens)
const TOKEN_PRICING = {
  'OpenAI': { input: 0.15, output: 0.60 },       // gpt-4o-mini
  'Anthropic': { input: 3.00, output: 15.00 },    // claude-3-5-sonnet
  'Google Gemini': { input: 0.075, output: 0.30 },// gemini-2.5-flash
  'Groq': { input: 0.05, output: 0.08 },          // llama-3.3
  'OpenRouter': { input: 0.10, output: 0.30 },    // varies
  '智谱AI': { input: 0.10, output: 0.10 },        // glm-4
  '讯飞星火': { input: 0.00, output: 0.00 },       // free tier
  '百度文心': { input: 0.12, output: 0.12 },       // ERNIE
  '通义千问': { input: 0.008, output: 0.02 },      // qwen-turbo
  'HuggingFace': { input: 0.00, output: 0.00 },   // free inference
  'Ollama': { input: 0.00, output: 0.00 },        // local
  'default': { input: 0.10, output: 0.30 },
};

// In-memory session accumulator (resets each REPL start)
let _sessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  requests: 0,
  costUSD: 0,
  records: [], // per-request detail
};

/**
 * Load persisted usage data from disk.
 */
function loadUsageData() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
    }
  } catch { /* ignore corrupt file */ }
  return { daily: {}, monthlyTotals: {} };
}

/**
 * Save usage data to disk.
 */
function saveUsageData(data) {
  try {
    const dir = path.dirname(USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* ignore write failure */ }
}

/**
 * Get today's date key (YYYY-MM-DD).
 */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Get current month key (YYYY-MM).
 */
function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Record a single AI request's token usage.
 * @param {string} provider - e.g. 'OpenAI', 'Anthropic', 'Groq'
 * @param {string} model - e.g. 'gpt-4o-mini', 'claude-3-5-sonnet'
 * @param {number} inputTokens - prompt/input token count
 * @param {number} outputTokens - completion/output token count
 * @param {number} [costUSD=0] - estimated cost in USD (if available)
 */
function recordUsage(provider, model, inputTokens = 0, outputTokens = 0, costUSD = 0) {
  const total = inputTokens + outputTokens;

  // Update session
  _sessionUsage.inputTokens += inputTokens;
  _sessionUsage.outputTokens += outputTokens;
  _sessionUsage.totalTokens += total;
  _sessionUsage.requests += 1;
  _sessionUsage.costUSD += costUSD;
  _sessionUsage.records.push({
    provider,
    model,
    inputTokens,
    outputTokens,
    total,
    costUSD,
    timestamp: Date.now(),
  });

  // Persist to disk (daily aggregate)
  const data = loadUsageData();
  const day = todayKey();
  const month = monthKey();

  if (!data.daily[day]) {
    data.daily[day] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costUSD: 0 };
  }
  data.daily[day].inputTokens += inputTokens;
  data.daily[day].outputTokens += outputTokens;
  data.daily[day].totalTokens += total;
  data.daily[day].requests += 1;
  data.daily[day].costUSD += costUSD;

  if (!data.monthlyTotals[month]) {
    data.monthlyTotals[month] = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costUSD: 0 };
  }
  data.monthlyTotals[month].inputTokens += inputTokens;
  data.monthlyTotals[month].outputTokens += outputTokens;
  data.monthlyTotals[month].totalTokens += total;
  data.monthlyTotals[month].requests += 1;
  data.monthlyTotals[month].costUSD += costUSD;

  // Prune old months (keep 6 months)
  const months = Object.keys(data.monthlyTotals).sort();
  while (months.length > 6) {
    delete data.monthlyTotals[months.shift()];
  }

  // Prune old days (keep 90 days)
  const days = Object.keys(data.daily).sort();
  while (days.length > 90) {
    delete data.daily[days.shift()];
  }

  saveUsageData(data);
}

/**
 * Get current session usage.
 */
function getSessionUsage() {
  return { ..._sessionUsage };
}

/**
 * Get today's usage from persistent storage.
 */
function getTodayUsage() {
  const data = loadUsageData();
  return data.daily[todayKey()] || { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costUSD: 0 };
}

/**
 * Get this month's usage.
 */
function getMonthUsage() {
  const data = loadUsageData();
  return data.monthlyTotals[monthKey()] || { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costUSD: 0 };
}

/**
 * Get remaining quota based on subscription tier.
 * @returns {{ allowed: boolean, remaining: number, limit: number, used: number }}
 */
function getRemainingQuota() {
  let tierLimits;
  try {
    const { getCurrentTier, TIERS } = require('./subscriptionService');
    const tier = getCurrentTier();
    tierLimits = TIERS[tier]?.limits?.cloud_ai_tokens;
  } catch {
    tierLimits = undefined;
  }

  // Default to free tier limit if subscription service unavailable
  const limit = tierLimits ?? 100000;
  const used = getMonthUsage().totalTokens;

  if (limit === -1) {
    return { allowed: true, remaining: Infinity, limit: -1, used };
  }

  return {
    allowed: used < limit,
    remaining: Math.max(0, limit - used),
    limit,
    used,
  };
}

/**
 * Get usage history for the past N days.
 * @param {number} days
 * @returns {Array<{ date: string, totalTokens: number, requests: number }>}
 */
function getUsageHistory(days = 30) {
  const data = loadUsageData();
  const result = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const dayData = data.daily[key];
    result.push({
      date: key,
      totalTokens: dayData?.totalTokens || 0,
      requests: dayData?.requests || 0,
      costUSD: dayData?.costUSD || 0,
    });
  }

  return result;
}

/**
 * Format a concise inline summary for REPL display (single line).
 * @param {number} currentTokens - tokens used in latest request
 * @returns {string}
 */
function formatInlineSummary(currentTokens) {
  const session = _sessionUsage.totalTokens;
  const quota = getRemainingQuota();
  const fmtNum = (n) => n.toLocaleString('en-US');

  let line = `  \u{1F4CA} 本次: ${fmtNum(currentTokens)} tokens`;
  line += ` \u00B7 会话累计: ${fmtNum(session)}`;

  if (quota.limit !== -1) {
    line += ` \u00B7 剩余: ${fmtNum(quota.remaining)}/${fmtNum(quota.limit)}`;
  } else {
    line += ` \u00B7 额度: 无限制`;
  }

  return line;
}

/**
 * Format full usage report for the `usage` command.
 * @returns {string}
 */
function formatUsageReport() {
  const chalk = require('chalk').default || require('chalk');
  const session = getSessionUsage();
  const today = getTodayUsage();
  const month = getMonthUsage();
  const quota = getRemainingQuota();

  const fmtNum = (n) => n.toLocaleString('en-US');
  const d = chalk.dim;
  const w = chalk.white;
  const g = chalk.green;
  const y = chalk.yellow;
  const r = chalk.red;

  let out = '';
  out += chalk.bold('  📊 AI Token 用量统计\n\n');

  // Session
  out += w('  本次会话:\n');
  out += d('    请求次数: ') + w(session.requests) + '\n';
  out += d('    输入 tokens: ') + w(fmtNum(session.inputTokens)) + '\n';
  out += d('    输出 tokens: ') + w(fmtNum(session.outputTokens)) + '\n';
  out += d('    合计: ') + chalk.bold(fmtNum(session.totalTokens)) + '\n';
  if (session.costUSD > 0) {
    out += d('    预估费用: ') + y(`$${session.costUSD.toFixed(4)}`) + '\n';
  }
  out += '\n';

  // Today
  out += w('  今日用量:\n');
  out += d('    请求次数: ') + w(today.requests) + '\n';
  out += d('    合计 tokens: ') + w(fmtNum(today.totalTokens)) + '\n';
  out += '\n';

  // Month
  out += w('  本月用量:\n');
  out += d('    请求次数: ') + w(month.requests) + '\n';
  out += d('    合计 tokens: ') + w(fmtNum(month.totalTokens)) + '\n';
  if (month.costUSD > 0) {
    out += d('    预估费用: ') + y(`$${month.costUSD.toFixed(4)}`) + '\n';
  }
  out += '\n';

  // Quota
  out += w('  额度:\n');
  if (quota.limit === -1) {
    out += d('    月限额: ') + g('无限制 (企业版)') + '\n';
  } else {
    const pct = Math.round((quota.used / quota.limit) * 100);
    const color = pct > 90 ? r : pct > 70 ? y : g;
    out += d('    月限额: ') + w(fmtNum(quota.limit)) + '\n';
    out += d('    已使用: ') + color(`${fmtNum(quota.used)} (${pct}%)`) + '\n';
    out += d('    剩余: ') + color(fmtNum(quota.remaining)) + '\n';
  }

  return out;
}

/**
 * Estimate token count from text (fallback when API doesn't return usage).
 * Rough heuristic: ~4 chars per token for English, ~2 chars per token for Chinese.
 */
function estimateTokens(text) {
  if (!text) return 0;
  // Count Chinese characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const nonCjkLen = text.length - cjkCount;
  return Math.ceil(cjkCount / 1.5 + nonCjkLen / 4);
}

/**
 * Calculate cost for a request based on provider pricing.
 * @param {string} provider
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {{ costUSD: number, costCNY: number }}
 */
function calculateCost(provider, inputTokens, outputTokens) {
  const pricing = TOKEN_PRICING[provider] || TOKEN_PRICING['default'];
  const costUSD = (inputTokens * pricing.input + outputTokens * pricing.output) / 1000000;
  const costCNY = costUSD * USD_TO_CNY;
  return { costUSD, costCNY };
}

/**
 * Get total cost for session in both currencies.
 */
function getSessionCost() {
  let totalUSD = 0;
  for (const rec of _sessionUsage.records) {
    const pricing = TOKEN_PRICING[rec.provider] || TOKEN_PRICING['default'];
    totalUSD += (rec.inputTokens * pricing.input + rec.outputTokens * pricing.output) / 1000000;
  }
  return { costUSD: totalUSD, costCNY: totalUSD * USD_TO_CNY };
}

/**
 * Format cost report (Claude-like /cost command output, RMB primary).
 */
function formatCostReport() {
  const chalk = require('chalk').default || require('chalk');
  const session = getSessionUsage();
  const today = getTodayUsage();
  const month = getMonthUsage();
  const sessionCost = getSessionCost();
  const quota = getRemainingQuota();

  const fmtNum = (n) => n.toLocaleString('en-US');
  const fmtCNY = (n) => `\u00A5${n.toFixed(4)}`;
  const fmtUSD = (n) => `$${n.toFixed(4)}`;
  const d = chalk.dim;
  const w = chalk.white;
  const g = chalk.green;
  const y = chalk.yellow;
  const r = chalk.red;
  const b = chalk.bold;

  let out = '\n';
  out += b('  \u{1F4B0} Token 用量 & 费用\n\n');

  // Session cost (primary)
  out += w('  \u250C\u2500 本次会话\n');
  out += d('  \u2502 ') + d('请求: ') + w(session.requests) + d(' 次') + '\n';
  out += d('  \u2502 ') + d('输入: ') + w(fmtNum(session.inputTokens)) + d(' tokens') + '\n';
  out += d('  \u2502 ') + d('输出: ') + w(fmtNum(session.outputTokens)) + d(' tokens') + '\n';
  out += d('  \u2502 ') + d('合计: ') + b(fmtNum(session.totalTokens)) + d(' tokens') + '\n';
  out += d('  \u2502 ') + d('费用: ') + y(fmtCNY(sessionCost.costCNY)) + d(` (${fmtUSD(sessionCost.costUSD)})`) + '\n';
  out += d('  \u2514\n\n');

  // Today
  out += w('  \u250C\u2500 今日\n');
  out += d('  \u2502 ') + d('请求: ') + w(today.requests) + d(' 次') + '\n';
  out += d('  \u2502 ') + d('tokens: ') + w(fmtNum(today.totalTokens)) + '\n';
  out += d('  \u2514\n\n');

  // Month
  out += w('  \u250C\u2500 本月\n');
  out += d('  \u2502 ') + d('请求: ') + w(month.requests) + d(' 次') + '\n';
  out += d('  \u2502 ') + d('tokens: ') + w(fmtNum(month.totalTokens)) + '\n';
  out += d('  \u2514\n\n');

  // Quota bar
  if (quota.limit !== -1) {
    const pct = Math.round((quota.used / quota.limit) * 100);
    const color = pct > 90 ? r : pct > 70 ? y : g;
    const barLen = 20;
    const filled = Math.round(barLen * Math.min(pct, 100) / 100);
    const bar = color('\u2588'.repeat(filled)) + d('\u2591'.repeat(barLen - filled));
    out += w('  额度: ') + bar + ` ${color(pct + '%')} ` + d(`(${fmtNum(quota.used)}/${fmtNum(quota.limit)})`) + '\n';
  } else {
    out += w('  额度: ') + g('无限制 (企业版)') + '\n';
  }

  out += '\n';
  return out;
}

/**
 * Reset all usage data.
 */
function resetUsage() {
  _sessionUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, costUSD: 0, records: [] };
  saveUsageData({ daily: {}, monthlyTotals: {} });
}

module.exports = {
  recordUsage,
  getSessionUsage,
  getTodayUsage,
  getMonthUsage,
  getRemainingQuota,
  getUsageHistory,
  formatInlineSummary,
  formatUsageReport,
  formatCostReport,
  calculateCost,
  getSessionCost,
  estimateTokens,
  resetUsage,
  TOKEN_PRICING,
  USD_TO_CNY,
};
