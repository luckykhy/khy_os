'use strict';

/**
 * worktreeSessionCwd — 模型驱动 worktree 进/出的双 cwd 同步单测(node:test)。
 *
 * 回归目标(用户报告「khy 不会真正使用工作树」):EnterWorktreeTool/ExitWorktreeTool 切
 * worktree 时必须同步**两个** cwd 源(KHYQUANT_CWD + process.chdir),否则文件/git 工具仍锚旧根。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/services/worktreeSessionCwd');

test('switchToolCwd:门控开 → 同步 KHYQUANT_CWD + chdir', () => {
  const env = {};
  let chdirTo = null;
  const r = mod.switchToolCwd('/tmp/wt/a', { env, chdir: (d) => { chdirTo = d; } });
  assert.strictEqual(r.switched, true);
  assert.strictEqual(r.cwd, '/tmp/wt/a');
  assert.strictEqual(r.syncedEnv, true);
  assert.strictEqual(r.chdirOk, true);
  assert.strictEqual(env.KHYQUANT_CWD, '/tmp/wt/a', 'KHYQUANT_CWD 必须被同步(工具权威 cwd)');
  assert.strictEqual(chdirTo, '/tmp/wt/a');
});

test('switchToolCwd:门控关 → 只 chdir,KHYQUANT_CWD 不动(字节回退旧行为)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    const env = { KHY_WORKTREE_TOOL_CWD: off };
    let chdirTo = null;
    const r = mod.switchToolCwd('/tmp/wt/b', { env, chdir: (d) => { chdirTo = d; } });
    assert.strictEqual(r.switched, true, off);
    assert.strictEqual(r.syncedEnv, false, off);
    assert.strictEqual(env.KHYQUANT_CWD, undefined, `${off}: 关时不应写 KHYQUANT_CWD`);
    assert.strictEqual(chdirTo, '/tmp/wt/b', `${off}: 关时仍 chdir`);
  }
});

test('switchToolCwd:空目标 → no-op', () => {
  const env = {};
  let called = false;
  const r = mod.switchToolCwd('', { env, chdir: () => { called = true; } });
  assert.strictEqual(r.switched, false);
  assert.strictEqual(called, false);
  assert.strictEqual(env.KHYQUANT_CWD, undefined);
});

test('switchToolCwd:chdir 抛错不影响 env 同步(fail-soft)', () => {
  const env = {};
  const r = mod.switchToolCwd('/tmp/wt/c', { env, chdir: () => { throw new Error('nope'); } });
  assert.strictEqual(r.chdirOk, false);
  assert.strictEqual(r.syncedEnv, true, 'chdir 失败但 KHYQUANT_CWD 仍应同步(工具权威源)');
  assert.strictEqual(env.KHYQUANT_CWD, '/tmp/wt/c');
});

test('switchToolCwd:绝不抛(非法入参)', () => {
  assert.doesNotThrow(() => mod.switchToolCwd(null, null));
  assert.doesNotThrow(() => mod.switchToolCwd(undefined));
  assert.doesNotThrow(() => mod.switchToolCwd(123, { env: {} }));
});

test('worktreeToolCwdEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.worktreeToolCwdEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(mod.worktreeToolCwdEnabled({ KHY_WORKTREE_TOOL_CWD: off }), false, off);
  }
});
