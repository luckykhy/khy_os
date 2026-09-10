'use strict';

/**
 * ccClipboard.js — 剪贴板工具
 * 
 * 使用 OSC 52 协议，支持 SSH 和本地环境
 */

const OSC_52_PREFIX = '\x1B]52;c;';
const OSC_52_SUFFIX = '\x07';

/**
 * 复制文本到剪贴板
 * @param {string} text
 * @returns {boolean} 是否成功
 */
function copyToClipboard(text) {
  if (!text) return false;

  try {
    const base64 = Buffer.from(text, 'utf8').toString('base64');
    process.stdout.write(OSC_52_PREFIX + base64 + OSC_52_SUFFIX);
    return true;
  } catch {
    return fallbackCopy(text);
  }
}

/**
 * 系统命令 fallback
 */
function fallbackCopy(text) {
  try {
    const { execSync } = require('child_process');
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync('pbcopy', { input: text });
    } else if (platform === 'linux') {
      execSync('xclip -selection clipboard', { input: text });
    } else if (platform === 'win32') {
      execSync('clip', { input: text });
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { copyToClipboard };
