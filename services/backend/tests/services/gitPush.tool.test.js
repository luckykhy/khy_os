'use strict';

/**
 * gitPush.tool.test.js — Part C「git push 概念」工具契约。
 *
 * 核心是风险口径，与 Part B 的红线收敛一致：
 *   · 普通 push 只「新增」远端提交，可逆，isDestructive=false → L1（问一次）。
 *   · force / force-with-lease 可覆盖远端历史，是破坏性操作，isDestructive=true
 *     → 网关送 L2 红线。这正是用户要保留的「修改/删除等破坏性操作」闸门。
 */

const gitPush = require('../../src/tools/gitPush');

describe('gitPush — 工具元数据与风险口径', () => {
  test('基本元数据：git 类、medium、可写', () => {
    expect(gitPush.name).toBe('gitPush');
    expect(gitPush.category).toBe('git');
    expect(gitPush.risk).toBe('medium');
    expect(typeof gitPush.execute).toBe('function');
  });

  test('isReadOnly 恒为 false（push 改变远端）', () => {
    const ro = typeof gitPush.isReadOnly === 'function' ? gitPush.isReadOnly({}) : gitPush.isReadOnly;
    expect(ro).toBe(false);
  });

  test('普通 push 非破坏性（isDestructive=false）', () => {
    expect(gitPush.isDestructive({})).toBe(false);
    expect(gitPush.isDestructive({ remote: 'origin', branch: 'main' })).toBe(false);
    expect(gitPush.isDestructive({ setUpstream: true })).toBe(false);
  });

  test('force / force-with-lease 判破坏性（→ 红线 L2）', () => {
    expect(gitPush.isDestructive({ force: true })).toBe(true);
    expect(gitPush.isDestructive({ forceWithLease: true })).toBe(true);
  });

  test('isEnabled 是函数（仅 git 仓库内可用）', () => {
    expect(typeof gitPush.isEnabled).toBe('function');
  });

  test('inputSchema 暴露 remote/branch/setUpstream/force', () => {
    const keys = Object.keys(gitPush.inputSchema || {});
    expect(keys).toEqual(expect.arrayContaining(['remote', 'branch', 'setUpstream', 'force', 'forceWithLease']));
  });
});
