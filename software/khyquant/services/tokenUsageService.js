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

// 刀110:会话级「代码改动」账本(对齐 CC /cost "Total code changes")。跨轮累计,进程内
// 会话作用域(随 resetUsage 归零,不落盘 —— 与 CC 的 per-session cost 同口径)。由
// toolUseLoop 交付汇总点经 codeChangeStats.collectUncountedChurn 幂等喂入。
let _codeChanges = { added: 0, removed: 0 };

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
 * 刀110:累加本会话代码改动行数(fail-soft;非有限/非正值忽略)。
 * @param {number} added   本次新增行
 * @param {number} removed 本次删除行
 */
function recordCodeChange(added, removed) {
  try {
    const a = Number(added);
    const r = Number(removed);
    if (Number.isFinite(a) && a > 0) _codeChanges.added += Math.floor(a);
    if (Number.isFinite(r) && r > 0) _codeChanges.removed += Math.floor(r);
  } catch { /* fail-soft:账本绝不影响主流程 */ }
}

/** 刀110:读取本会话代码改动累计(副本,防外部改写)。 */
function getCodeChanges() {
  return { ..._codeChanges };
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
 * Format a token count for the /cost·/usage report — single source of truth.
 *
 * CC 后端口径对齐:CC 的 `/cost` 报表(`cost-tracker.ts::formatModelUsage`)与
 * `Stats.tsx` "Total tokens" 一律用 `formatNumber`(紧凑记数:`1234567 → "1.2m"`、
 * `12345 → "12.3k"`、`<1000` 原样),与 khy 其余**所有** token 显示面(HUD/Spinner/
 * Footer/Compaction/turnStats 等,均走 `ccFormatTokens`)同口径。此前 `/cost`·`/usage`
 * 报表子系统是唯一漏网:三处局部 `fmtNum = n.toLocaleString('en-US')` 产**全分隔符**
 * (`"1,234,567"`)——既偏离 CC 报表逻辑,又与 khy 自身其余 token 面不一致。
 *
 * 收敛到 `ccFormatTokens` SSOT。门控 KHY_CC_FORMAT 默认开;关 / require 失败 / 非有限
 * (`ccFormatTokens` 返回 '')→ 逐字节回退 call-site 自带 `legacy`(各自历史 toLocaleString
 * 口径,保证门控关时输出逐字节一致)。
 *
 * **诚实边界(精度权衡)**:报表/额度行紧凑化后,`剩余 1.2m / 2m (62%)` 不再逐位可读;
 * 精度由并列的百分比承载,且这正是 CC `/cost` 的既定选择。需要全精度的用户可
 * `KHY_CC_FORMAT=off` 逐字节取回旧 `1,234,567` 报表(门控即逃生舱,绝不丢失旧行为)。
 *
 * @param {number} n
 * @param {string} legacy - 预算好的旧口径回退串(各 call-site 自带,保门控关字节一致)
 * @param {object} [env]
 * @returns {string}
 */
function _fmtTokenCount(n, legacy, env = process.env) {
  try {
    const { ccFormatEnabled, ccFormatTokens } = require('../cli/ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatTokens(Number(n));
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  return legacy != null ? legacy : Number(n).toLocaleString('en-US');
}

/**
 * Format a concise inline summary for REPL display (single line).
 * @param {number} currentTokens - tokens used in latest request
 * @returns {string}
 */
function formatInlineSummary(currentTokens) {
  const session = _sessionUsage.totalTokens;
  const quota = getRemainingQuota();
  const fmtNum = (n) => _fmtTokenCount(n, n.toLocaleString('en-US'));

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

  const fmtNum = (n) => _fmtTokenCount(n, n.toLocaleString('en-US'));
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
 * Convenience: estimate cost from model/provider name + token counts.
 * Tries model name first, then provider name, then default.
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelOrProvider - model name or provider key
 * @returns {number} costUSD
 */
function estimateCost(inputTokens, outputTokens, modelOrProvider) {
  const key = String(modelOrProvider || '').toLowerCase();
  // Try to match a pricing key by substring
  let pricing = TOKEN_PRICING['default'];
  for (const [name, p] of Object.entries(TOKEN_PRICING)) {
    if (name !== 'default' && key.includes(name.toLowerCase())) {
      pricing = p;
      break;
    }
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1000000;
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

  const fmtNum = (n) => _fmtTokenCount(n, n.toLocaleString('en-US'));
  // Cost precision routed through the CC formatCost magnitude rule (SSOT
  // ccFormat.ccFormatCostOr, same pattern as the hudRenderer status line):
  // amount > 0.5 -> 2 decimals (cents); <= 0.5 -> 4 decimals (sub-cent). Gate
  // KHY_CC_FORMAT off -> byte-identical fallback to each site's own toFixed(4)
  // (this /cost panel's historical format). ccFormat.js's header already lists
  // "router /cost hardcoded toFixed(4)" as a convergence target; this wires the
  // one call-site that was left stranded.
  const { ccFormatCostOr } = require('../cli/ccFormat');
  const fmtCNY = (n) => `\u00A5${ccFormatCostOr(n, n.toFixed(4), process.env)}`;
  const fmtUSD = (n) => `$${ccFormatCostOr(n, n.toFixed(4), process.env)}`;
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
  // \u5200110:\u4f1a\u8bdd\u4ee3\u7801\u6539\u52a8(\u5bf9\u9f50 CC /cost "Total code changes")\u3002\u95e8\u63a7 KHY_CODE_CHANGES
  // \u5173 / \u65e0\u6539\u52a8 \u2192 \u4e0d\u8ffd\u52a0\u6b64\u884c(\u9010\u5b57\u8282\u56de\u9000\u4eca\u65e5\u62a5\u8868)\u3002fail-soft:\u7edd\u4e0d\u5f71\u54cd\u4e3b\u62a5\u8868\u3002
  try {
    const _ccs = require('./codeChangeStats');
    if (_ccs.codeChangesEnabled(process.env)) {
      const _cc = getCodeChanges();
      const _ccVal = _ccs.buildCodeChangesValue(_cc.added, _cc.removed);
      if (_ccVal) out += d('  \u2502 ') + d('\u6539\u52a8: ') + w(_ccVal) + '\n';
    }
  } catch { /* fail-soft */ }
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

  // \u520093: \u6309\u6a21\u578b\u7528\u91cf(\u5bf9\u9f50 CC `cost-tracker.ts::formatModelUsage` \u7684 "Usage by model:")\u3002
  // \u6bcf\u6b21\u8bf7\u6c42\u65e9\u5df2\u628a {model,inputTokens,outputTokens,total,costUSD} \u8bb0\u8fdb _sessionUsage.records
  // (recordUsage),\u6b64\u524d /cost \u53ea\u6c47\u6210\u4e00\u7b14\u4f1a\u8bdd\u603b\u989d\u3001\u4ece\u4e0d\u6309\u6a21\u578b\u5f52\u7ec4 \u2192 half-wired\u3002\u7eaf\u5f52\u7ec4\u51b3\u7b56\u5728
  // \u53f6\u5b50 costByModel;\u6a21\u578b\u6807\u7b7e\u590d\u7528 cli/ccModelName.formatModelLabel \u8fd9\u4e00 SSOT(\u7531\u58f3\u6ce8\u5165,\u53f6\u5b50
  // \u4fdd\u96f6\u4f9d\u8d56)\u3002\u8bda\u5b9e\u8fb9\u754c:record \u65e0 cache read/write \u5206\u9879 \u2192 \u53ea\u5217 \u8f93\u5165/\u8f93\u51fa/\u8d39\u7528,\u4e0d\u81c6\u9020 cache \u5217
  // (\u4e0e\u520092 \u7701\u7565\u65e0\u5e95\u5ea7\u5b57\u6bb5\u540c\u7eaa\u5f8b)\u3002\u95e8\u63a7 KHY_COST_BY_MODEL \u5173 \u2192 \u4e0d\u8ffd\u52a0\u672c\u6bb5(\u9010\u5b57\u8282\u56de\u9000)\u3002
  try {
    const cbm = require('./costByModel');
    if (cbm.costByModelEnabled(process.env) && Array.isArray(session.records) && session.records.length) {
      const { formatModelLabel } = require('../cli/ccModelName');
      const rows = cbm.aggregateSessionUsageByModel(session.records, (m) => formatModelLabel(m, process.env));
      if (rows.length) {
        out += w('  \u250c\u2500 \u6309\u6a21\u578b\u7528\u91cf\uff08\u672c\u6b21\u4f1a\u8bdd\uff09\n');
        for (const row of rows) {
          const cny = row.cost * USD_TO_CNY;
          out += d('  \u2502 ') + w(row.label) + d(': ')
            + w(fmtNum(row.input)) + d(' \u8f93\u5165 \u00b7 ') + w(fmtNum(row.output)) + d(' \u8f93\u51fa')
            + d(' \u00b7 ') + y(fmtCNY(cny)) + d(` (${fmtUSD(row.cost)})`) + '\n';
        }
        out += d('  \u2514\n\n');
      }
    }
  } catch { /* fail-soft: \u5f52\u7ec4\u5931\u8d25\u7edd\u4e0d\u5f71\u54cd\u4e3b\u62a5\u8868 */ }

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
  _compressionStats = { originalTokens: 0, compressedTokens: 0, savedTokens: 0, requests: 0 };
  saveUsageData({ daily: {}, monthlyTotals: {} });
}

// ── Tokenless compression tracking ──────────────────────────────────

let _compressionStats = { originalTokens: 0, compressedTokens: 0, savedTokens: 0, requests: 0 };

/**
 * Record compression savings for a single request.
 * @param {number} originalTokens - Token count before compression
 * @param {number} compressedTokens - Token count after compression
 */
function recordCompressionSavings(originalTokens, compressedTokens) {
  const saved = Math.max(0, originalTokens - compressedTokens);
  _compressionStats.originalTokens += originalTokens;
  _compressionStats.compressedTokens += compressedTokens;
  _compressionStats.savedTokens += saved;
  _compressionStats.requests++;
}

/**
 * Get compression statistics for the current session.
 */
function getCompressionStats() {
  const { originalTokens, compressedTokens, savedTokens, requests } = _compressionStats;
  return {
    originalTokens,
    compressedTokens,
    savedTokens,
    savedPercent: originalTokens > 0 ? Math.round((savedTokens / originalTokens) * 100) : 0,
    requests,
  };
}

module.exports = {
  recordUsage,
  getSessionUsage,
  recordCodeChange,
  getCodeChanges,
  getTodayUsage,
  getMonthUsage,
  getRemainingQuota,
  getUsageHistory,
  formatInlineSummary,
  formatUsageReport,
  formatCostReport,
  calculateCost,
  estimateCost,
  getSessionCost,
  estimateTokens,
  resetUsage,
  recordCompressionSavings,
  getCompressionStats,
  TOKEN_PRICING,
  USD_TO_CNY,
  _fmtTokenCount,
};
