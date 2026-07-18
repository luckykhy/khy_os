'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

// 修①源级 wiring:routerDispatchOps 的 khy update 显示路径已接入版本串包守卫。

test('routerDispatchOps traces which package the version was read from', () => {
  const src = read('cli/routerDispatchOps.js');
  assert.ok(
    /readInstalledVersionTraced/.test(src),
    'must add readInstalledVersionTraced to detect fallback-to-another-package'
  );
  // traced 返回 versionPkg 供守卫检测跨包。
  assert.ok(/versionPkg/.test(src), 'traced result must carry versionPkg');
});

test('update display calls evaluateUpdatedVersion with targetPkg khy-os before printing version', () => {
  const src = read('cli/routerDispatchOps.js');
  assert.ok(/pipPolicy\.evaluateUpdatedVersion\(/.test(src), 'must call evaluateUpdatedVersion');
  assert.ok(/targetPkg:\s*'khy-os'/.test(src), 'target package must be pinned to khy-os');
  // 不可信时不得再走「更新完成」成功路径。
  assert.ok(/if \(!versionTrust\.trusted\)/.test(src), 'must branch on !versionTrust.trusted');
});

test('untrusted version is NOT displayed as a successful upgrade', () => {
  const src = read('cli/routerDispatchOps.js');
  // 成功文案「更新完成」必须在 else-if(trusted 分支之后),不能无条件打印。
  const idxWarn = src.indexOf('versionTrust.message');
  const idxSuccess = src.indexOf('更新完成: v${currentVersion}');
  assert.ok(idxWarn > -1 && idxSuccess > -1, 'both branches present');
  assert.ok(idxWarn < idxSuccess, 'untrusted-warn branch must precede success branch');
});

test('pipFailurePolicy exports the guard', () => {
  const src = read('services/pipFailurePolicy.js');
  assert.ok(/evaluateUpdatedVersion,/.test(src), 'must export evaluateUpdatedVersion');
  assert.ok(/isVersionSanityEnabled,/.test(src), 'must export isVersionSanityEnabled');
  assert.ok(/KHY_PIP_VERSION_SANITY/.test(src), 'must reference the gate flag');
});
