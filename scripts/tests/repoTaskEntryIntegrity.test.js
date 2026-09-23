'use strict';

/**
 * repoTaskEntryIntegrity.test.js — 真实仓库 npm run 任务入口引用完整性守卫
 *
 *   node --test scripts/tests/repoTaskEntryIntegrity.test.js
 *
 * 与 check-repo-layout.test.js 的分工：后者用 fixture 验证守卫判定逻辑；
 * 本测试把守卫对准真实仓库，钉死 [DESIGN-LAY-005] §5.1：
 * 被引用的每个 npm run 目标都必须有对应脚本定义（dangling-task 基线棘轮
 * 只允许下降，当前基线 87）。文档新增 `npm run x` 引用而未定义脚本、
 * 或改名漏改引用时，本测试变红。
 *
 * HOW-TO-EXTEND：无需改本文件。新增任务引用时同步在 package.json（或对应
 * workspace）定义脚本；确属外部工具的引用改为行内命令而非 npm run 目标。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'ci', 'repo-layout-baseline.json');

test('dangling npm run targets do not exceed the ratchet baseline', () => {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'check-repo-layout.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const counts = stdout.match(/counts: (\{.*\})/);
  assert.ok(counts, `guard did not emit a counts line:\n${stdout}`);
  const parsed = JSON.parse(counts[1]);
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  assert.ok(Number.isInteger(baseline.counts['dangling-task']),
    'baseline missing dangling-task entry');
  assert.ok(parsed['dangling-task'] <= baseline.counts['dangling-task'],
    `dangling-task ${parsed['dangling-task']} > baseline ${baseline.counts['dangling-task']}`);
  for (const key of ['unresolved-require', 'docs-index-complete']) {
    assert.equal(parsed[key], 0,
      `${key} must stay 0; details:\n${
        stdout.split('\n').filter((l) => l.includes('（不存在）') || l.includes('漏链')).join('\n')}`);
  }
});
