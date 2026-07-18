'use strict';

/**
 * resolveUserPath.js — 「展开环境变量/~ 后再归一到桌面并 resolve 绝对路径」共享 helper
 *   (非纯·读 process.env/os·委托 _userDirs)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_resolvePath(rawPath, cwd)`——
 *   cli/handlers/convert(内部用·:76/:203)·cli/handlers/doc(内部用·:103/:111)。
 *
 * 语义:先经 [[expandEnvPath]] 展开 `%VAR%`/`$VAR`/`~`(与原内联逐字等价)→ 试
 *   `_userDirs.normalizeDesktopPath(path.resolve(cwd, p))`(失败静默忽略)→ 最终
 *   `path.resolve(cwd, p)` 返回绝对路径。**绝不抛**·不 mutate 入参。
 *
 * 契约:非纯(env/os·委托 _userDirs)·fail-soft·各消费方保留同名本地
 *   `const _resolvePath = require('../../utils/resolveUserPath')` → 调用点逐字节不变。
 */

const path = require('path');
const expandEnvPath = require('./expandEnvPath');

function resolveUserPath(rawPath, cwd) {
  let p = expandEnvPath(rawPath);
  try { p = require('../tools/_userDirs').normalizeDesktopPath(path.resolve(cwd, p)); } catch { /* ignore */ }
  return path.resolve(cwd, p);
}

module.exports = resolveUserPath;
