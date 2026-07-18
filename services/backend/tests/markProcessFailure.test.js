'use strict';

/**
 * markProcessFailure.test.js — 锁 utils/markProcessFailure 口径(收敛 2 处 `_markFailure()` 的单一真源护栏)。
 * 在子进程里跑,避免污染测试 runner 自身的 process.exitCode。
 */

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');

const UTIL = path.join(__dirname, '..', 'src', 'utils', 'markProcessFailure.js');

function runChild(script) {
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: 'pipe' });
    return 0;
  } catch (e) {
    return typeof e.status === 'number' ? e.status : -1;
  }
}

test('初始 exitCode 未设 → 置为 1', () => {
  const code = runChild(`require('${UTIL}')(); process.stdout.write(String(process.exitCode));`);
  assert.strictEqual(code, 1);
});

test('已是非零(如 3)→ 保留不覆盖', () => {
  const code = runChild(`process.exitCode = 3; require('${UTIL}')(); process.stdout.write(String(process.exitCode));`);
  assert.strictEqual(code, 3);
});

test('exitCode === 0 → 置为 1', () => {
  const code = runChild(`process.exitCode = 0; require('${UTIL}')();`);
  assert.strictEqual(code, 1);
});

test('幂等:重复调用仍为 1', () => {
  const code = runChild(`const m=require('${UTIL}'); m(); m(); m();`);
  assert.strictEqual(code, 1);
});
