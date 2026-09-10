'use strict';

/**
 * ccMode.js —— CC 模式门控检测工具函数
 *
 * 唯一合法的门控检测方式。所有 CC 模式代码必须通过本模块判断。
 * 禁止在代码中直接写 `process.env.KHY_CC_TUI === '1'` —— 统一走这里。
 *
 * 参考：[DESIGN-ARCH-081] 环境变量门控策略
 */

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

module.exports = { isCcMode, ccFeature, ccFeatureStatus };
