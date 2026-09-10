'use strict';

/**
 * ccBrand.js —— 品牌文本集中管理
 *
 * CC 模式下所有面向用户的品牌文本。修改品牌只需改此文件。
 * 禁止在 CC 模式 UI 中出现 "Claude Code" 或 "Claude" 品牌文本。
 *
 * 参考：[DESIGN-ARCH-081] 品牌替换规范
 */

const BRAND = Object.freeze({
  name: 'Khy',
  fullName: 'Khy',
  logo: '✳',           // 动画星号字符
  tagline: 'AI-powered coding assistant',

  // UI 文本
  welcomeTitle: 'Welcome to Khy',
  welcomeSubtitle: 'AI-powered coding assistant',
  inputPlaceholder: 'Send a message...',
  statusBarModelPrefix: '', // 不显示 "Claude" 前缀

  // 版权/关于
  poweredBy: 'Powered by Khy',
  versionTemplate: (v) => `Khy v${v}`,
});

/**
 * 替换文本中的 Claude Code 品牌为 Khy
 * @param {string} text
 * @returns {string}
 */
function replaceBrand(text) {
  if (!text) return text;
  return text
    .replace(/Claude Code/g, BRAND.fullName)
    .replace(/\bClaude\b/g, BRAND.name)
    .replace(/claude-code/g, 'khy');
}

module.exports = { BRAND, replaceBrand };
