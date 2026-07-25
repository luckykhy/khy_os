'use strict';

/**
 * modelNotFoundCooldownScope — 纯叶子:把 `model_not_found`(404)的 fast-fail 冷却
 * 从「按通道(adapter)」收窄为「按模型」。
 *
 * 背景(用户实测,识图始终失败):
 *   某次请求携带**复合路由 id**(`api:glm:glm-4.6v-flash`,三段式内部 id 漏到上游)撞上游
 *   404 model_not_found → 冷却被写到整条 `api` 通道(_TRANSIENT_COOLDOWN_MS.model_not_found=30s)。
 *   随后剥成**裸名** `glm-4.6v-flash` 的**修正**请求在这 30s 窗口内被同一通道的冷却直接 fast-fail
 *   短路,吐出陈旧的 `recent model_not_found failure cached (cooldown 28s)` —— 而该裸名模型明明可用
 *   (此前甚至报过 token 超限,证明请求已到达上游、模型确实存在)。把「某个模型名对上游不可用」这条
 *   **按模型**的事实,当成「整条通道不可用」来冷却,是这次误诊的根因。
 *
 * 定性:model_not_found 是**按模型**的错误(该模型串在上游不存在/未开通),而 fast-fail 缓存按
 *   adapter 键控。既有 `_shouldBypassCooldownForVisionDescribe` 只覆盖「视觉 describe 透传」这一窄路径;
 *   本叶子把它泛化成通用规则:**当前请求的模型串 ≠ 造成 404 的那个模型串** → 该冷却不适用于当前模型,
 *   放行做一次真实尝试(复合 id 剥成裸名后即是不同串,当轮即可救回)。相同模型串则仍尊重冷却
 *   (避免在紧循环里反复硬撞同一个确实不存在的模型)。「模型不存在」的显示纠偏由 sibling
 *   modelExistenceEvidence 负责,本叶子只管**行为**(是否放行冷却)。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 env 门控;不碰 fs / 网络 / 子进程 / 时钟 / 随机)。
 *   - 确定性:同输入恒同输出(纯字符串比较)。
 *   - 绝不抛:任何异常路径返回安全值(false → 尊重今日冷却,逐字节回退)。
 *   - 门控 KHY_MNF_COOLDOWN_PER_MODEL 默认开(parent KHY_MODEL_NOT_FOUND_RECOVERY);
 *     关 / 缺当前模型 / 缓存记录无模型(旧记录)→ 返回 false,调用方按今日冷却逐字节处理。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/**
 * 门控 KHY_MNF_COOLDOWN_PER_MODEL 是否启用。flagRegistry 优先(集中真源,含 parent 门联动),
 * 失败/不可用再退本地 CANON 解析。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_MNF_COOLDOWN_PER_MODEL', env || process.env);
  } catch { /* fall through to local */ }
  try {
    const raw = (env || process.env).KHY_MNF_COOLDOWN_PER_MODEL;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

function _norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

/**
 * 是否应对**当前请求的模型**放行一条已缓存的 model_not_found 冷却。
 *
 * true 的充要条件(全部满足):门开 + 缓存项确为 model_not_found + 当前模型串非空 +
 * 缓存记录里带有造成 404 的模型串(旧记录无则保守不放行)+ 两者归一后**不相等**。
 * 任何一项不满足 → false(尊重今日冷却,逐字节回退)。
 *
 * @param {object} [opts]
 * @param {object} [opts.cached]        _getRecentFastFail 返回的缓存失败项(含 errorType / model)
 * @param {*}      [opts.currentModel]  当前这次尝试实际要送出的模型串(normalizeModelForAdapter 后)
 * @param {object} [opts.env]
 * @returns {boolean} true → 放行(视为未冷却,继续真实尝试)
 */
function shouldBypassModelNotFoundCooldown(opts = {}) {
  try {
    if (!isEnabled(opts && opts.env)) return false;
    const cached = opts && opts.cached;
    if (!cached) return false;
    if (_norm(cached.errorType) !== 'model_not_found') return false;
    const currentModel = _norm(opts.currentModel);
    if (!currentModel) return false;          // 当前模型未知 → 保守,尊重冷却
    const cachedModel = _norm(cached.model);
    if (!cachedModel) return false;           // 旧记录无模型串 → 保守,逐字节回退
    return currentModel !== cachedModel;      // 不同模型 → 该 404 与本模型无关,放行真实尝试
  } catch {
    return false;
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeModelNotFoundCooldownScope() {
  return {
    gate: 'KHY_MNF_COOLDOWN_PER_MODEL',
    parent: 'KHY_MODEL_NOT_FOUND_RECOVERY',
    defaultOn: true,
    summary: 'model_not_found 的 fast-fail 冷却从「按通道」收窄为「按模型」:当前请求的模型串与'
      + '造成 404 的模型串不同(如复合 id 剥成裸名后)→ 放行做真实尝试,当轮即可救回;相同模型串仍尊重冷却。'
      + '门控关 / 当前或缓存模型串缺失 → 逐字节回退今日按通道冷却。',
  };
}

module.exports = {
  isEnabled,
  shouldBypassModelNotFoundCooldown,
  describeModelNotFoundCooldownScope,
};
