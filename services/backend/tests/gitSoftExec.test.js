'use strict';

/**
 * gitSoftExec.test.js — 锁 utils/gitSoftExec 口径
 *   (收敛 2 处 `_gitSoft(args, cwd)` 软失败 git 执行的护栏)。
 *
 * 用真实 git(本仓库即 git repo)+ 已知失败命令,验证 ok/err 两分支且**绝不抛**。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const gitSoftExec = require('../src/utils/gitSoftExec');

const REPO = path.resolve(__dirname, '../../..'); // Khy-OS repo root (git repo)

test('成功命令 → { ok:true, out 已 trim }', () => {
  const r = gitSoftExec(['rev-parse', '--abbrev-ref', 'HEAD'], REPO);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(typeof r.out, 'string');
  assert.strictEqual(r.out, r.out.trim());
  assert.ok(r.out.length > 0);
});

test('失败命令 → { ok:false, out:"", err 有值 } 且不抛', () => {
  let r;
  assert.doesNotThrow(() => {
    r = gitSoftExec(['this-is-not-a-git-subcommand-xyz'], REPO);
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.out, '');
  assert.ok(typeof r.err === 'string' && r.err.length > 0);
});

test('无效 cwd → { ok:false } 不抛', () => {
  let r;
  assert.doesNotThrow(() => {
    r = gitSoftExec(['status'], '/nonexistent/path/xyz-khy-test');
  });
  assert.strictEqual(r.ok, false);
});
