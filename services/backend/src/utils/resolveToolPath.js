'use strict';

const path = require('path');
const os = require('os');

/**
 * resolveToolPath.js — 「工具入参路径解析(展开 env 变量 + ~ + 相对 cwd)」共享 helper。
 *
 * 收敛 7 处 body 逐字节相同的私有 helper(services/backend/src/tools/ 下)——
 *   imageDetect/imageEdit/imageGenerate/videoGenerate._resolvePath ·
 *   imageOcr/pdfToWord/recognizeImage.resolvePath。
 *   步骤:String(raw||'')→ Windows 展开 %VAR% / POSIX 展开 ${VAR}|$VAR → 前导 ~ 换 homedir →
 *   path.resolve(cwd, p)。
 *
 * 非纯(读 process.platform / process.env / os.homedir())——刻意不标「纯叶子」。
 * 不做 fs IO(仅字符串+路径拼接),故非 IO 叶子。正则均带 g 标志用于 .replace(无 lastIndex 复用隐患)。
 *
 * **刻意不收敛(不可互委)**:
 *   - cli/handlers/convert.js·doc.js 的变体:前导 ~ 后额外 `require('../../tools/_userDirs')
 *     .normalizeDesktopPath(...)` 一步(桌面路径归一化)——多一次转换,行为不同,单列。
 *
 * 各消费方保留同名本地 `const NAME = require('../utils/resolveToolPath')`→ 调用点逐字节不变。
 */

function resolveToolPath(rawPath, cwd) {
  let p = String(rawPath || '');
  if (process.platform === 'win32') {
    p = p.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
  } else {
    p = p.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
  }
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(cwd, p);
}

module.exports = resolveToolPath;
