'use strict';

/**
 * ccFormatters.js —— CC 模式格式化纯函数
 *
 * 支持 Claude 和 OpenAI 双家族模型名格式化、
 * 上下文百分比、倒计时格式化等。
 *
 * 参考：[DESIGN-ARCH-081] OpenAI 协议支持规范
 */

// ── 模型名格式化 ────────────────────────────────────────────────────────────

/**
 * 格式化模型名 —— 支持 Claude 和 OpenAI 双家族
 *
 * Claude 模型:
 *   "claude-opus-4-6" → "Opus 4.6"
 *   "claude-sonnet-4" → "Sonnet 4"
 *
 * OpenAI 模型:
 *   "gpt-4o" → "GPT-4o"
 *   "gpt-4o-mini" → "GPT-4o mini"
 *   "gpt-4-turbo" → "GPT-4 Turbo"
 *   "o1-preview" → "o1 Preview"
 *
 * 其他模型: 返回原始 slug
 */
function formatModelName(modelId) {
  if (!modelId) return 'Unknown';

  // Claude 模型
  const claudeMatch = /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/i.exec(modelId);
  if (claudeMatch) {
    const [, family, major, minor] = claudeMatch;
    const familyName = capitalize(family);
    const version = minor ? `${major}.${minor}` : major;
    return `${familyName} ${version}`;
  }

  // OpenAI GPT 模型（含 gpt-4o / gpt-4o-mini 特殊处理）
  const gptOMatch = /^gpt-(\d+)(o)(-(mini|preview))?/i.exec(modelId);
  if (gptOMatch) {
    const [, major, , , variant] = gptOMatch;
    const base = `GPT-${major}o`;
    if (variant) {
      // mini 保持小写（对齐 CC 风格），preview 首字母大写
      const v = variant.toLowerCase() === 'mini' ? 'mini' : capitalize(variant);
      return `${base} ${v}`;
    }
    return base;
  }

  // OpenAI GPT 模型（标准编号版）
  const gptMatch = /^gpt-(\d+)(?:[-.](\d+))?(-(?:turbo|mini|preview))?/i.exec(modelId);
  if (gptMatch) {
    const [, major, minor, suffix] = gptMatch;
    const base = `GPT-${major}${minor ? '.' + minor : ''}`;
    if (suffix) {
      const suffixName = capitalize(suffix.slice(1));
      return `${base} ${suffixName}`;
    }
    return base;
  }

  // OpenAI o 系列推理模型
  const oMatch = /^(o[1-9])-(mini|preview|pro)/i.exec(modelId);
  if (oMatch) {
    const [, family, variant] = oMatch;
    const variantName = variant.toLowerCase() === 'mini'
      ? 'mini'
      : capitalize(variant);
    return `${family} ${variantName}`;
  }

  // 未知模型：返回原始 slug
  return modelId;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── 上下文格式化 ────────────────────────────────────────────────────────────

/**
 * 格式化 token 数为简短形式
 * 1234567 → "1.2M", 12345 → "12k"
 */
function formatTokenCount(n) {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

/**
 * 格式化上下文使用量
 * { used: 50000, total: 1000000 } → "Context 45% (50k/1M)"
 */
function formatContext(used, total) {
  if (!total) return 'Context —';
  const pct = Math.min(100, Math.round((used / total) * 100));
  return `Context ${pct}% (${formatTokenCount(used)}/${formatTokenCount(total)})`;
}

/**
 * 获取上下文用量状态（normal/warning/critical）
 */
function getContextStatus(used, total) {
  if (!total) return 'normal';
  const ratio = used / total;
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.80) return 'warning';
  return 'normal';
}

// ── 倒计时格式化 ────────────────────────────────────────────────────────────

/**
 * 格式化倒计时秒数为可读形式
 * 3661 → "1h01m", 89 → "1m29s", 45 → "45s"
 */
function formatCountdown(totalSeconds) {
  if (totalSeconds == null || totalSeconds <= 0) return '0s';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

// ── 费用格式化 ──────────────────────────────────────────────────────────────

/**
 * 格式化费用（USD）
 */
function formatCost(usd) {
  if (usd == null) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

// ── 复制反馈格式化 ──────────────────────────────────────────────────────────

/**
 * 格式化复制反馈
 */
function formatCopyFeedback(text) {
  if (!text) return '';
  const lines = text.split('\n').length;
  const chars = text.length;
  const bytes = Buffer.byteLength(text, 'utf8');

  if (lines > 1) return `copied ${lines} lines`;
  if (bytes > 1024) return `copied ${(bytes / 1024).toFixed(1)}KB`;
  return `copied ${chars} chars`;
}

/**
 * 格式化粘贴反馈
 */
function formatPasteFeedback(text) {
  if (!text) return '';
  const lines = text.split('\n').length;
  if (lines > 1) return `Pasted ~${lines} lines`;
  return `Pasted ${text.length} chars`;
}

module.exports = {
  formatModelName,
  formatTokenCount,
  formatContext,
  getContextStatus,
  formatCountdown,
  formatCost,
  formatCopyFeedback,
  formatPasteFeedback,
  capitalize,
};
