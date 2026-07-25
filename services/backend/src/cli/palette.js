'use strict';

/**
 * G4 — palette.js — 色深检测 + 调色板工具
 *
 * 从 DeepSeek-TUI palette.rs 学习：
 * 1. 检测终端色深 (TrueColor / 256色 / 16色)
 * 2. 根据色深降级 hex 颜色
 * 3. 为主题系统提供色彩转换工具
 */

/**
 * 检测当前终端的色深能力
 * 检测链: COLORTERM → WT_SESSION → TERM_PROGRAM → TERM
 *
 * @returns {'truecolor'|'ansi256'|'ansi16'}
 */
function detectColorDepth() {
  // Respect NO_COLOR (https://no-color.org/)
  if (process.env.NO_COLOR != null) return 'ansi16';

  const ct = (process.env.COLORTERM || '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return 'truecolor';

  // Windows Terminal 支持 TrueColor
  if (process.env.WT_SESSION) return 'truecolor';

  // 已知支持 TrueColor 的终端
  const tp = (process.env.TERM_PROGRAM || '').toLowerCase();
  if (/iterm|wezterm|vscode|warp|ghostty|kitty|alacritty|hyper/.test(tp)) return 'truecolor';

  // TERM 环境变量
  const term = (process.env.TERM || '').toLowerCase();
  if (term.includes('256') || term.includes('xterm-256color')) return 'ansi256';
  if (!term || term === 'dumb') return 'ansi16';

  // 默认 256 色
  return 'ansi256';
}

/**
 * 将 hex 颜色转为 RGB 数组
 * @param {string} hex — '#RRGGBB' 或 '#RGB'
 * @returns {[number, number, number]}
 */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return [
      parseInt(h[0] + h[0], 16),
      parseInt(h[1] + h[1], 16),
      parseInt(h[2] + h[2], 16),
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * RGB → ANSI 256 色近似值
 */
function rgbToAnsi256(r, g, b) {
  // 灰度
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 247 * 24) + 232;
  }
  // 6x6x6 色彩立方
  const ri = Math.round(r / 255 * 5);
  const gi = Math.round(g / 255 * 5);
  const bi = Math.round(b / 255 * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

/**
 * RGB → ANSI 16 色（基础色）近似值
 */
function rgbToAnsi16(r, g, b) {
  // 简单的亮度映射
  const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const value = brightness > 0.5 ? 1 : 0; // bright or normal

  // 对每个通道判断是否 "on"
  const threshold = value ? 170 : 85;
  const red   = r > threshold ? 1 : 0;
  const green = g > threshold ? 1 : 0;
  const blue  = b > threshold ? 1 : 0;

  // ANSI 基础色: 30 + red*1 + green*2 + blue*4，亮色 +60
  let code = 30 + red + green * 2 + blue * 4;
  if (value) code += 60;
  return code;
}

/**
 * 根据色深将 hex 颜色转为 chalk 兼容格式
 * @param {string} hex
 * @param {'truecolor'|'ansi256'|'ansi16'} depth
 * @returns {{ type: 'hex'|'ansi256'|'ansi16', value: string|number }}
 */
function adaptColor(hex, depth) {
  if (!depth) depth = detectColorDepth();

  if (depth === 'truecolor') {
    return { type: 'hex', value: hex };
  }

  const [r, g, b] = hexToRgb(hex);

  if (depth === 'ansi256') {
    return { type: 'ansi256', value: rgbToAnsi256(r, g, b) };
  }

  return { type: 'ansi16', value: rgbToAnsi16(r, g, b) };
}

// 缓存检测结果（同一进程内终端不会变化）
let _cachedDepth = null;

/**
 * 获取缓存的色深
 */
function getColorDepth() {
  if (!_cachedDepth) _cachedDepth = detectColorDepth();
  return _cachedDepth;
}

/** @internal 测试用重置 */
function _resetForTest() {
  _cachedDepth = null;
}

/**
 * Detect terminal background mode (dark/light) via $COLORFGBG.
 * @returns {'dark'|'light'}
 */
function detectBackgroundMode() {
  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg) {
    const parts = colorfgbg.split(';');
    const bg = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(bg)) return bg >= 7 ? 'light' : 'dark';
  }
  const tp = (process.env.TERM_PROGRAM || '').toLowerCase();
  if (tp === 'apple_terminal') return 'light';
  return 'dark';
}

module.exports = {
  detectColorDepth,
  getColorDepth,
  hexToRgb,
  rgbToAnsi256,
  rgbToAnsi16,
  adaptColor,
  detectBackgroundMode,
  _resetForTest,
};
