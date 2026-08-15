'use strict';

/**
 * responseOptimizers —— 根据模型画像给响应消费端提供轻量、确定性的呈现建议。
 *
 * 这里刻意不重写模型正文:stream/tool_call/content block 的形状都属于 provider 契约,
 * 擅自截断或改写会破坏工具循环。优化结果只是一份 sidecar policy;调用方显式选择
 * applyTextPolicy 时才对纯文本做保守归一。
 */

const styles = require('./styleMatchers');

const DEFAULT_MAX_CHARS = 12000;

function buildResponsePolicy(profile, requestContext = {}) {
  try {
    const p = styles.isPlainObject(profile) ? profile : {};
    const sp = styles.normalizeStyleProfile(p.style_profile, null);
    const taskType = String(requestContext.taskType || '').trim().toLowerCase();
    const userPreference = styles.pickEnum(
      requestContext.userPreference,
      styles.PROMPT_PREFERENCES,
      ''
    );
    const responseStyle = styles.pickEnum(
      requestContext.responseStyle,
      styles.RESPONSE_STYLES,
      sp.response_style
    );
    const concise = userPreference === 'concise' || responseStyle === 'direct';
    const explainer = responseStyle === 'explainer';

    return {
      responseStyle,
      concise,
      explainer,
      conclusionFirst: concise || taskType === 'code' || taskType === 'debug',
      includeRationale: !concise,
      includeExamples: explainer || taskType === 'translation',
      preserveToolCalls: true,
      maxChars: styles.clampInt(requestContext.maxResponseChars, 256, 1000000, DEFAULT_MAX_CHARS),
    };
  } catch {
    return {
      responseStyle: 'direct',
      concise: false,
      explainer: false,
      conclusionFirst: false,
      includeRationale: true,
      includeExamples: false,
      preserveToolCalls: true,
      maxChars: DEFAULT_MAX_CHARS,
    };
  }
}

function applyTextPolicy(text, policy) {
  try {
    if (typeof text !== 'string') {
      return text;
    }

    const p = styles.isPlainObject(policy) ? policy : {};
    const maxChars = styles.clampInt(p.maxChars, 256, 1000000, DEFAULT_MAX_CHARS);
    const normalized = text.replace(/\r\n/g, '\n').trim();

    if (normalized.length <= maxChars) {
      return normalized;
    }

    return `${normalized.slice(0, maxChars).trimEnd()}\n\n[response truncated]`;
  } catch {
    return text;
  }
}

function optimizeResponse(response, profile, requestContext = {}, opts = {}) {
  try {
    const policy = buildResponsePolicy(profile, requestContext);

    if (!styles.isPlainObject(response)) {
      return { response, policy, optimized: false };
    }

    if (!opts.applyText) {
      return { response, policy, optimized: false };
    }

    const key = typeof response.content === 'string'
      ? 'content'
      : typeof response.text === 'string'
        ? 'text'
        : '';

    if (!key) {
      return { response, policy, optimized: false };
    }

    const next = Object.assign({}, response, { [key]: applyTextPolicy(response[key], policy) });

    return { response: next, policy, optimized: next[key] !== response[key] };
  } catch {
    return { response, policy: buildResponsePolicy({}, {}), optimized: false };
  }
}

module.exports = {
  DEFAULT_MAX_CHARS,
  applyTextPolicy,
  buildResponsePolicy,
  optimizeResponse,
};
