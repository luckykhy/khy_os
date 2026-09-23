'use strict';

/**
 * 相对路径 require 必须解析到真实文件 —— autoConnect.js 的回归锁。
 *
 * 现场事故：`services/backend/src/cli/autoConnect.js` 第 14/15 行写成
 *
 *     require('../../services/crossPlatform/clients/terminalClient')
 *     require('../../constants/serviceDefaults')
 *
 * 但该文件位于 `src/cli/`，`../../` 会落到 `services/backend/`，于是两条 require
 * 都指向**不存在的路径**（真实位置是 `src/services/...` 与 `src/constants/...`，
 * 只需上一级 `../`）。这类 off-by-one 在被 require 到之前完全静默——一旦加载
 * 就是 MODULE_NOT_FOUND，属「跑到那条命令才炸」的潜伏崩溃。
 *
 * 仓库自己的 check-repo-layout 有 unresolved-require 规则能扫出它（现场实测报
 * 26 处），但该门禁当前是红的、无人看，所以这里再用单测把这一处钉死。
 *
 * 本测试只做静态路径检查（不 require 目标模块），避免把 CLI 依赖树拉进单测。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../..');
const BACKEND_SRC = path.join(ROOT, 'services/backend/src');

const RESOLVE_EXTS = ['', '.js', '.cjs', '.mjs', '.json', '.node'];

function resolves(dir, spec) {
  const base = path.resolve(dir, spec);
  if (RESOLVE_EXTS.some((ext) => fs.existsSync(base + ext))) {
    return true;
  }
  return RESOLVE_EXTS.some((ext) => fs.existsSync(path.join(base, 'index' + ext)));
}

function relativeRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const out = [];
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ spec: m[1], dir });
  }
  return out;
}

describe('relative requires resolve to real files', () => {
  const target = path.join(BACKEND_SRC, 'cli/autoConnect.js');

  test('autoConnect.js exists where the fix expects it', () => {
    expect(fs.existsSync(target)).toBe(true);
  });

  test('every relative require in autoConnect.js resolves', () => {
    const missing = relativeRequires(target)
      .filter(({ spec, dir }) => !resolves(dir, spec))
      .map(({ spec }) => spec);
    expect(missing).toEqual([]);
  });

  test('the historical off-by-one double-parent form is gone', () => {
    const src = fs.readFileSync(target, 'utf8');
    expect(src).not.toContain("require('../../services/crossPlatform/clients/terminalClient')");
    expect(src).not.toContain("require('../../constants/serviceDefaults')");
  });

  test('the resolver itself rejects a genuinely missing path (self-check)', () => {
    expect(resolves(path.join(BACKEND_SRC, 'cli'), '../definitely-not-a-real-module-xyz')).toBe(
      false
    );
    expect(resolves(path.join(BACKEND_SRC, 'cli'), '../constants/serviceDefaults')).toBe(true);
  });
});
