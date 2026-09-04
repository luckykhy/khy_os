'use strict';

/**
 * trafficLogger.js — AI Gateway 流量记录器（中间件模式）。
 *
 * 嵌入 aiGateway 核心调用链，自动记录所有 AI API 请求/响应。
 * 零外部依赖，纯 Node.js 事件驱动。
 *
 * 设计原则：
 *   - 环形缓冲区：内存有界，默认保留最近 2000 条
 *   - 事件驱动：通过 EventEmitter 实时推送流量到前端
 *   - 敏感信息脱敏：Authorization / x-api-key / Cookie 自动替换为 [REDACTED]
 *   - HAR 兼容：导出标准 HAR 格式，可在 Chrome DevTools 中加载
 *   - 零硬编码：所有端点从 serviceDefaults.js 导入
 *
 * @module gateway/traffic-logger
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');

// ── 配置常量 ────────────────────────────────────────────────────
const DEFAULT_MAX_ENTRIES = 2000;
const MAX_BODY_PREVIEW = 8000; // 单条 body 最大预览字符
const SENSITIVE_HEADER_PATTERNS = [
  /authorization/i,
  /x-api-key/i,
  /api-key/i,
  /cookie/i,
  /set-cookie/i,
  /proxy-authorization/i,
  /x-auth-token/i,
  /x-csrf-token/i,
];

// ── 敏感头脱敏 ──────────────────────────────────────────────────
function sanitizeHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  const safe = {};
  for (const [key, value] of Object.entries(headers)) {
    const isSensitive = SENSITIVE_HEADER_PATTERNS.some((p) => p.test(key));
    safe[key] = isSensitive ? '[REDACTED]' : value;
  }
  return safe;
}

// ── 安全截断 body ───────────────────────────────────────────────
function truncateBody(body, maxLen = MAX_BODY_PREVIEW) {
  if (body == null) {
    return '';
  }
  let text = typeof body === 'string' ? body : JSON.stringify(body);
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}… [截断，共 ${text.length} 字符]`;
}

// ── 提取 token 用量（多 provider 兼容）──────────────────────────
function extractTokenUsage(responseBody) {
  if (!responseBody) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  // OpenAI / Anthropic / DeepSeek 通用格式
  const usage = responseBody.usage || {};
  return {
    inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
    outputTokens: usage.output_tokens || usage.completion_tokens || 0,
    totalTokens:
      usage.total_tokens ||
      (usage.input_tokens || usage.prompt_tokens || 0) +
        (usage.output_tokens || usage.completion_tokens || 0),
  };
}

// ════════════════════════════════════════════════════════════════
// TrafficLogger 类
// ════════════════════════════════════════════════════════════════
class TrafficLogger extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=2000] — 环形缓冲区大小
   * @param {boolean} [opts.enableCapture=true] — 是否启用捕获（门控）
   */
  constructor(opts = {}) {
    super();
    this._maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
    this._enabled = opts.enableCapture !== false;
    this._watchMode = false; // 用户主动 watch 模式（全量记录）
    this._entries = []; // 环形缓冲区
    this._stats = {
      totalRequests: 0,
      totalErrors: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalDurationMs: 0,
      startTime: Date.now(),
    };
    this._providerStats = new Map(); // provider → { requests, errors, tokens, durationMs }
    this._sessionStats = new Map(); // sessionId → { requests, tokens, durationMs }
  }

  // ── 核心：记录一条流量 ────────────────────────────────────────
  /**
   * 记录一次 AI API 调用。
   *
   * @param {object} entry
   * @param {string} entry.sessionId — 会话 ID
   * @param {string} entry.provider — 提供商（claude/deepseek/openai/...）
   * @param {string} entry.model — 模型名
   * @param {string} entry.adapterKey — 适配器 key
   * @param {string} entry.url — 请求端点（从 serviceDefaults 导入）
   * @param {string} [entry.method='POST'] — HTTP 方法
   * @param {object} [entry.requestHeaders] — 请求头（会被脱敏）
   * @param {*} [entry.requestBody] — 请求体
   * @param {number} [entry.statusCode=200] — HTTP 状态码
   * @param {object} [entry.responseHeaders] — 响应头
   * @param {*} [entry.responseBody] — 响应体
   * @param {number} [entry.durationMs=0] — 请求耗时
   * @param {boolean} [entry.success=true] — 是否成功
   * @param {string} [entry.errorMessage] — 错误信息
   * @param {string} [entry.traceId] — 链路追踪 ID
   * @returns {object} 记录后的条目
   */
  record(entry = {}) {
    if (!this._enabled) {
      return null;
    }

    const now = Date.now();
    const tokenUsage = extractTokenUsage(entry.responseBody);
    const success = entry.success !== false && !(entry.statusCode >= 400);

    const record = {
      id: crypto.randomUUID(),
      timestamp: now,
      sessionId: entry.sessionId || 'default',
      provider: entry.provider || 'unknown',
      model: entry.model || 'unknown',
      adapterKey: entry.adapterKey || 'unknown',
      url: entry.url || '',
      method: entry.method || 'POST',
      requestHeaders: sanitizeHeaders(entry.requestHeaders),
      requestBody: truncateBody(entry.requestBody),
      statusCode: entry.statusCode || 0,
      responseHeaders: sanitizeHeaders(entry.responseHeaders),
      responseBody: truncateBody(entry.responseBody),
      durationMs: entry.durationMs || 0,
      success,
      errorMessage: entry.errorMessage || '',
      traceId: entry.traceId || '',
      tokenUsage,
      credentials: entry.credentials || 0,
    };

    // 环形缓冲区写入
    this._entries.push(record);
    if (this._entries.length > this._maxEntries) {
      this._entries.shift();
    }

    // 更新统计
    this._updateStats(record, success);

    // 实时事件推送
    this.emit('traffic', record);

    return record;
  }

  // ── 查询接口 ──────────────────────────────────────────────────
  /**
   * 按条件过滤查询流量记录。
   *
   * @param {object} [filters]
   * @param {string} [filters.provider] — 按提供商过滤
   * @param {string} [filters.model] — 按模型过滤
   * @param {string} [filters.sessionId] — 按会话过滤
   * @param {boolean} [filters.errorsOnly] — 只看错误
   * @param {number} [filters.since] — 起始时间戳
   * @param {number} [filters.until] — 结束时间戳
   * @param {string} [filters.searchUrl] — URL 模糊搜索
   * @param {number} [filters.limit=100] — 返回条数上限
   * @returns {object[]} 匹配的记录数组
   */
  query(filters = {}) {
    let results = this._entries;

    if (filters.provider) {
      const p = String(filters.provider).toLowerCase();
      results = results.filter((e) => e.provider.toLowerCase() === p);
    }
    if (filters.model) {
      const m = String(filters.model).toLowerCase();
      results = results.filter((e) => e.model.toLowerCase().includes(m));
    }
    if (filters.sessionId) {
      results = results.filter((e) => e.sessionId === filters.sessionId);
    }
    if (filters.errorsOnly) {
      results = results.filter((e) => !e.success);
    }
    if (filters.since) {
      results = results.filter((e) => e.timestamp >= filters.since);
    }
    if (filters.until) {
      results = results.filter((e) => e.timestamp <= filters.until);
    }
    if (filters.searchUrl) {
      const q = String(filters.searchUrl).toLowerCase();
      results = results.filter((e) => e.url.toLowerCase().includes(q));
    }

    // 默认倒序（最新在前）
    const limit = filters.limit || 100;
    return results.reverse().slice(0, limit);
  }

  // ── 获取统计摘要 ──────────────────────────────────────────────
  getStats() {
    const now = Date.now();
    const providers = {};
    for (const [key, stats] of this._providerStats) {
      providers[key] = {
        ...stats,
        avgDurationMs: stats.requests > 0 ? Math.round(stats.durationMs / stats.requests) : 0,
      };
    }
    return {
      ...this._stats,
      uptimeMs: now - this._stats.startTime,
      bufferedEntries: this._entries.length,
      maxEntries: this._maxEntries,
      avgDurationMs:
        this._stats.totalRequests > 0
          ? Math.round(this._stats.totalDurationMs / this._stats.totalRequests)
          : 0,
      providers,
    };
  }

  // ── 获取 provider 列表 ────────────────────────────────────────
  getProviders() {
    return [...this._providerStats.keys()];
  }

  // ── 获取 session 列表 ─────────────────────────────────────────
  getSessions() {
    return [...this._sessionStats.keys()];
  }

  // ── 导出 HAR 格式 ─────────────────────────────────────────────
  exportHAR() {
    return {
      log: {
        version: '1.2',
        creator: { name: 'khy-os traffic-logger', version: '1.0.0' },
        entries: this._entries.map((e) => this._toHAREntry(e)),
      },
    };
  }

  // ── 清空记录 ──────────────────────────────────────────────────
  clear() {
    this._entries = [];
    this._stats = {
      totalRequests: 0,
      totalErrors: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalDurationMs: 0,
      startTime: Date.now(),
    };
    this._providerStats.clear();
    this._sessionStats.clear();
    this.emit('clear');
  }

  // ── 启用/禁用 ─────────────────────────────────────────────────
  setEnabled(enabled) {
    this._enabled = !!enabled;
    this.emit('enabled', this._enabled);
  }

  isEnabled() {
    return this._enabled;
  }

  // ── Watch 模式（用户主动触发全量记录）─────────────────────────
  setWatchMode(enabled) {
    this._watchMode = !!enabled;
    this.emit('watchMode', this._watchMode);
  }

  isWatchMode() {
    return this._watchMode;
  }

  // ── 内部：更新统计 ────────────────────────────────────────────
  _updateStats(record, success) {
    this._stats.totalRequests++;
    this._stats.totalDurationMs += record.durationMs;
    this._stats.totalInputTokens += record.tokenUsage.inputTokens;
    this._stats.totalOutputTokens += record.tokenUsage.outputTokens;
    if (!success) {
      this._stats.totalErrors++;
    }

    // Provider 维度
    if (!this._providerStats.has(record.provider)) {
      this._providerStats.set(record.provider, {
        requests: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      });
    }
    const ps = this._providerStats.get(record.provider);
    ps.requests++;
    ps.durationMs += record.durationMs;
    ps.inputTokens += record.tokenUsage.inputTokens;
    ps.outputTokens += record.tokenUsage.outputTokens;
    if (!success) {
      ps.errors++;
    }

    // Session 维度
    if (!this._sessionStats.has(record.sessionId)) {
      this._sessionStats.set(record.sessionId, {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      });
    }
    const ss = this._sessionStats.get(record.sessionId);
    ss.requests++;
    ss.durationMs += record.durationMs;
    ss.inputTokens += record.tokenUsage.inputTokens;
    ss.outputTokens += record.tokenUsage.outputTokens;
  }

  // ── 内部：转 HAR Entry ────────────────────────────────────────
  _toHAREntry(entry) {
    return {
      startedDateTime: new Date(entry.timestamp).toISOString(),
      time: entry.durationMs,
      request: {
        method: entry.method,
        url: entry.url,
        headers: Object.entries(entry.requestHeaders || {}).map(([name, value]) => ({
          name,
          value: String(value),
        })),
        postData: entry.requestBody
          ? { mimeType: 'application/json', text: entry.requestBody }
          : undefined,
      },
      response: {
        status: entry.statusCode,
        headers: Object.entries(entry.responseHeaders || {}).map(([name, value]) => ({
          name,
          value: String(value),
        })),
        content: entry.responseBody
          ? { mimeType: 'application/json', text: entry.responseBody }
          : undefined,
      },
      timings: {
        send: 0,
        wait: entry.durationMs,
        receive: 0,
      },
    };
  }
}

// ── 单例导出 ────────────────────────────────────────────────────
const trafficLogger = new TrafficLogger();

module.exports = {
  TrafficLogger,
  trafficLogger,
  sanitizeHeaders,
  truncateBody,
  extractTokenUsage,
  DEFAULT_MAX_ENTRIES,
};
