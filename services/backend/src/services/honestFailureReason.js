'use strict';

/**
 * honestFailureReason.js — 纯叶子：诚实失败原因(零 IO / 确定性 / 绝不抛 / 门控默认开)。
 *
 * 背景(用户原话):「ai 不要出现空回复,出错原因要具体真实,不要用网络不好之类的
 * 理由掩盖真相」。toolUseLoop 的错误返回路径有两处把**真实原因**丢弃换成笼统借口:
 *   ① errorMessages.network = '抱歉，网络连接出现问题…' —— 即使 aiResult.error /
 *      aiResult.failureDetails 里带着真因(ECONNREFUSED 代理拒连 / DNS 失败 / HTTP 502),
 *      也被这句固定话术覆盖,真相被掩盖。
 *   ② 任务未完成占位符里 `String(t.error || t.output || '未知错误')` —— 工具失败的真因
 *      多在 `t.result.data.outputTail`(如 build_project exitCode:1 errors:[] 时 stderr 在
 *      outputTail),却塌缩成「未知错误」。
 *
 * 本叶子是「把真实失败原因提炼成具体、可读、不泄密的一行」的单一真源:
 *   - resolveFriendlyFailureMessage:有真因 → 以真因为主体(类别前缀 + 具体原因);
 *     无真因 → 回退到调用方既有的友好话术(诚实承认未知,不编造)。
 *   - extractToolFailureReason:从 toolCallLog 条目里逐层挖出最具体的真因,
 *     绝不轻易落到「未知错误」。
 *   - sanitizeCause:剥离 token / 凭证 / URL 里的密钥,但**保留**错误类/错误码/主机——
 *     诚实(给真因)与安全(不泄密)兼得。
 *
 * 门控 KHY_HONEST_FAILURE(默认开;取 0/false/off/no 关闭 → 逐字节回退到调用方旧行为)。
 * env 经 opts.env 注入可测。纯叶子:零外部 IO、无副作用、绝不抛。
 */

function _enabled(env) {
  const v = String((env && env.KHY_HONEST_FAILURE) || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

// 错误类别 → 中文前缀(只描述「哪一类」,具体真因仍由 sanitize 后的原文给出)。
const CATEGORY_PREFIX = Object.freeze({
  network: '网络请求未能完成',
  timeout: '请求超时',
  rate_limit: '请求被限流',
  auth: '认证失败',
  process: '服务进程异常',
});

// 凭证/密钥的脱敏规则:命中即整体抹成 ***,但不动错误类/错误码/主机名。
const SECRET_PATTERNS = [
  /\bbearer\s+[A-Za-z0-9._\-]+/gi,
  /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi,
  /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{8,}/g,
  // URL 里的 user:pass@host
  /\/\/[^/\s:@]+:[^/\s@]+@/g,
];

/**
 * 把任意失败原因串脱敏 + 归一:剥离密钥、压平空白、限长。保留 ECONNREFUSED /
 * ETIMEDOUT / HTTP 状态码 / host:port 这类「具体且可操作」的真因。
 */
function sanitizeCause(raw, maxLen = 220) {
  let s = raw == null ? '' : String(raw);
  if (!s) return '';
  for (const re of SECRET_PATTERNS) s = s.replace(re, (m) => (m.includes('@') ? '//***@' : '***'));
  // 追加一趟「现代密钥」脱敏(sk-proj-/sk-svcacct-/sk-admin-…),严格超集,只多抹密钥。
  try {
    const r = require('./modernKeyRedaction').redactModernKeys(
      s, (typeof process !== 'undefined' ? process.env : {}));
    if (r != null) s = r;
  } catch { /* fail-soft → legacy s(仅 legacy 脱敏) */ }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}

/**
 * 决定错误返回路径上对用户可见的失败文案。
 *
 * @param {object} a
 * @param {string} a.errorType      归一后的错误类别(network/timeout/…)
 * @param {string} a.cause          真实失败原因原文(如 aiResult.error / failureDetails)
 * @param {string} a.legacyFriendly 调用方既有的友好话术(门控关 / 无真因时回退到它,逐字节)
 * @param {object} [a.options]      { env }
 * @returns {string}
 */
function resolveFriendlyFailureMessage({ errorType, cause, legacyFriendly, options } = {}) {
  const env = (options && options.env) || (typeof process !== 'undefined' ? process.env : {});
  const legacy = legacyFriendly == null ? '' : String(legacyFriendly);
  try {
    if (!_enabled(env)) return legacy;
    const clean = sanitizeCause(cause);
    if (!clean) return legacy; // 无真因 → 诚实回退,绝不编造
    const type = String(errorType || '').trim().toLowerCase();
    const prefix = CATEGORY_PREFIX[type];
    // 真因已包含类别前缀语义(避免「网络请求未能完成。具体原因：网络…」重复)时不再加前缀。
    if (prefix && !clean.includes(prefix)) {
      return `${prefix}。具体原因：${clean}`;
    }
    return `具体原因：${clean}`;
  } catch {
    return legacy;
  }
}

// ── 认证/无 key 失败 → 主动邀请配置 API Key ────────────────────────────────
// 用户诉求(截图):识图/任何模型因缺密钥(401 认证失败)而失败时,不能只甩底层
// 报错——应**主动询问**「要不要帮你配置该模型的 API Key,配好即可继续使用」。真正写入
// 走用户粘 key → 模型调既有 configureModelProvider 工具的闭环(本叶子只产邀请文案)。
// 门控 KHY_FAILURE_KEY_INVITE(默认开;flagRegistry 优先,注册表不可用 → 本地 CANON 回退)。

const _INVITE_FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控 KHY_FAILURE_KEY_INVITE 是否启用。flagRegistry 优先,失败 → 本地 CANON 回退。绝不抛。 */
function _keyInviteEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {});
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_FAILURE_KEY_INVITE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e && e.KHY_FAILURE_KEY_INVITE;
  return !(v !== undefined && v !== null && _INVITE_FALSY.has(String(v).trim().toLowerCase()));
}

// 需要「配置 key」邀约的类别:密钥问题,配好/换新即可继续。分两档,措辞不同:
//   - 换 key 档(密钥失效/额度用尽):已配过 key 但认证被拒(auth)、判定为永久性密钥失效
//     (auth_permanent),或该 provider 的可用密钥池已耗尽(pool_exhausted)——引导「换一个新 key」。
//   - 配置档(完全没配):no_key——引导「配置 API Key」。
// 刻意不含 rate_limit(429):它双用途(瞬时限流会自愈 / 额度真用尽),报错瞬间无法可靠区分,
//   纳入会在临时限流时误弹「你的 key 失效了」;与 network/timeout 同属「瞬时故障不主动问 key」。
const _KEY_INVALID_CATEGORIES = new Set(['auth', 'auth_permanent', 'pool_exhausted']);
const _NO_KEY_CATEGORIES = new Set(['no_key']);
const _INVITE_CATEGORIES = new Set([..._KEY_INVALID_CATEGORIES, ..._NO_KEY_CATEGORIES]);

// 从脱敏后的真因里认出 provider(尽量点名,让用户知道给哪家配 key)。顺序敏感:
// 更具体的中文/别名在前。命中 → 返回展示名;都不命中 → null(用泛化措辞)。
const _PROVIDER_HINTS = [
  { re: /(智谱|zhipu|bigmodel|glm)/i, name: '智谱 GLM' },
  { re: /(agnes|agnes-ai)/i, name: 'Agnes' },
  { re: /(deepseek)/i, name: 'DeepSeek' },
  { re: /(moonshot|kimi)/i, name: 'Moonshot Kimi' },
  { re: /(qwen|dashscope|通义|阿里云百炼)/i, name: '通义千问' },
  { re: /(openai|gpt-)/i, name: 'OpenAI' },
  { re: /(anthropic|claude)/i, name: 'Anthropic Claude' },
  { re: /(sensenova|商汤)/i, name: 'SenseNova' },
];

/** 从真因文本认出 provider 展示名;认不出 → null。绝不抛。 */
function _detectProvider(cause) {
  try {
    const s = cause == null ? '' : String(cause);
    if (!s) return null;
    for (const h of _PROVIDER_HINTS) if (h.re.test(s)) return h.name;
    return null;
  } catch {
    return null;
  }
}

/**
 * 为密钥类失败构建一句「要不要帮你换/配 API Key」的主动邀请。分两档措辞:
 *   - 密钥失效/额度用尽(auth/auth_permanent/pool_exhausted)→「失效或额度用尽…帮你换一个新 key」。
 *   - 完全没配(no_key)→「帮你配置 API Key」。
 * 认出 provider 时点名(如智谱 GLM);认不出用泛化措辞。真正写入走用户粘 key → 模型调
 * configureModelProvider 的既有闭环——本函数只产邀请文案。刻意不含 rate_limit(429,双用途难区分)
 * 与 network/timeout(瞬时故障)。
 *
 * @param {object} a
 * @param {string} a.errorType   归一后的错误类别(auth/auth_permanent/pool_exhausted/no_key/…)
 * @param {*} [a.cause]          真实失败原因原文(用于认 provider)
 * @param {object} [a.env]       注入 env(可测)
 * @returns {string}             邀请文案;门控关 / 非密钥类 / 异常 → ''(调用方不追加)
 */
function buildKeyConfigInvite({ errorType, cause, env } = {}) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!_keyInviteEnabled(e)) return '';
    const type = String(errorType || '').trim().toLowerCase();
    if (!_INVITE_CATEGORIES.has(type)) return '';
    const provider = _detectProvider(cause);
    const who = provider ? `${provider} 的 ` : '该模型的 ';
    // 换 key 档:已配过但密钥失效 / 额度用尽 → 引导换新 key。
    if (_KEY_INVALID_CATEGORIES.has(type)) {
      return `检测到 ${who}API Key 失效或额度用尽。需要我帮你换一个新 key 吗?`
        + `把 key 发我即可,我就地帮你更新。`;
    }
    // 配置档:完全没配 → 引导配置。
    return `需要我帮你配置 ${who}API Key 吗?配好后即可继续使用(把 key 发我即可,我会帮你写入)。`;
  } catch {
    return '';
  }
}

/**
 * 从一个 toolCallLog 失败条目里挖出最具体的真因。条目形状:
 *   { tool, name, params, result, error, output, ... }
 * 真因优先级:显式 error > result.error(.message) > result.data.outputTail
 *   > result.data.nextAction > result.output/content > 退出码兜底。
 *
 * @param {object} entry
 * @param {object} [options] { env }
 * @returns {string} 脱敏后的真因;门控关或无任何信号时返回 ''(调用方决定兜底文案)。
 */
function extractToolFailureReason(entry, options = {}) {
  const env = (options && options.env) || (typeof process !== 'undefined' ? process.env : {});
  try {
    if (!_enabled(env)) return '';
    if (!entry || typeof entry !== 'object') return '';
    const r = (entry.result && typeof entry.result === 'object') ? entry.result : {};
    const d = (r.data && typeof r.data === 'object') ? r.data : {};
    const errObj = r.error || entry.error;
    const candidates = [
      entry.error,
      errObj && typeof errObj === 'object' ? (errObj.message || errObj.reason) : errObj,
      d.outputTail,
      d.nextAction,
      r.reason,
      r.message,
      entry.output,
      typeof r.output === 'string' ? r.output : null,
      typeof r.content === 'string' ? r.content : null,
    ];
    for (const c of candidates) {
      const clean = sanitizeCause(c, 200);
      if (clean) {
        const exit = typeof d.exitCode === 'number' ? d.exitCode
          : (typeof r.exitCode === 'number' ? r.exitCode : null);
        const exitTag = (exit !== null && exit !== 0) ? `[退出码 ${exit}] ` : '';
        return `${exitTag}${clean}`;
      }
    }
    // 没有任何文字真因,但有非零退出码 → 仍比「未知错误」具体。
    const exit = typeof d.exitCode === 'number' ? d.exitCode
      : (typeof r.exitCode === 'number' ? r.exitCode : null);
    if (exit !== null && exit !== 0) return `命令以退出码 ${exit} 失败(无输出)`;
    return '';
  } catch {
    return '';
  }
}

module.exports = {
  resolveFriendlyFailureMessage,
  extractToolFailureReason,
  buildKeyConfigInvite,
  sanitizeCause,
  isHonestFailureEnabled: (env) => _enabled(env || (typeof process !== 'undefined' ? process.env : {})),
  CATEGORY_PREFIX,
};
