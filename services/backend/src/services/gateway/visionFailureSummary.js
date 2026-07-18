'use strict';

/**
 * visionFailureSummary.js — 纯叶子:零 IO / 确定性 / 绝不抛 / 门控默认开。
 *
 * 背景(用户原话):识图工具失败时不能只甩「智谱失败」的原始报错(如
 * `智谱AI: Request failed with status code 401`)——那既把锅只扣在一个 provider 上,
 * 又对用户毫无出路。用户诉求:失败时由文本模型给一个**总结**,并**询问是否需要帮忙
 * 配置 GLM 或其他合适的图像识别模型的 apikey**。
 *
 * 本叶子是「把一次图像识别失败提炼成:诚实总结 + 是否配置视觉模型 key 的邀约」的单一真源:
 *   - classifyVisionFailure(rawError) → 归类(auth / no_key / rate_limit / timeout /
 *     network / unknown)。归类只读文本特征,绝不抛。
 *   - buildVisionFailureMessage({ rawError, model, env }) → 面向用户的一段话:
 *       ① 诚实点出「这次图像识别没能完成」(不把失败窄化成单一 provider 的错);
 *       ② 脱敏后的真实原因(保留 HTTP 状态码 / 错误类,剥离密钥);
 *       ③ 针对类别的**配置邀约**:auth/no_key → 主动问「要不要我帮你配置 GLM 或其他
 *          合适的图像识别模型的 API Key?」;其余类别 → 给出「换模型 / 稍后重试 / 配置 key」
 *          的下一步询问。
 *
 * 门控 KHY_VISION_FAILURE_SUMMARY(默认开;flagRegistry 优先,注册表不可用 → 本地 CANON
 * 4 词回退)。取 0/false/off/no 关闭 → 调用方逐字节回退到旧文案 `图像识别失败: <raw>`。
 *
 * 绝不硬编码密钥;脱敏保留可操作真因(状态码/错误类/主机),剥离 bearer/token/api_key。
 * env 经 opts.env 注入可测。纯叶子:无外部 IO、无副作用、异常一律回退安全值。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控 KHY_VISION_FAILURE_SUMMARY 是否启用。flagRegistry 优先,失败 → 本地 CANON 回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isVisionFailureSummaryEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_VISION_FAILURE_SUMMARY', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_VISION_FAILURE_SUMMARY;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 子门 KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS(OPS-MAN-142,承 OPS-138/140)是否启用。
 *
 * 背景(2026-07-12 用户实测,paste-cache 92c0154d,直服「减少心灵噪音」):失败墙
 * buildVisionFailureMessage(含「图像识别失败…粘贴 GLM API Key」)在视觉级联全失败时于**OCR 兜底之前**
 * 无条件发射(aiGatewayGenerateMethod.js:~1590)。当图是**含字图**、随后本地 OCR **成功读出文字**时,那块
 * 吓人失败墙**已经甩给用户**——与紧接着的「已用 OCR 成功识别」自相矛盾,是日志里最响的噪音。本子门开(默认)→
 * 调用方把失败墙**推迟**到 OCR 结果已知之后:OCR 成功 → 抑制墙(已被救回,墙纯误导);OCR 读空/失败 →
 * 照发(真需用户介入)。门关 → 逐字节回退到「OCR 前无条件发墙」的历史行为。
 *
 * 与父门 KHY_VISION_FAILURE_SUMMARY 正交:父门决定「是否有失败墙」,本子门决定「OCR 成功时是否抑制它」。
 * flagRegistry 优先,失败 → 本地 CANON 回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isFailureSummaryOcrSuppressEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 失败墙「真实失败原因」标签去重子门(OPS-MAN-161,承 OPS-159,default-on)。
 * 断桥:describe 子调用失败时 gateway 回传的真因串已自带 `真实失败原因:` 标签,失败墙历史上再前置
 * 一次 → `真实失败原因:真实失败原因:` stutter。门开 → 剥掉 cause 自带标签只保留一次;门关 → 逐字节
 * 回退到重复行为。与 KHY_VISION_FAILURE_SUMMARY(是否有墙)/KHY_VISION_MODEL_DISPLAY_NAME(模型名去
 * 前缀)正交。flagRegistry 优先,失败 → 本地 CANON 回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isFailureCauseDedupEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_VISION_FAILURE_CAUSE_DEDUP', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_VISION_FAILURE_CAUSE_DEDUP;
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
  // 追加一趟「现代密钥」脱敏(sk-proj-/sk-svcacct-/sk-admin-…),复用 honestFailureReason 同款叶子,
  // 门控 KHY_MODERN_KEY_REDACTION;严格超集,只多抹密钥。gateway/ 子目录 → require 上一层。
  try {
    const r = require('../modernKeyRedaction').redactModernKeys(
      s, (typeof process !== 'undefined' ? process.env : {}));
    if (r != null) s = r;
  } catch { /* fail-soft → legacy s(仅 legacy 脱敏) */ }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}

// 归类信号(顺序敏感:auth/no_key 先于更泛的 network,401/403 命中即认证)。
const _NO_KEY_RE = /(no\s+api\s*key|api\s*key\s+(not\s+)?(configured|missing|found|set)|缺少\s*(api\s*)?key|未配置.*key|no\s+available\s+key|无可用(密钥|api\s*key)|key\s+pool\s+empty|没有可用的?\s*(密钥|key))/i;
// 智谱 GLM 结构化鉴权错误码(单一真源见 callZhipu 抛出的 `智谱AI: … code <n> …`):
// 1000 缺鉴权头、1001/1002 token 无效/鉴权失败、1003/1004 鉴权校验失败——这些都是「key 不对」,
// 应归 auth(邀约粘贴真 key),而非被下方 `\b404\b` 误判成 model_not_found(智谱对无效 key 亦回 404)。
const _GLM_AUTH_CODE_RE = /\bcode\s+100[0-4]\b/i;
const _AUTH_RE = /(\b401\b|\b403\b|unauthorized|forbidden|invalid\s+api\s*key|invalid\s+token|authentication\s+failed|auth(entication)?\s+error|认证失败|鉴权失败|api\s*key.*(invalid|expired|错误|无效|过期)|\[auth\])/i;
// 模型不存在 / 端点不匹配:404 model_not_found 是「当前 provider 没有这个视觉模型」的典型信号
// (如识图裸模型名落到自定义 api 池,那里没有 glm-4.6v-flash)。放在 auth 之后、更泛的 network 之前,
// 且 _NETWORK_RE 只认 50[234] 不吞 404,故不与网络类冲突。
const _MODEL_NOT_FOUND_RE = /(model_not_found|no\s+such\s+model|\b404\b|\bmodel\b[^.\n]{0,40}\bnot\s*(found|exist)|模型.*不存在|不存在.*模型|未找到.*模型|该模型不存在)/i;
const _RATE_RE = /(\b429\b|rate\s*limit|too\s+many\s+requests|quota|限流|配额|频率)/i;
const _TIMEOUT_RE = /(timeout|timed\s*out|ETIMEDOUT|ESOCKETTIMEDOUT|超时)/i;
const _NETWORK_RE = /(ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket\s+hang\s*up|network\s+error|dns|proxy|代理|连接被拒|无法连接|\b50[234]\b|bad\s+gateway|service\s+unavailable)/i;

/**
 * 归类一次图像识别失败。仅读文本特征,绝不抛。
 * @param {*} rawError
 * @returns {'auth'|'no_key'|'model_not_found'|'rate_limit'|'timeout'|'network'|'unknown'}
 */
function classifyVisionFailure(rawError) {
  try {
    const s = rawError == null ? '' : String(rawError);
    if (!s) return 'unknown';
    if (_NO_KEY_RE.test(s)) return 'no_key';
    // 智谱结构化鉴权码(1000–1004)先于泛 404 判定:GLM 对无效 key 也回 404,若不先认这批码,
    // 无效 key 会被误判成 model_not_found,把用户引向「模型未开通」而非「换 key」的正确出路。
    if (_GLM_AUTH_CODE_RE.test(s) || _AUTH_RE.test(s)) return 'auth';
    if (_MODEL_NOT_FOUND_RE.test(s)) return 'model_not_found';
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
  auth: '图像识别模型的 API Key 认证未通过(密钥无效、过期或未授权)',
  no_key: '当前没有可用的图像识别模型 API Key',
  model_not_found: '目标视觉模型返回「未找到 / 404」(model_not_found)',
  rate_limit: '图像识别请求被限流(触发频率或配额上限)',
  timeout: '图像识别请求超时',
  network: '无法连接到图像识别模型服务(网络/代理/端点问题)',
  unknown: '图像识别这一步没能完成',
});

// 需要「配置 key」邀约的类别(auth/no_key):密钥问题,配好即可继续。
const _NEEDS_KEY_OFFER = new Set(['auth', 'no_key']);

/**
 * 构建面向用户的失败总结 + 配置邀约。绝不抛;门控关或异常 → 返回 null(调用方回退旧文案)。
 *
 * @param {object} a
 * @param {*} a.rawError            识图底层真实报错(gateway.generate 的 error/content)
 * @param {string} [a.model]        本次尝试的视觉模型 id(如 glm-4.6v-flash)
 * @param {object} [a.env]          注入 env(可测)
 * @returns {string|null}
 */
function buildVisionFailureMessage({ rawError, model, env } = {}) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!isVisionFailureSummaryEnabled(e)) return null;

    const category = classifyVisionFailure(rawError);
    const headline = _CATEGORY_HEADLINE[category] || _CATEGORY_HEADLINE.unknown;
    const cause = sanitizeCause(rawError);
    const modelId = String(model || '').trim();

    const lines = [];
    // ① 诚实总结:先说清「图像识别没成」,再点出定性原因;不只怪某一个 provider。
    lines.push(`图像识别失败:${headline}。`);
    if (modelId) {
      // OPS-MAN-159(承 OPS-150):失败墙的「本次尝试的视觉模型」也去 provider 路由前缀,与级联
      // 中间提示对齐。根因同 OPS-150:调用方传入的 _primaryModel = decision.model 保留 `glm/` 前缀
      // 供内部 poolHint 路由,只在**显示边界**归一。复用 OPS-150 纯叶 + 门 KHY_VISION_MODEL_DISPLAY_NAME
      // (default-on);门关 / 叶不可用 → 返原样带前缀 → 逐字节回退 `本次尝试的视觉模型:<raw>。`。
      let _dispModel = modelId;
      try { _dispModel = require('./visionModelDisplayName').toDisplayModelName(modelId, e); }
      catch { /* 叶不可用 → 原样,逐字节回退 */ }
      lines.push(`本次尝试的视觉模型:${_dispModel || modelId}。`);
    }
    if (cause) {
      // OPS-MAN-161(承 OPS-159):cause 可能已自带「真实失败原因:」标签——describe 子调用失败时
      // gateway 用 aiGateway._buildFailureReasonSection 前置 `真实失败原因:\n…`,该串成为 _lastRawError
      // → sanitizeCause 保留标签 → 此处再前置一次 = `真实失败原因:真实失败原因:` stutter 噪音(与
      // aiGateway._prependFailureReason 已有的 `if(/真实失败原因/.test(body)) return body` 去重意图一致,
      // 唯此处历史上漏了同款守卫)。门 KHY_VISION_FAILURE_CAUSE_DEDUP default-on → 若 cause 已以标签开头
      // 则剥掉自带标签只保留一次;门关 / 异常 → 逐字节回退到历史重复行为。
      let _cause = cause;
      try {
        if (isFailureCauseDedupEnabled(e)) _cause = _cause.replace(/^\s*真实失败原因\s*[:：]/, '').replace(/^\s+/, '');
      } catch { /* fail-soft → 原样,逐字节回退 */ }
      lines.push(`真实失败原因:${_cause}`);
    }

    // ② 针对类别的下一步询问 / 配置邀约。
    // auth/no_key/model_not_found 三类的共同真因是「key 不对或缺失」——邀约用户**直接粘贴真 key**,
    // khy 侧的 NL key 检测会即时把它写进对应池(真 key priority 10 恒盖过内置占位 key)并重试识图。
    const PASTE_TO_REPLACE = '你也可以直接把真实的 GLM(智谱)API Key 粘贴发给我,khy 会立即用它替换当前的 key 并重新识别这张图片。';
    if (_NEEDS_KEY_OFFER.has(category)) {
      lines.push(`需要我帮你配置 GLM(智谱)或其他合适的图像识别模型的 API Key 吗?${PASTE_TO_REPLACE}`);
    } else if (category === 'model_not_found') {
      lines.push('这通常不是模型真的不存在,而多半是两种原因之一:① 当前用的是内置占位 key 或无效的 API Key(GLM 对无效 key 也会回 404 model_not_found);② 或你的账号尚未开通该视觉模型。');
      lines.push(`最直接的修复:${PASTE_TO_REPLACE}需要的话我也可以帮你把识图固定到已开通的 GLM 视觉端点。`);
    } else if (category === 'rate_limit') {
      lines.push('可以稍后重试;若经常触发,需要我帮你配置另一个图像识别模型(GLM 或其他)的 API Key 以分担额度吗?');
    } else if (category === 'timeout' || category === 'network') {
      lines.push('请确认网络/代理可达该模型端点;需要我帮你换用或配置另一个图像识别模型(GLM 或其他)的 API Key 吗?');
    } else {
      lines.push('需要我帮你配置 GLM(智谱)或其他合适的图像识别模型的 API Key,再重试识别吗?');
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

module.exports = {
  isVisionFailureSummaryEnabled,
  isFailureSummaryOcrSuppressEnabled,
  classifyVisionFailure,
  buildVisionFailureMessage,
  sanitizeCause,
  CATEGORY_HEADLINE: _CATEGORY_HEADLINE,
};
