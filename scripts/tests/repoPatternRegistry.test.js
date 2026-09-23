'use strict';

/**
 * repoPatternRegistry.test.js — 真实仓库模式注册表幽灵条目守卫（TOOLING-006 域）
 *
 *   node --test scripts/tests/repoPatternRegistry.test.js
 *
 * 与 check-pattern-coverage 自带自测的分工：本测试把守卫对准真实的
 * docs/design-patterns/pattern-registry.json，钉死 pattern-ghost = 0
 * （基线 0）：注册表不得指向磁盘上不存在的文件。模块搬迁（如 services →
 * services/domain/<area>/ 重组）后必须同步重锚注册表条目路径。
 *
 * HOW-TO-EXTEND：无需改本文件。删除/移动源文件时同步更新注册表条目。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('pattern registry has 0 ghost entries pointing at missing files', () => {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'check-pattern-coverage.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const counts = stdout.match(/counts: (\{.*\})/);
  assert.ok(counts, `guard did not emit a counts line:\n${stdout}`);
  const parsed = JSON.parse(counts[1]);
  assert.equal(parsed['pattern-ghost'] || 0, 0,
    `ghost entries (first lines):\n${
      stdout.split('\n').filter((l) => l.includes('·') && l.includes('services/')).slice(0, 5).join('\n')}`);
});
