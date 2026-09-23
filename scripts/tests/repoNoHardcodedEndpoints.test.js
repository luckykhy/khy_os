'use strict';

/**
 * repoNoHardcodedEndpoints.test.js — 真实仓库 RUNTIME-001 端点硬编码守卫
 *
 *   node --test scripts/tests/repoNoHardcodedEndpoints.test.js
 *
 * 与 check-agent-rules.test.js 的分工：后者用 fixture 验证检查器判级逻辑；
 * 本测试把检查器对准真实主干源码目录，钉死 RUNTIME-001 红线：
 * 全仓 no-hardcoded-endpoint error 计数为 0。端点字面量只允许存在于
 * constants/serviceDefaults.js（单一真源），其余位置必须 import 或拼装。
 *
 * HOW-TO-EXTEND：无需改本文件。新增端点字面量前先放入 serviceDefaults，
 * 调用方以 require 引入；测试文件（*.test.js）按守卫既有豁免规则不计。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TARGETS = [
  'services/backend/src',
  'apps/ai-frontend/src',
  'platform',
  'software/khyquant/frontend/src',
];

test('main source trees have 0 hardcoded-endpoint errors (RUNTIME-001)', () => {
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'check-agent-rules.js'), ...TARGETS],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const endpointErrors = stdout.split('\n')
    .filter((l) => l.startsWith('[ERROR] no-hardcoded-endpoint'));
  assert.equal(endpointErrors.length, 0,
    `hardcoded endpoints:\n${endpointErrors.join('\n')}`);
});
