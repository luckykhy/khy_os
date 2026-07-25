'use strict';

// ── 视觉模型名「显示归一」去 provider 路由前缀(visionModelDisplayName;OPS-MAN-150)──────
// /goal「减少显示的心灵噪音」+「无感明显告知」。断桥:describe-and-return 级联的
// `_attempts` 列表里,首候选 = `decision.model` = 被切换钉住的视觉模型,**保留** provider
// 路由前缀(如 `glm/glm-4.6v-flash`;前缀供内部 poolHint 解析用);其余候选来自
// collectVisionFallbackCandidates 是**裸 id**(glm-4v-flash、gpt-5.3-codex-review、
// claude-opus-4-6)。于是 OPS-145 逐候选中间提示里,首/次两句把内部路由 id `glm/glm-4.6v-flash`
// **原样**灌进用户可见 prose,与其余候选的裸名**不一致** = 泄漏内部路由细节的心灵噪音。
// (实测流:`[0] 正在调用 glm/glm-4.6v-flash…` `[1] 视觉模型 glm/glm-4.6v-flash 不可用…`
//  而 [2][3] 皆裸名。)visionFallbackCandidates 里已有 `_bareId`,但它**仅供去重**且**小写化**
// (`toLowerCase()`),用作显示会把 `GLM-4.6V` 之类误降级——故不能复用,须独立的**保大小写**
// 显示归一叶。
//
// 本叶只做一件事:把用户可见的视觉模型名去掉最后一个 '/' 前的 provider 段(**保留大小写**),
// 供 aiGateway 在把 model/prevModel 交给 buildCascadeAttemptNotice **之前**归一。
//   `glm/glm-4.6v-flash` → `glm-4.6v-flash`;`zhipu/GLM-4.6V` → `GLM-4.6V`;裸名原样。
// 门 KHY_VISION_MODEL_DISPLAY_NAME 关 → 原样返回(逐字节回退,含前缀)。
// 零 IO、纯字符串、绝不抛。仅作用于**显示边界**——内部 `_att.model` / `_prevAttemptModel`
// 路由态**完全不动**(poolHint 解析仍靠原始带前缀 id)。

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_VISION_MODEL_DISPLAY_NAME';

function isVisionModelDisplayNameEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

// 去 provider 路由前缀(最后一个 '/' 之后),保留原大小写;门关/畸形/无前缀 → 原样。
function toDisplayModelName(model, env) {
  try {
    const raw = model == null ? '' : String(model);
    if (!isVisionModelDisplayNameEnabled(env)) return raw;
    const trimmed = raw.trim();
    if (!trimmed) return raw;
    const idx = trimmed.lastIndexOf('/');
    if (idx < 0) return raw;
    const bare = trimmed.slice(idx + 1);
    // 前缀存在但去后为空(如 'glm/' 末尾即斜杠)→ 保守回退原样,绝不产出空名。
    return bare || raw;
  } catch {
    return model == null ? '' : String(model);
  }
}

module.exports = {
  isVisionModelDisplayNameEnabled,
  toDisplayModelName,
  FLAG,
};
