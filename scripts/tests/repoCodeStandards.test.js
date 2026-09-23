'use strict';

/**
 * repoCodeStandards.test.js — 真实仓库代码规范基线守卫（QUAL-1 基线=实测）
 *
 *   node --test scripts/tests/repoCodeStandards.test.js
 *
 * 把 check-code-standards.js 对准真实仓库：scripts/ci/code-standards.baseline.json
 * 里的每项基线都必须 ≥ 当前实测（基线回退=棘轮失效）。[DESIGN-QUAL-001] QUAL-1
 * 要求基线是实测值而非估值：存量增长时应据实回写基线并在债务台账留痕，
 * 而不是让门恒红。本测试钉住「门当前能过」，任何新增违规都会让它变红。
 *
 * HOW-TO-EXTEND：无需改本文件。真实修码降指标为首选；确属存量增长时按
 * QUAL-1 回写基线 + 更新 debt-ledger.json 的 measured/measuredAt/note。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('check-code-standards passes against current baselines', () => {
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'check-code-standards.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
    status = err.status === undefined ? -1 : err.status;
  }
  const breaches = stdout.split('\n').filter((l) => l.includes('BASELINE BREACH'));
  assert.equal(breaches.length, 0, `baseline breaches:\n${breaches.join('\n')}`);
  assert.equal(status, 0, `checker exited ${status}:\n${stdout.slice(-800)}`);
});
