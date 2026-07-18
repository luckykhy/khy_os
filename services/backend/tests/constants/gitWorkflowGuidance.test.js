'use strict';

/**
 * gitWorkflowGuidance.test.js — 纯叶子:git 工作流意识块单一真源。
 *
 * 验收要点:
 *  - 门控 KHY_GIT_WORKFLOW_GUIDANCE:未设/非关键字 → 开;0/false/off/no
 *    (含大小写/空白) → 关。
 *  - 门关 → buildWorkflowAwareness 返回 '' (调用方不追加,gitStatus 逐字节回退)。
 *  - 默认分支(branch===mainBranch)→ 出 branch-first 强调;feature 分支 → 出 PR 提示。
 *  - dirty=true → 追加「当前有未提交改动」提示;dirty=false → 不追加该行。
 *  - 恒含 worktree(EnterWorktree/ExitWorktree)与主动提交提醒(offer,非自动)措辞。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/constants/gitWorkflowGuidance');

test('isEnabled: 未设/非关键字 → 开;0/false/off/no(含大小写/空白) → 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: 'on' }), true);
  assert.equal(leaf.isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: 'whatever' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.equal(leaf.isEnabled({ KHY_GIT_WORKFLOW_GUIDANCE: off }), false, `off: ${off}`);
  }
});

test('门关 → 返回空串(逐字节回退)', () => {
  const out = leaf.buildWorkflowAwareness({
    branch: 'feat/x', mainBranch: 'main', dirty: true,
    env: { KHY_GIT_WORKFLOW_GUIDANCE: 'off' },
  });
  assert.equal(out, '');
});

test('feature 分支 → 含分支/main 行 + PR 提示,不含 branch-first 强调', () => {
  const out = leaf.buildWorkflowAwareness({
    branch: 'feat/git-workflow', mainBranch: 'main', dirty: false, env: {},
  });
  assert.match(out, /## Git workflow \(this repo\)/);
  assert.match(out, /on `feat\/git-workflow`/);
  assert.match(out, /default branch is `main`/);
  assert.match(out, /open PRs against/);
  // feature 分支不应出现「currently ON the default branch」强调
  assert.doesNotMatch(out, /currently ON the default branch/);
});

test('默认分支(branch===mainBranch)→ 出 branch-first 强调', () => {
  const out = leaf.buildWorkflowAwareness({
    branch: 'main', mainBranch: 'main', dirty: false, env: {},
  });
  assert.match(out, /currently ON the default branch/);
  assert.match(out, /create a feature branch first/);
});

test('恒含 worktree 与主动提交提醒(offer,非自动)措辞', () => {
  const out = leaf.buildWorkflowAwareness({
    branch: 'feat/x', mainBranch: 'main', dirty: false, env: {},
  });
  assert.match(out, /EnterWorktree \/ ExitWorktree/);
  assert.match(out, /proactively offer once/);
  assert.match(out, /Never commit until the user confirms/);
  assert.match(out, /never commit automatically/);
});

test('dirty=true → 追加当前有未提交改动提示;dirty=false → 不追加', () => {
  const dirty = leaf.buildWorkflowAwareness({ branch: 'feat/x', mainBranch: 'main', dirty: true, env: {} });
  assert.match(dirty, /working tree currently has uncommitted changes/);
  const clean = leaf.buildWorkflowAwareness({ branch: 'feat/x', mainBranch: 'main', dirty: false, env: {} });
  assert.doesNotMatch(clean, /working tree currently has uncommitted changes/);
});

test('缺 mainBranch(同步兜底路径)→ 仍产出 worktree/提交提醒,不崩', () => {
  const out = leaf.buildWorkflowAwareness({ branch: 'feat/x', dirty: true, env: {} });
  assert.match(out, /## Git workflow \(this repo\)/);
  assert.match(out, /EnterWorktree/);
  assert.match(out, /proactively offer once/);
  // 无 mainBranch → 不产出分支/main 行与 PR 行
  assert.doesNotMatch(out, /default branch is/);
});

test('入参异常(null/undefined)→ 绝不抛,返回字符串', () => {
  assert.equal(typeof leaf.buildWorkflowAwareness(null), 'string');
  assert.equal(typeof leaf.buildWorkflowAwareness(undefined), 'string');
  assert.equal(typeof leaf.buildWorkflowAwareness({}), 'string');
});
