'use strict';

/**
 * repoWiring.test.js — 真实仓库反孤儿接线守卫（TOOLING-005）
 *
 *   node --test scripts/tests/repoWiring.test.js
 *
 * 把 check-wiring.js 对准真实仓库：scripts/ci 下每个检查器要么被门引用
 * （package.json 脚本 / workflow / git hook / 阶段表），要么在
 * scripts/ci/wiring-exemptions.json 登记 reason + until。0 error 为红线。
 *
 * HOW-TO-EXTEND：无需改本文件。新增检查器时接进门或登记豁免（到期必须处理）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('all scripts/ci checkers are wired or exempted (0 errors)', () => {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'check-wiring.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
    status = err.status;
  }
  const errorLines = stdout.split('\n').filter((l) => l.startsWith('[ERROR]'));
  assert.equal(errorLines.length, 0, `wiring errors:\n${errorLines.join('\n')}`);
  assert.equal(status, 0, `guard exited nonzero:\n${stdout}`);
});
