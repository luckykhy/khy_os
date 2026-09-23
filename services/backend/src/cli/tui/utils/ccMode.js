'use strict';

/**
 * ccMode.js —— CC 模式门控检测工具函数
 *
 * 唯一合法的门控检测方式。所有 CC 模式代码必须通过本模块判断。
 * 禁止在代码中直接写 `process.env.KHY_CC_TUI === '1'` —— 统一走这里。
 *
 * ## ⚠ CC 模式当前是**预览态**（preview），不是可用的 CC 复刻（2026-09-22）
 *
 * `KHY_CC_TUI=1` 会把 TUI 换成 `CcApp`（`ink-components/CcApp.js`）。该组件
 * **尚未完成产品定性**——按 [DESIGN-PROCESS-001] §2.2 的粒度判别，
 * 「CC 表面该做到预览还是真接线」超出维护者可自行决定的粒度，需产品判断。
 *
 * 因此，**在该定性作出之前，CC 模式对外一律是预览**：
 *   - slash 命令选择器里只有 `/copy` 是真接线，其余（`/clear` `/compact` `/cost`
 *     `/model` `/mcp` `/permissions`）**只回显、不执行**，提示语为「预览模式：未执行」；
 *   - 助手回复是回声桩，未连接 AI 网关，回显自带 `[预览]` 前缀；
 *   - `ccPreviewNotice()` 供各处统一取用该告知文案，避免措辞漂移。
 *
 * 真接线时的验收：删掉本节的预览声明 + `CcApp` 头部的预览声明 +
 * `addToast` 里的「预览模式：未执行」措辞，并让选择器真正分派到命令路由。
 *
 * 参考：[DESIGN-ARCH-081] 环境变量门控策略 · [DESIGN-PROCESS-001] §2.2 粒度判别
 */

/**
 * CC 模式是否处于预览态（当前恒为 true —— 定性未作出前不允许它变成「成品」）。
 *
 * 刻意做成**函数而非常量**：将来获得定性授权后，只需改这一个返回点，
 * 而不必去各处搜散落的字符串。调用方应据此决定是否给用户「未执行」告知。
 *
 * @returns {boolean}
 */
function isCcPreview() {
  return true;
}

/**
 * 预览态的统一告知文案（单点，避免措辞在各组件里漂移）。
 * @param {string} [what] 具体对象，如 '/clear'、'助手回复'
 * @returns {string}
 */
function ccPreviewNotice(what) {
  const subject = what ? String(what) : 'CC 模式';
  return `${subject} — 预览模式：未执行`;
}

/**
 * 检测是否处于 CC 复刻模式
 * @returns {boolean}
 */
function isCcMode() {
  return process.env.KHY_CC_TUI === '1';
}

/**
 * 检测 CC 子功能是否启用
 * @param {string} subFeature - 子功能名（如 'LOGO', 'STATUS_BAR', 'TOOL_STYLE'）
 * @returns {boolean} 主开关开启且子功能未显式关闭时返回 true
 */
function ccFeature(subFeature) {
  if (!isCcMode()) return false;
  const specific = process.env[`KHY_CC_${subFeature.toUpperCase()}`];
  // 默认跟随主开关，除非显式设为 '0'
  return specific !== '0';
}

/**
 * 获取所有 CC 子功能门控状态（调试用）
 */
function ccFeatureStatus() {
  const features = [
    'LOGO', 'STATUS_BAR', 'MSG_STYLE', 'TOOL_STYLE',
    'PERMISSION', 'COMPLETION', 'COLORS', 'SIDEBAR', 'HELP',
  ];
  const result = {};
  for (const f of features) {
    result[f] = ccFeature(f);
  }
  return result;
}

module.exports = { isCcMode, isCcPreview, ccPreviewNotice, ccFeature, ccFeatureStatus };
