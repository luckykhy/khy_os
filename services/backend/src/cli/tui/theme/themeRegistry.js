'use strict';

/**
 * themeRegistry.js —— 主题注册表
 *
 * 管理所有可用主题。CC 模式使用 'cc' 主题。
 *
 * 参考：[DESIGN-ARCH-081] Phase 1: 配色与主题系统
 */

const { CC_THEME } = require('./ccTheme');

// ── 主题定义 ────────────────────────────────────────────────────────────────

const THEMES = Object.freeze({
  // Legacy 主题（默认 khy-os 风格）
  legacy: Object.freeze({
    name: 'legacy',
    colors: Object.freeze({
      primary: '#00BCD4',
      accent: '#00BCD4',
      userBubble: '#F0EAD6',
      userBubbleText: '#1A1A1A',
      userMarker: '#4ADE80',
      toolName: '#00BCD4',
      success: '#4ADE80',
      error: '#F87171',
      warning: '#FBBF24',
      dimColor: '#6B7280',
      border: '#374151',
    }),
    spacing: Object.freeze({
      messageGap: 1,
      inputBorder: true,
    }),
  }),

  // CC 复刻主题（Claude Code 风格）
  cc: CC_THEME,
});

// ── 主题查询 ────────────────────────────────────────────────────────────────

/**
 * 获取主题定义
 * @param {string} name - 主题名（'legacy' | 'cc'）
 * @returns {object} 主题对象
 */
function getTheme(name) {
  return THEMES[name] || THEMES.legacy;
}

/**
 * 根据模式获取当前主题
 * @param {boolean} isCcMode - 是否 CC 模式
 * @returns {object} 主题对象
 */
function getThemeForMode(isCcMode) {
  return isCcMode ? THEMES.cc : THEMES.legacy;
}

/**
 * 获取所有可用主题名
 */
function getThemeNames() {
  return Object.keys(THEMES);
}

module.exports = { THEMES, getTheme, getThemeForMode, getThemeNames };
