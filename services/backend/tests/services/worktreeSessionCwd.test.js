'use strict';
/**
 * worktreeSessionCwd �?模型驱动 worktree �?出的�?cwd 同步单测(node:test)�?
 *
 * 回归目标(用户报告「khy 不会真正使用工作树�?:EnterWorktreeTool/ExitWorktreeTool �?
 * worktree 时必须同�?*两个** cwd �?KHYQUANT_CWD + process.chdir),否则文件/git 工具仍锚旧根�?
 *
 * node:test(jest �?rtk 代理�?Exec format error 不可�?�?
 */
const mod = require('../../src/services/worktreeSessionCwd');

describe('Worktree Session Cwd', () => {
  test('switchToolCwd:门控开 �?同步 KHYQUANT_CWD + chdir', () => {
      const env = {};
      let chdirTo = null;
      const r = mod.switchToolCwd('/tmp/wt/a', { env, chdir: (d) => { chdirTo = d; } });
      expect(r.switched).toBe(true);
      expect(r.cwd).toBe('/tmp/wt/a');
      expect(r.syncedEnv).toBe(true);
      expect(r.chdirOk).toBe(true);
      expect(env.KHYQUANT_CWD).toBe('/tmp/wt/a', 'KHYQUANT_CWD 必须被同�?工具权威 cwd)');
      expect(chdirTo).toBe('/tmp/wt/a');
  });

  test('switchToolCwd:门控�?�?�?chdir,KHYQUANT_CWD 不动(字节回退旧行�?', () => {
      for (const off of ['0', 'false', 'off', 'no']) {
        const env = { KHY_WORKTREE_TOOL_CWD: off };
        let chdirTo = null;
        const r = mod.switchToolCwd('/tmp/wt/b', { env, chdir: (d) => { chdirTo = d; } });
        expect(r.switched).toBe(true, off);
        expect(r.syncedEnv).toBe(false, off);
        expect(env.KHYQUANT_CWD).toBe(undefined, `${off}: 关时不应�?KHYQUANT_CWD`);
        expect(chdirTo).toBe('/tmp/wt/b', `${off}: 关时�?chdir`);
      }
  });

  test('switchToolCwd:空目�?�?no-op', () => {
      const env = {};
      let called = false;
      const r = mod.switchToolCwd('', { env, chdir: () => { called = true; } });
      expect(r.switched).toBe(false);
      expect(called).toBe(false);
      expect(env.KHYQUANT_CWD).toBe(undefined);
  });

  test('switchToolCwd:chdir 抛错不影�?env 同步(fail-soft)', () => {
      const env = {};
      const r = mod.switchToolCwd('/tmp/wt/c', { env, chdir: () => { throw new Error('nope'); } });
      expect(r.chdirOk).toBe(false);
      expect(r.syncedEnv).toBe(true, 'chdir 失败�?KHYQUANT_CWD 仍应同步(工具权威�?');
      expect(env.KHYQUANT_CWD).toBe('/tmp/wt/c');
  });

  test('switchToolCwd:绝不�?非法入参)', () => {
      expect(() => mod.switchToolCwd(null, null).not.toThrow());
      expect(() => mod.switchToolCwd(undefined).not.toThrow());
      expect(() => mod.switchToolCwd(123, { env: {} }).not.toThrow());
  });

  test('worktreeToolCwdEnabled:默认开 + 关闭词表', () => {
      expect(mod.worktreeToolCwdEnabled({})).toBe(true);
      for (const off of ['0', 'false', 'off', 'no']) {
        expect(mod.worktreeToolCwdEnabled({ KHY_WORKTREE_TOOL_CWD: off })).toBe(false, off);
      }
  });

});

