'use strict';

/**
 * relayModelGuard — 纯叶子:判定一个 model id 是否能被 `relay_api` 通道(直连 api.trae.ai)服务。
 *
 * 背景(为什么存在):
 *   auto 模式 / 级联失效切换时,一个**只属于其它通道**的 model id 会被原样带给 relay_api。
 *   典型现象(用户实测):选「auto」讲个笑话 → auto 选中 `api`/`agnes`(自定义 provider,
 *   端点 apihub.agnes-ai.com,经代理路由表 PROXY_MODEL_ROUTE_MAP 正确服务 agnes-2.0-flash)
 *   → 该通道降级 → 级联把 `options.model='agnes-2.0-flash'` 带到下一个通道 `relay_api`
 *   → relay_api 打到 https://api.trae.ai/v1/chat/completions,trae 不认识 agnes 模型
 *   → HTTP 404 `model_not_found` → 还被缓存进 cooldown。
 *
 *   `normalizeModelForAdapter` 对 `claude` 通道早有**对称防护**:非 `claude-*` 的 model id
 *   直接丢弃(返回 null)→ 通道用自有默认模型。唯 `relay_api` 缺这一层,外来模型原样透传
 *   → 必然 404。本叶子补上「relay_api 能服务哪些模型家族」的单一真源。
 *
 *   诚实边界:只治 relay_api(用户实测且复现的通道,也是 auto 最常见的末位兜底)。`api` 是
 *   代理通道,honor PROXY_MODEL_ROUTE_MAP 能把自定义 provider 模型(agnes-*)正确转发到其真实
 *   端点,故**绝不**在 api 上丢弃(图示 `api:agnes:agnes-2.0-flash` 显式选中工作正常)。其它
 *   原生通道(codex/windsurf/…)本轮不扩,维持今日行为。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 process.env 做门控;不碰 fs/网络/子进程/时钟/随机)。
 *   - 确定性:同输入恒同输出(纯正则匹配)。
 *   - 绝不抛:任何异常路径都返回安全值(false)。
 *   - env 门控 KHY_RELAY_MODEL_GUARD 默认开;关 = 调用方据 isEnabled() 短路,不丢弃 → 逐字节
 *     回退到「relay_api 原样透传外来 model id」的今日行为。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/**
 * 门控 KHY_RELAY_MODEL_GUARD 是否启用。flagRegistry 优先(集中真源),失败/不可用再退本地
 * CANON 解析。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_RELAY_MODEL_GUARD', env || process.env);
  } catch { /* fall through to local */ }
  try {
    const raw = (env || process.env).KHY_RELAY_MODEL_GUARD;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// relay_api(trae.ai)能服务的模型家族 —— 与 traeAdapter.isLikelyModelId 的识别族对齐(同一
// 「trae 认得的模型」认知,单一真源不漂移):trae 面板列出的主流家族。落在此集合外的 id
// (如自定义 provider 的 agnes-*)视为「relay 无法服务」。
const _RELAY_FAMILY_RE = /(gpt|claude|deepseek|qwen|glm|doubao|llama|mistral|moonshot|yi[-._:]|kimi|minimax|gemini|swe[-._:]|sonnet|haiku|opus|cascade|grok|\bo1\b|\bo3\b|\bo4\b)/i;

/**
 * 判定 model 是否属于 relay_api 可服务的模型家族。非字符串 / 空 / 不匹配任何家族 → false。
 * 绝不抛。
 * @param {*} model
 * @returns {boolean}
 */
function isRelayServableModel(model) {
  try {
    if (typeof model !== 'string') return false;
    const m = model.trim().toLowerCase();
    if (!m) return false;
    return _RELAY_FAMILY_RE.test(m);
  } catch {
    return false;
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeRelayModelGuard() {
  return {
    gate: 'KHY_RELAY_MODEL_GUARD',
    defaultOn: true,
    summary: 'relay_api(直连 trae.ai)通道的模型防护:级联/auto 误带的外来自定义 provider 模型'
      + '(如 agnes-*,归 api 代理路由)不属 relay 可服务家族时,由 normalizeModelForAdapter '
      + '丢弃为 null → relay 用自有默认模型,避免必然的 404 model_not_found + cooldown。'
      + '对称于 claude 通道既有防护;不影响 api 代理通道。门控关则原样透传(今日行为)。',
  };
}

module.exports = {
  isEnabled,
  isRelayServableModel,
  describeRelayModelGuard,
};
