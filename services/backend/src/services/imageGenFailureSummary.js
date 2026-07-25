'use strict';

/**
 * imageGenFailureSummary.js — 纯叶子:零 IO / 确定性 / 绝不抛 / 门控默认开。
 *
 * 背景(用户诉求):生图 key 不可用/缺失时,不能只把底层原始报错(如
 * `HTTP 401 Unauthorized …`)甩回——那既把锅窄化到单一后端,又对用户毫无出路。
 * 用户要的是**降级链的最后一环**:桥接 key 试过、其它已知可生图 key 也都试过仍不行
 * 时,给一个**诚实总结** + **询问是否需要帮忙配置图像生成模型的 API Key**(用户粘 key
 * 后模型走既有 configureModelProvider 工具写入)。
 *
 * 本叶子是「把一次图像生成失败提炼成:诚实总结 + 是否配置生图模型 key 的邀约」的单一真源:
 *   - classifyImageGenFailure(rawError) → 归类(auth / no_key / rate_limit / timeout /
 *     network / unknown)。仅读文本特征,绝不抛。
 *   - buildImageGenFailureMessage({ rawError, backend, model, env }) → 面向用户一段话:
 *       ① 诚实点出「这次图像生成没能完成」(不把失败窄化成单一 provider);
 *       ② 脱敏后的真实原因(保留 HTTP 状态码 / 错误类,剥离密钥);
 *       ③ 针对类别的**配置邀约**:auth/no_key → 主动问「要不要我帮你配置图像生成模型
 *          (Agnes / OpenAI 兼容)的 API Key?」;其余类别 → 相应下一步询问。
 *
 * 门控 KHY_IMAGE_GEN_FAILURE_SUMMARY(默认开;flagRegistry 优先,注册表不可用 → 本地
 * CANON 4 词回退)。取 0/false/off/no 关闭 → 调用方逐字节回退到旧文案。
 *
 * 诚实注:分类正则族与 gateway/visionFailureSummary.js 同族,此处采**平行拷贝**(而非跨
 * 叶子 require),以保零耦合风险——两者各自独立演进,语义刻意保持一致。
 *
 * 绝不硬编码密钥;脱敏保留可操作真因(状态码/错误类/主机),剥离 bearer/token/api_key。
 * env 经 opts.env 注入可测。纯叶子:无外部 IO、无副作用、异常一律回退安全值。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控 KHY_IMAGE_GEN_FAILURE_SUMMARY 是否启用。flagRegistry 优先,失败 → 本地 CANON 回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isImageGenFailureSummaryEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_IMAGE_GEN_FAILURE_SUMMARY', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_IMAGE_GEN_FAILURE_SUMMARY;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// 密钥脱敏:命中即整体抹成 ***,但保留错误类/状态码/主机名等可操作真因。
const _SECRET_PATTERNS = [
  /\bbearer\s+[A-Za-z0-9._\-]+/gi,
  /\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi,
  /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{8,}/g,
  /\/\/[^/\s:@]+:[^/\s@]+@/g,
];

/**
 * 脱敏 + 归一失败原因串:剥离密钥、压平空白、限长。保留 401/超时/ECONNREFUSED 这类真因。
 * @param {*} raw
 * @param {number} [maxLen=200]
 * @returns {string}
 */
function sanitizeCause(raw, maxLen = 200) {
  let s = raw == null ? '' : String(raw);
  if (!s) return '';
  for (const re of _SECRET_PATTERNS) s = s.replace(re, (m) => (m.includes('@') ? '//***@' : '***'));
  // 追加一趟「现代密钥」脱敏(sk-proj-/sk-svcacct-/sk-admin-…),复用 modernKeyRedaction 叶子,
  // 门控 KHY_MODERN_KEY_REDACTION;严格超集,只多抹密钥。同目录 → require 同层。
  try {
    const r = require('./modernKeyRedaction').redactModernKeys(
      s, (typeof process !== 'undefined' ? process.env : {}));
    if (r != null) s = r;
  } catch { /* fail-soft → legacy s(仅 legacy 脱敏) */ }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}

// 归类信号(顺序敏感:auth/no_key 先于更泛的 network,401/403 命中即认证)。
const _NO_KEY_RE = /(no\s+api\s*key|api\s*key\s+(not\s+)?(configured|missing|found|set)|缺少\s*(api\s*)?key|缺少\s*AGNES_API_KEY|未配置.*key|no\s+available\s+key|无可用(密钥|api\s*key)|key\s+pool\s+empty|没有可用的?\s*(密钥|key)|都不可用|NO_USABLE_KEY|NO_BACKEND|未检测到任何图像生成后端)/i;
const _AUTH_RE = /(\b401\b|\b403\b|unauthorized|forbidden|invalid\s+api\s*key|invalid\s+token|authentication\s+failed|auth(entication)?\s+error|认证失败|鉴权失败|api\s*key.*(invalid|expired|错误|无效|过期)|\[auth\])/i;
const _RATE_RE = /(\b429\b|rate\s*limit|too\s+many\s+requests|quota|限流|配额|频率)/i;
const _TIMEOUT_RE = /(timeout|timed\s*out|ETIMEDOUT|ESOCKETTIMEDOUT|超时)/i;
const _NETWORK_RE = /(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket\s+hang\s*up|network\s+error|dns|proxy|代理|连接被拒|无法连接|\b50[234]\b|bad\s+gateway|service\s+unavailable)/i;

/**
 * 归类一次图像生成失败。仅读文本特征,绝不抛。
 * @param {*} rawError
 * @returns {'auth'|'no_key'|'rate_limit'|'timeout'|'network'|'unknown'}
 */
function classifyImageGenFailure(rawError) {
  try {
    const s = rawError == null ? '' : String(rawError);
    if (!s) return 'unknown';
    if (_NO_KEY_RE.test(s)) return 'no_key';
    if (_AUTH_RE.test(s)) return 'auth';
    if (_RATE_RE.test(s)) return 'rate_limit';
    if (_TIMEOUT_RE.test(s)) return 'timeout';
    if (_NETWORK_RE.test(s)) return 'network';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// 类别 → 一句「这次为什么没成」的定性(不把锅窄化到单一 provider)。
const _CATEGORY_HEADLINE = Object.freeze({
  auth: '图像生成模型的 API Key 认证未通过(密钥无效、过期或未授权)',
  no_key: '当前没有可用的图像生成模型 API Key(已配置的 key 都已试过且不可用)',
  rate_limit: '图像生成请求被限流(触发频率或配额上限)',
  timeout: '图像生成请求超时',
  network: '无法连接到图像生成模型服务(网络/代理/端点问题)',
  unknown: '图像生成这一步没能完成',
});

// 需要「配置 key」邀约的类别(auth/no_key):密钥问题,配好即可继续。
const _NEEDS_KEY_OFFER = new Set(['auth', 'no_key']);

/**
 * 构建面向用户的失败总结 + 配置邀约。绝不抛;门控关或异常 → 返回 null(调用方回退旧文案)。
 *
 * @param {object} a
 * @param {*} a.rawError            生图底层真实报错(imageGenService.generate 的 error)
 * @param {string} [a.backend]      本次尝试的后端(agnes / openai / …)
 * @param {string} [a.model]        本次尝试的生图模型 id
 * @param {object} [a.env]          注入 env(可测)
 * @returns {string|null}
 */
function buildImageGenFailureMessage({ rawError, backend, model, env } = {}) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!isImageGenFailureSummaryEnabled(e)) return null;

    const category = classifyImageGenFailure(rawError);
    const headline = _CATEGORY_HEADLINE[category] || _CATEGORY_HEADLINE.unknown;
    const cause = sanitizeCause(rawError);
    const backendId = String(backend || '').trim();
    const modelId = String(model || '').trim();

    const lines = [];
    // ① 诚实总结:先说清「图像生成没成」,再点出定性原因;不只怪某一个 provider。
    lines.push(`图像生成失败:${headline}。`);
    if (backendId || modelId) {
      const parts = [];
      if (backendId) parts.push(`后端 ${backendId}`);
      if (modelId) parts.push(`模型 ${modelId}`);
      lines.push(`本次尝试:${parts.join('·')}。`);
    }
    if (cause) {
      lines.push(`真实失败原因:${cause}`);
    }

    // ② 针对类别的下一步询问 / 配置邀约。
    if (_NEEDS_KEY_OFFER.has(category)) {
      lines.push('需要我帮你配置图像生成模型(Agnes 或 OpenAI 兼容)的 API Key 吗?配好后即可重新生成。');
    } else if (category === 'rate_limit') {
      lines.push('可以稍后重试;若经常触发,需要我帮你配置另一个图像生成模型的 API Key 以分担额度吗?');
    } else if (category === 'timeout' || category === 'network') {
      lines.push('请确认网络/代理可达该模型端点;需要我帮你换用或配置另一个图像生成模型的 API Key 吗?');
    } else {
      lines.push('需要我帮你配置图像生成模型(Agnes 或 OpenAI 兼容)的 API Key,再重试生成吗?');
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

module.exports = {
  isImageGenFailureSummaryEnabled,
  classifyImageGenFailure,
  buildImageGenFailureMessage,
  sanitizeCause,
  CATEGORY_HEADLINE: _CATEGORY_HEADLINE,
};
