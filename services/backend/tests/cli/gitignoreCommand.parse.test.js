'use strict';
/**
 * gitignoreCommand.parse.test.js —/gitignore 命令的解析与子命令剥�?确定�?�?
 *
 * 锁定 router.parseInput �?/gitignore 的处�?
 *   �?/gitignore generate →command:'gitignore', subCommand:'generate';
 *   �?/gitignore add node_modules/ →subCommand:'add', args:['node_modules/'];
 *   �?/gitignore approve g123 →subCommand:'approve', args:['g123'];
 *   �?/gitignore(�? →command:'gitignore', subCommand:null(呈现侧回退 review)�?
 * 这些证明 commandSchema �?token 注册 + ROUTER_SUB_COMMANDS 登记生效�?
 */
const router = require('../../src/cli/router');

describe('Gitignore Command parse', () => {
  test('/gitignore generate →subCommand generate', () => {
      const r = router.parseInput('/gitignore generate');
      expect(r.command).toBe('gitignore');
      expect(r.subCommand).toBe('generate');
  });

  test('/gitignore add <pattern> →subCommand add + args', () => {
      const r = router.parseInput('/gitignore add node_modules/');
      expect(r.command).toBe('gitignore');
      expect(r.subCommand).toBe('add');
      expect(r.args).toEqual(['node_modules/']);
  });

  test('/gitignore approve <id> →subCommand approve + id', () => {
      const r = router.parseInput('/gitignore approve g123');
      expect(r.subCommand).toBe('approve');
      expect(r.args).toEqual(['g123']);
  });

  test('/gitignore review →subCommand review', () => {
      const r = router.parseInput('/gitignore review');
      expect(r.subCommand).toBe('review');
  });

  test('/gitignore(�? →subCommand null(呈现侧回退 review)', () => {
      const r = router.parseInput('/gitignore');
      expect(r.command).toBe('gitignore');
      expect(r.subCommand).toBe(null);
  });

  test('/gitignore 出现�?SLASH_COMMANDS(补全可发�?', () => {
      const found = (router.SLASH_COMMANDS || []).some((c) => {
        const cmd = typeof c === 'string' ? c : (c && c.cmd);
        return cmd === '/gitignore';
      });
      expect(found).toBeTruthy();
  });

});

