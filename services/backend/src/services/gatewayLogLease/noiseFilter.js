'use strict';

/**
 * gatewayLogLease/noiseFilter.js — 净味翻译层（NoiseFilter）。
 *
 * 把适配器底层的"机器味"日志/错误，翻译成对用户无害、无内幕、无适配器名的友好提示；
 * 对纯内部噪音（用户根本不需要知道的）则返回 null，由租界直接吞掉。
 *
 * 两条铁律（防呆）：
 *   ① 绝不把底层原始 Error / 适配器名 / Token / URL / 栈，原样透给用户 —— translate() 的
 *      产物只可能是预置的友好话术或经 sanitize() 脱敏后的兜底句。
 *   ② translate() 返回 null ⇒ 该条纯属内部噪音，调用方必须丢弃（不得"找不到规则就放行原文"）。
 *
 * 规则有序匹配：第一条命中即返回。`user:null` 表示命中即判为纯噪音吞掉；
 * `user:'…'` 表示翻译成该友好句。
 */

// 适配器名/内部标识词表（用于脱敏时整体抹除，避免内幕名泄漏）。
const ADAPTER_TOKENS = [
  'kiroadapter', 'kiro', 'claudeadapter', 'claude', 'codexadapter', 'codex',
  'traeadapter', 'trae', 'cursoradapter', 'cursor2api', 'cursor', 'windsurfadapter', 'windsurf',
  'vscodeadapter', 'vscode', 'warpadapter', 'warp', 'localllmadapter', 'localllm',
  'ollamaadapter', 'ollama', 'relayapiadapter', 'relay_api', 'relay', 'apiadapter',
  'webrelayadapter', 'clipboardrelayadapter',
];

// 有序翻译规则。pattern 命中（不区分大小写）即采用该条。
const RULES = [
  // —— Token / 凭证 / 登录 ——
  { pattern: /token\s*refresh\s*(failed|error)|refresh\s*token|falling back|using existing token|alternate token source/i, user: '模型服务正在切换…' },
  { pattern: /login required|not\s*logged\s*in|unauthor|credential|凭证|登录/i, user: '模型服务正在切换…' },
  // —— 依赖缺失 / 降级到轻量 ——
  { pattern: /requires?\s+puppeteer|puppeteer|playwright|chromium\b/i, user: '正在降级到轻量模式…' },
  { pattern: /本地依赖不完整|not installed|install with|缺少依赖|missing dependency|依赖.*不完整/i, user: '正在尝试其他方式获取…' },
  // —— HTTP / API 错误（净味，不暴露状态码细节）——
  { pattern: /\b4\d\d\b|invalid request|bad request|api error|响应异常|无效请求/i, user: '当前模型响应异常，正在自动修复…' },
  { pattern: /\b5\d\d\b|server error|bad gateway|service unavailable|upstream/i, user: '模型服务暂时不稳定，正在重试…' },
  // —— 限频 / 配额 ——
  { pattern: /rate\s*limit|too many requests|quota|限频|配额|429/i, user: '请求较多，正在排队重试…' },
  // —— 超时 / 网络 ——
  { pattern: /timed?\s*out|etimedout|esockettimedout|超时/i, user: '模型请求超时，正在重试…' },
  { pattern: /econnrefused|enotfound|eai_again|network|fetch failed|dns|网络/i, user: '网络波动，正在重连…' },
  // —— 通道切换 / 降级 / 冷却 ——
  { pattern: /falling back|fallback|switch|降级|切换|cooldown|冷却|封禁|banned/i, user: '模型服务正在切换…' },
  // —— 重试（通用）——
  { pattern: /retry|retrying|重试|attempt\s*\d+/i, user: '模型请求异常，正在重试…' },

  // —— 纯内部噪音：命中即吞（用户无需感知）——
  { pattern: /\[\w+:debug\]|^\s*debug\b|probe|health\s*check|探活|心跳|heartbeat|warming up|预热/i, user: null },
];

/** 脱敏：抹除适配器内部名、Bearer/Token、URL、文件路径，并压平空白。 */
function sanitize(text) {
  let s = String(text == null ? '' : text);
  // 去 Bearer / token 串。
  s = s.replace(/bearer\s+[a-z0-9._-]+/gi, '[token]')
       .replace(/\b(?:sk|ey|gho|ghp|xox[abp])[-_][a-z0-9._-]{6,}/gi, '[token]')
       .replace(/[a-f0-9]{32,}/gi, '[hash]');
  // 去 URL。
  s = s.replace(/https?:\/\/[^\s)]+/gi, '[url]');
  // 去 unix/win 路径。
  s = s.replace(/(?:\/[\w.-]+){2,}/g, '[path]').replace(/[a-z]:\\[^\s]+/gi, '[path]');
  // 去 [xxxAdapter] 前缀与内部适配器名。
  s = s.replace(/\[[^\]]*adapter[^\]]*\]/gi, '');
  for (const tok of ADAPTER_TOKENS) {
    s = s.replace(new RegExp(`\\[?${tok}\\]?`, 'gi'), '');
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 翻译一条底层日志/错误为用户友好提示。
 * @param {*} raw  原始文本 / Error / {message}
 * @returns {string|null}  友好句；返回 null 表示纯内部噪音应被吞掉。
 */
function translate(raw) {
  const text = _toText(raw);
  if (!text) return null;
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.user; // 可能是友好句，也可能是 null（吞掉）
  }
  // 未命中任何规则：不暴露原文，给一个脱敏后的通用兜底（绝不返回机器味原文）。
  const clean = sanitize(text);
  if (!clean) return null;
  return '模型服务处理中…';
}

/**
 * 给"查网关状态"等全量可见场景用的脱敏摘要：保留可读错误信息，但抹除 Token/URL/路径，
 * 适配器名是否保留由调用方决定（状态查询里适配器名是合法信息，故此函数不抹名）。
 */
function sanitizeForStatus(raw, maxLen = 220) {
  let s = String(_toText(raw) || '');
  s = s.replace(/bearer\s+[a-z0-9._-]+/gi, '[token]')
       .replace(/[a-f0-9]{32,}/gi, '[hash]')
       .replace(/https?:\/\/[^\s)]+/gi, '[url]')
       .replace(/\s+/g, ' ')
       .trim();
  if (!s) return 'unknown error';
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function _toText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message || String(raw);
  if (typeof raw === 'object') {
    if (typeof raw.message === 'string') return raw.message;
    if (typeof raw.text === 'string') return raw.text;
    if (typeof raw.error === 'string') return raw.error;
    if (raw.error && typeof raw.error === 'object' && raw.error.message) return raw.error.message;
  }
  try { return String(raw); } catch { return ''; }
}

module.exports = {
  translate,
  sanitize,
  sanitizeForStatus,
  RULES,
  ADAPTER_TOKENS,
};
