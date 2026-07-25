'use strict';

// ── describe-and-return 级联「每候选提示」减冗余(visionCascadeAttemptNotice;OPS-MAN-145)──────
// /goal「减少显示的心灵噪音」+「无感明显告知」。断桥:视觉级联在 aiGatewayGenerateMethod 的
// `for (const _att of _attempts)` 循环里,对**每个**视觉候选发一条中间提示
// `我无法直接识别图片内容。正在调用 <model> 进行识别，请稍候...`(门 KHY_VISION_INTERMEDIATE_MESSAGE)。
// 当级联有 N 个候选(实测日志:glm/glm-4.6v-flash + glm-4v-flash 两个)时,首句
// 「我无法直接识别图片内容。」**逐字节重复 N 遍**,且候选 2..N 其实是候选 1 已失败后的**兜底**,
// 却读起来像并行发起 N 个独立新调用 = 冗余噪音 + 语义不准。
//
// 本叶把每候选提示做成 index 感知:
//   - 首候选(index<=0 或索引缺失)→ 保留完整首句(与历史逐字节一致);
//   - 后续候选(index>0)→ 去掉冗余「我无法直接识别图片内容。」首句,改为
//     `视觉模型 <prev> 不可用，正在改用 <model> 继续识别...`——既减噪,又点明这是级联兜底
//     (与成功侧 line 1552「主视觉模型 X 不可用，已自动改用 Y 完成识别」的 promise→resolution 对称)。
// 门 KHY_VISION_CASCADE_ATTEMPT_NOTICE 关 → 对所有候选都返回历史首句 = 逐字节回退。
// 零 IO、纯格式化、绝不抛。共享 _intermediateEnabled 父前提(调用方仅在中间消息门开时接线本叶)。

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_VISION_CASCADE_ATTEMPT_NOTICE';
// 后续候选兜底句的稳定标记(测试/答复侧去重可据此识别本叶产出)。
const CASCADE_ATTEMPT_FALLBACK_MARKER = '正在改用';

function isCascadeAttemptNoticeEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

// 历史首句(与 aiGatewayGenerateMethod line 1507 逐字节一致,含 '视觉模型' 兜底名)。
function _legacyLine(model) {
  return `我无法直接识别图片内容。正在调用 ${model || '视觉模型'} 进行识别，请稍候...`;
}

// 返回第 index 个视觉候选的用户可见中间提示。
//   - 门关 / index<=0 / 索引缺失 → 历史首句(逐字节回退);
//   - 门开 + index>0 → 「视觉模型 <prev> 不可用，正在改用 <model> 继续识别...」减冗余首句。
function buildCascadeAttemptNotice({ index, model, prevModel, env } = {}) {
  const _model = model || '视觉模型';
  if (!isCascadeAttemptNoticeEnabled(env)) return _legacyLine(model);
  const i = Number(index);
  if (!Number.isFinite(i) || i <= 0) return _legacyLine(model);
  const _prev = prevModel || '上一视觉模型';
  return `视觉模型 ${_prev} 不可用，正在改用 ${_model} 继续识别...`;
}

module.exports = {
  isCascadeAttemptNoticeEnabled,
  buildCascadeAttemptNotice,
  FLAG,
  CASCADE_ATTEMPT_FALLBACK_MARKER,
};
