'use strict';

/**
 * repoRolloutStage.test.js — 真实仓库新机制落地阶段守卫（PROCESS-008）
 *
 *   node --test scripts/tests/repoRolloutStage.test.js
 *
 * 与守卫自带反例自测的分工：反例自测验证判定逻辑；本测试把守卫对准真实的
 * docs/10_规范/registry/FEATURE-OWNERSHIP.json，钉死：所有已登记拦截型机制的阶段声明
 * 满足六条红线（尤其 PP-2「毕业看样本量」），check-rollout-stage 0 error。
 * 登记表 stage 虚高于执行器实测样本所能支撑的阶段时，本测试变红。
 *
 * HOW-TO-EXTEND：无需改本文件。机制升阶前先在登记表 samples.observed 攒够
 * 上一阶毕业阈值（S1→S2 需 ≥200），或按 PP-4 回退登记表 stage。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('registered rollout stages satisfy all six red lines (0 errors)', () => {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'check-rollout-stage.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
    status = err.status;
  }
  const errorLines = stdout.split('\n').filter((l) => l.startsWith('[ERROR]'));
  assert.equal(errorLines.length, 0,
    `rollout-stage errors:\n${errorLines.join('\n')}`);
  assert.equal(status, 0, `guard exited nonzero:\n${stdout}`);
});
