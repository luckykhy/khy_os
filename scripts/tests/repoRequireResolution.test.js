'use strict';

/**
 * repoRequireResolution.test.js — 真实仓库深层相对 require 解析完整性守卫
 *
 *   node --test scripts/tests/repoRequireResolution.test.js
 *
 * 与 check-repo-layout.test.js 的分工：后者用临时 fixture 验证守卫本身的判定
 * 逻辑；本测试把守卫对准真实仓库，钉死一条仓库级不变量：
 *
 *   全仓深层相对 require（../../ 起步）解析出的目标必须存在于磁盘
 *   —— 即 check-repo-layout 的 unresolved-require 计数为 0（基线亦为 0，
 *   只允许下降）。文件搬迁后残留的错级 ../ 会在惰性 require 路径上潜伏崩溃，
 *   本测试在提交前把它拦成红灯。
 *
 * HOW-TO-EXTEND：无需改本文件。修掉守卫 --list=unresolved-require 点名的
 * require 路径（改指真实存在的目标，或按 [DESIGN-LAY-003] 隔离死文件）即可转绿。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

test('repo has 0 unresolved deep-relative requires', () => {
  let stdout;
  try {
    stdout = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'ci', 'check-repo-layout.js')],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  } catch (err) {
    stdout = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const counts = stdout.match(/counts: (\{.*\})/);
  assert.ok(counts, `guard did not emit a counts line:\n${stdout}`);
  const parsed = JSON.parse(counts[1]);
  assert.equal(parsed['unresolved-require'], 0,
    `unresolved-require > 0，明细：\n${
      stdout.split('\n').filter((l) => l.includes('（不存在）')).join('\n')}`);
});
