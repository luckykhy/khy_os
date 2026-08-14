'use strict';

/**
 * expandEnvPath.js — 「展开环境变量 + ~ 家目录的路径」共享 helper(非纯·读 process.env/os)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_expandPath(rawPath='')`——
 *   tools/scaffoldFiles(内部用·:71/:154/:199)·tools/unpackTool(内部用·:278/:299)。
 *
 * 语义:Windows → 展开 `%VAR%`(缺失保原样 `%VAR%`);POSIX → 展开 `$VAR`/`${VAR}`
 *   (缺失→空串);开头 `~` → 替换为 os.homedir()。**不解析为绝对路径**(调用方各自
 *   `path.resolve(cwd, …)`)·不 mutate 入参。
 *
 * 契约:非纯(读 process.env/process.platform/os.homedir)·不抛。
 *   各消费方保留同名本地 `const _expandPath = require('../utils/expandEnvPath')`
 *   → 调用点逐字节不变。
 */

const os = require('os');
const path = require('path');

function expandEnvPath(rawPath = '') {
  let value = String(rawPath || '');
  if (process.platform === 'win32') {
    value = value.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
  } else {
    value = value.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
  }
  if (value.startsWith('~')) {
    value = path.join(os.homedir(), value.slice(1));
  }
  return value;
}

module.exports = expandEnvPath;
