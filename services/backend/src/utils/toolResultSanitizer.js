'use strict';

/**
 * toolResultSanitizer.js — Y-code 风格工具结果脱敏管道。
 *
 * 基于 Y-code core/tool_presenter.py 的 sanitize_tool_display_text()，
 * 适配 Khyos 服务端场景。
 *
 * 脱敏层级（按序执行）：
 *  1. 剥离 ANSI 转义码（复用 utils/stripAnsi）
 *  2. 替换 cookie 头部为 ***
 *  3. 剥离控制字符（0x00-0x1f 除 \n/\r）
 *  4. 替换已命名密钥 (api_key=, password=, token=, secret=, client_secret=, cookie=)
 *  5. 替换 Bearer token
 *  6. 替换 OpenAI 密钥 (sk-...)
 *  7. 合并连续空白 + 截断到指定长度（复用 utils/collapseWhitespace）
 *
 * 所有正则均为确定性、无状态，不依赖外部服务。
 */

const collapseWhitespace = require('./collapseWhitespace');
const maskSecret = require('./maskSecret');
const maskToken = require('./maskToken');
const stripAnsi = require('./stripAnsi');

// ─── Regex patterns ────────────────────────────────────────────────────────

const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const COOKIE_HEADER_RE = /^(\s*(?:set-)?cookie\s*:\s*)[^\r\n]*/im;
const NAMED_SECRET_RE =
  /(["']?(?:api[_-]?key|authorization|token|password|client[_-]?secret|secret|cookie)["']?\s*[:=]\s*)(Bearer\s+[A-Za-z0-9._~+/=-]+|"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_RE = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}\b/g;

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Sanitize tool result text for safe display.
 *
 * @param {string|null|undefined} value - Raw tool result text
 * @param {number} [limit=160] - Maximum visible length after sanitization
 * @returns {string} Sanitized, truncated text safe for display
 */
function sanitizeToolDisplayText(value, limit) {
  limit = typeof limit === 'number' ? limit : 160;

  const text = _pipeline(value);

  if (text.length <= limit) {
    return text;
  }

  if (limit <= 3) {
    return text.slice(0, limit);
  }
  const head = text.slice(0, limit - 3);
  return head.replace(/\s+$/, '') + '...';
}

/**
 * Full sanitization (no truncation) — for internal pipelines that handle
 * truncation separately.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function fullSanitize(value) {
  return _pipeline(value);
}

/**
 * Sanitize an object's string values recursively — useful for tool result
 * objects with multiple fields.
 *
 * @param {object} obj
 * @param {number} [fieldLimit=160]
 * @returns {object}
 */
function sanitizeToolResultObject(obj, fieldLimit) {
  fieldLimit = typeof fieldLimit === 'number' ? fieldLimit : 160;

  if (typeof obj === 'string') {
    return sanitizeToolDisplayText(obj, fieldLimit);
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeToolResultObject(item, fieldLimit));
  }

  if (obj && typeof obj === 'object') {
    const result = {};
    for (const key of Object.keys(obj)) {
      result[key] = sanitizeToolResultObject(obj[key], fieldLimit);
    }
    return result;
  }

  return obj;
}

// ─── Private pipeline ───────────────────────────────────────────────────────

function _pipeline(value) {
  let text = String(value || '');
  text = stripAnsi(text);
  text = text.replace(/\r/g, ' ');
  text = text.replace(CONTROL_RE, '');
  text = text.replace(COOKIE_HEADER_RE, (match, prefix) => prefix + '***');
  text = text.replace(NAMED_SECRET_RE, (match, keyPart) => keyPart + '***');
  text = text.replace(BEARER_RE, (match, prefix) => prefix + '***');
  text = text.replace(OPENAI_KEY_RE, '***');
  text = collapseWhitespace(text);
  return text;
}

// ─── Tool-specific presenters (Y-code pattern) ────────────────────────────

/**
 * Determine human-readable action label for a tool call.
 * Mirrors Y-code's _TOOL_ACTIONS mapping.
 *
 * @param {string} toolName
 * @returns {string}
 */
function toolActionLabel(toolName) {
  const map = {
    Read: '查看文件',
    Write: '写入文件',
    Edit: '修改文件',
    Glob: '查找文件',
    Grep: '搜索代码',
    shellCommand: '执行命令',
    List: '查看目录',
  };
  return map[toolName] || '使用 ' + toolName;
}

/**
 * Extract target identifier from tool arguments — what the user cares about.
 *
 * @param {string} toolName
 * @param {object} args
 * @returns {string}
 */
function toolTarget(toolName, args) {
  if (!args || typeof args !== 'object') {
    return '';
  }
  const keyMap = {
    Read: 'file_path',
    Write: 'file_path',
    Edit: 'file_path',
    shellCommand: 'command',
    Glob: 'pattern',
    Grep: 'pattern',
    List: 'path',
  };
  const key = keyMap[toolName];
  if (!key) {
    return '';
  }
  let target = String(args[key] || '').trim();
  if (!target) {
    return '';
  }
  // Truncate long targets
  if (target.length > 120) {
    target = target.slice(0, 117) + '...';
  }
  return target;
}

/**
 * Build display-safe tool result summary from execution result.
 *
 * @param {object} args - Original tool arguments
 * @param {object} result - Tool execution result
 * @param {boolean} ok - Whether tool succeeded
 * @returns {object} Display-safe metadata
 */
function buildToolDisplay(args, result, ok) {
  const resultData = result || {};
  const metrics = {};
  const content = resultData.content;

  if (typeof content === 'string' && content) {
    metrics.line_count = content.split('\n').length;
  }

  let error_summary = '';
  if (ok === false) {
    const raw = String(resultData.content || '')
      .replace(/^[^\w]*/, '')
      .trim();
    error_summary = sanitizeToolDisplayText(raw, 160);
  }

  return {
    action: '',
    target: toolTarget('', args),
    metrics,
    error_summary,
    line_count: metrics.line_count || 0,
  };
}

// ─── Module exports ────────────────────────────────────────────────────────

module.exports = {
  sanitizeToolDisplayText,
  fullSanitize,
  sanitizeToolResultObject,
  toolActionLabel,
  toolTarget,
  buildToolDisplay,
};
