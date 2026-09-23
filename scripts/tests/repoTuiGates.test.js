'use strict';

/**
 * repoTuiGates.test.js — 真实仓库 TUI 门控 token 预算守卫（DESIGN-ARCH-102 H7）
 *
 *   node --test scripts/tests/repoTuiGates.test.js
 *
 * 把 check-tui-gates.js 对准真实源码树：services/backend/src/cli/tui 下
 * （测试文件除外）实际读取的 UNIQUE KHY_* token 数不得超过脚本内 MAX_GATES
 * 预算。新函数门控可临时抬高上限，但必须在 MAX_GATES 注释里留下抬升原因与
 * 收敛计划（目标 ≤40）；用户偏好类一律进 ~/.khyquant/tui.json 而非新 env token。
 *
 * HOW-TO-EXTEND：无需改本文件。删除无消费者的遗留门控即可让计数下降。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('tui gate token count stays within budget (DESIGN-ARCH-102 H7)', () => {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'check-tui-gates.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
    status = err.status;
  }
  assert.equal(status, 0, `check-tui-gates failed:\n${stdout}`);
});
