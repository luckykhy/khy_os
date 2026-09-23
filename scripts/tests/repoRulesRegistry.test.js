'use strict';

/**
 * repoRulesRegistry.test.js — 真实仓库规则登记表引用完整性守卫
 *
 *   node --test scripts/tests/repoRulesRegistry.test.js
 *
 * 与 check-rules-registry.test.js 的分工：后者用 fixture 验证守卫判定逻辑；
 * 本测试把守卫对准真实仓库，钉死：docs/10_规范/registry/RULES-REGISTRY.json 的每条
 * 语义真源指针都必须指向磁盘上存在的文件（TOOLING-007 死指针红线），
 * 且 check-rules-registry 全量校验 0 error。文档搬迁进子目录而登记表未跟
 * 上时，本测试变红并点名失效规则 ID。
 *
 * HOW-TO-EXTEND：无需改本文件。移动规范文档后同步更新 RULES-REGISTRY.json
 * 中对应条目的真源路径即可。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('RULES-REGISTRY has no dead truth-source pointers (0 errors)', () => {
  let stdout;
  try {
    stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'check-rules-registry.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const errorLines = stdout.split('\n').filter((l) => l.startsWith('[ERROR]'));
  const summary = stdout.match(/Summary: (\d+) rule-registry error/);
  assert.ok(summary || stdout.includes('检查通过'),
    `guard emitted neither errors nor a pass line:\n${stdout}`);
  assert.equal(errorLines.length, 0,
    `rule-registry errors:\n${errorLines.join('\n')}`);
});
