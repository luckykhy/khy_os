'use strict';

/**
 * cascadeModelScope — 纯叶子:判定级联回落时,是否该把「首选模型名」带给这个候选通道。
 *
 * 背景(为什么存在):
 *   `GATEWAY_PREFERRED_MODEL` 是**全局**设置,但模型名是**按适配器**的。
 *   用户实测:GATEWAY_PREFERRED_ADAPTER=codex + GATEWAY_PREFERRED_MODEL=gpt-5.3-codex-review
 *   (codex CLI 的模型名),而机器上没装 codex → 级联回落到 relay_api(端点被用户指向
 *   api.stepfun.com)→ 该模型名被原样带过去 → HTTP 404 model_invalid → 再重试一次才用
 *   端点默认模型答出话。**每一轮对话都白付一个必然失败的往返。**
 *
 *   这不是 relay 独有:任何「首选通道不可用 → 回落到别的通道」的组合都会把只属于前者的
 *   模型名递给后者。normalizeModelForAdapter 里 claude / relay_api 各有一层家族防护,但那是
 *   逐通道打的补丁,且 relay_api 那层的前提是「直连 api.trae.ai」——而 relayApiAdapter 的
 *   RELAY_API_ENDPOINT **根本没有默认值**(`process.env.RELAY_API_ENDPOINT || ''`,文档写的是
 *   `https://your-relay.com/v1`),端点由用户自带,家族白名单对非 trae 端点必然失准。
 *
 * 正确规则 khy 自己已经写对过两次,只是没用在请求路径上:
 *   1. aiGatewayModelMethods.getActiveAdapter():
 *        shouldAttachPreferred = preferredAdapter && preferredAdapter !== 'auto'
 *                                && entryKey === preferredAdapter
 *   2. aiGatewayGenerateMethod 级联里已有的 ollama 特例:
 *        preferredAdapter === 'ollama' && entry.key !== 'ollama' → model: null
 *   本叶子把 (2) 从「只对 ollama」一般化成「对所有通道」,语义与 (1) 对称。
 *
 * 丢弃 = 传 null,让通道用**自有默认模型** —— 这是 normalizeModelForAdapter 既定语义
 * (「不属可服务家族 → 丢弃(null)让通道用自有默认模型」),不是新行为。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 process.env 做门控;不碰 fs/网络/子进程/时钟/随机)。
 *   - 确定性:同输入恒同输出。
 *   - 绝不抛:任何异常路径都返回安全值(true = 维持今日行为)。
 *   - env 门控 KHY_CASCADE_MODEL_SCOPE 默认开;关 = 恒 true → 逐字节回退到今日
 *     「首选模型名带给每一个候选通道」的行为。
 *
 * @module services/gateway/cascadeModelScope
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/**
 * 门控 KHY_CASCADE_MODEL_SCOPE 是否启用。flagRegistry 优先(集中真源),失败/不可用再退
 * 本地 CANON 解析。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_CASCADE_MODEL_SCOPE', env || process.env);
  } catch {
    /* fall through to local */
  }
  try {
    const raw = (env || process.env).KHY_CASCADE_MODEL_SCOPE;
    const v = String(raw === undefined || raw === null ? 'true' : raw)
      .trim()
      .toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

/**
 * 这个候选通道是否该收到「首选模型名」。
 *
 * true  —— 带上(它就是首选通道,或压根没设首选/设的是 auto → 维持今日行为)
 * false —— 丢弃,让它用自有默认模型(它不是首选通道,该模型名不属于它)
 *
 * 注意:未设首选、或首选为 'auto' 时一律返回 true。此时 options.model 要么是调用方
 * 本轮显式钉的,要么根本没有 —— 都不该由本叶子代为撤销。
 *
 * @param {string} entryKey 当前候选通道的 key
 * @param {string} preferredAdapter 已归一的首选通道 key(可能为空 / 'auto')
 * @returns {boolean}
 */
function shouldCarryPreferredModel(entryKey, preferredAdapter) {
  try {
    const preferred = String(preferredAdapter == null ? '' : preferredAdapter).trim();
    if (!preferred) {
      return true;
    }
    if (preferred.toLowerCase() === 'auto') {
      return true;
    }
    return String(entryKey == null ? '' : entryKey).trim() === preferred;
  } catch {
    return true; // 出任何岔子都维持今日行为
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeCascadeModelScope() {
  return {
    gate: 'KHY_CASCADE_MODEL_SCOPE',
    defaultOn: true,
    summary:
      '级联回落到非首选通道时,不再携带只属于首选通道的模型名(GATEWAY_PREFERRED_MODEL),' +
      '改为让该通道用自有默认模型。消除「首选通道不可用 → 拿它的模型名打别人上游 → 必然 404 ' +
      '→ 重试才答出话」的多余往返。',
    rule: 'carry ⟺ (无首选 | 首选=auto | 候选通道 === 首选通道)',
    off: '恒 carry,逐字节回退今日行为',
  };
}

module.exports = {
  isEnabled,
  shouldCarryPreferredModel,
  describeCascadeModelScope,
};
