'use strict';

// ── 视觉池失败状态「人话化」纯叶(OPS-MAN-164;/goal「减少显示的心灵噪音」)────────────────
// 断桥:视觉→OCR 兜底成功的路径上,最终生成循环仍会尝试视觉池适配器并 404,
// aiGatewayGenerateMethod 的两处适配器失败发射(~2589 / ~3202)会实时打出原始诊断行
//   `visionpool 失败: OpenAI: 404 model_not_found`
// 但此时图片内容早已被本地 OCR 成功读出并注入 prompt——该 404 是**次级噪音**:用户已经拿到答案,
// 却又看到一行像是"出错了"的红字。本叶在「门开 && OCR 已兜底成功 && 失败池名含 vision」时把这行
// 换成一句人话「视觉通道当前不可用,已用本地 OCR 兜底」;其余一律返回 null,调用方逐字节回退到原始
// `${name} 失败: ${errMsg}`——即:真失败(未经 OCR 兜底)保留可定位根因的诊断行,非视觉池不动。
//
// 纯叶契约:零 IO、env 依赖注入、绝不抛(catch→null)、门关逐字节回退。

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// 门 KHY_VISION_POOL_FAIL_STATUS_HUMANIZE(default-on)。注册表可用则委派;否则本地回退:
// 仅显式 off-word(0/false/off/no,大小写不敏感)才关,其余(含未设)视为开。
function isVisionPoolFailStatusHumanizeEnabled(env = process.env) {
  const e = env || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_VISION_POOL_FAIL_STATUS_HUMANIZE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_VISION_POOL_FAIL_STATUS_HUMANIZE;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

// 返回人话化状态串,或 null(→ 调用方保留原始 `${poolName} 失败: ${errMsg}` 逐字节回退)。
// 谓词严格:ocrRescued 必须 ===true(避免 truthy-but-not-true 误吞真失败诊断),
// 池名须匹配 /vision/i(仅视觉通道→「视觉通道不可用」在语义上才成立)。
function buildVisionPoolFailStatus({ poolName, ocrRescued, env } = {}) {
  try {
    if (!isVisionPoolFailStatusHumanizeEnabled(env)) return null;
    if (ocrRescued !== true) return null;
    const name = typeof poolName === 'string' ? poolName : '';
    if (!/vision/i.test(name)) return null;
    return '视觉通道当前不可用，已用本地 OCR 兜底';
  } catch {
    return null;
  }
}

module.exports = { isVisionPoolFailStatusHumanizeEnabled, buildVisionPoolFailStatus };
