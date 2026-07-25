'use strict';

/**
 * docHelperEnabled.js — 「检测 docHelper.py 存在且本机可运行 python」共享 helper
 *   (非纯·读 fs·spawn python `--version` 探活)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `_checkEnabled()`——
 *   tools/imageOcr(内部用·:205)·tools/pdfToWord(内部用·:79)。两文件同在 tools/ 下,
 *   `DOC_HELPER = path.join(__dirname, '../services/docHelper.py')` 解析到同一路径;
 *   本 util 亦在 src/ 下同深度(utils/),__dirname 相对 `../services/docHelper.py`
 *   逐字节解析到同一 `services/docHelper.py`。
 *
 * 语义:docHelper.py 不存在 → false;否则试 `python3 --version`(3s 超时)成功 → true,
 *   否则试 `python --version` 成功 → true,均失败 → false。**绝不抛**。
 *
 * 契约:非纯(fs·execFileSync spawn python)·fail-soft。各消费方保留同名本地
 *   `const _checkEnabled = require('../utils/docHelperEnabled')` → 调用点逐字节不变
 *   (消费方各自的 `const DOC_HELPER = ...` 仍供其它调用点使用,不受影响)。
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DOC_HELPER = path.join(__dirname, '../services/docHelper.py');

function _checkEnabled() {
  if (!fs.existsSync(DOC_HELPER)) return false;
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    try {
      execFileSync('python', ['--version'], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch { return false; }
  }
}

module.exports = _checkEnabled;
