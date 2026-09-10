'use strict';
/**
 * gitignoreCommand.parse.test.js â€?/gitignore å‘½ä»¤çš„è§£æžä¸Žå­å‘½ä»¤å‰¥ç¦?ç¡®å®šæ€?ã€?
 *
 * é”å®š router.parseInput å¯?/gitignore çš„å¤„ç?
 *   â‘?/gitignore generate â†?command:'gitignore', subCommand:'generate';
 *   â‘?/gitignore add node_modules/ â†?subCommand:'add', args:['node_modules/'];
 *   â‘?/gitignore approve g123 â†?subCommand:'approve', args:['g123'];
 *   â‘?/gitignore(è£? â†?command:'gitignore', subCommand:null(å‘ˆçŽ°ä¾§å›žé€€ review)ã€?
 * è¿™äº›è¯æ˜Ž commandSchema çš?token æ³¨å†Œ + ROUTER_SUB_COMMANDS ç™»è®°ç”Ÿæ•ˆã€?
 */
const router = require('../../src/cli/router');

describe('Gitignore Command parse', () => {
  test('/gitignore generate â†?subCommand generate', () => {
      const r = router.parseInput('/gitignore generate');
      expect(r.command).toBe('gitignore');
      expect(r.subCommand).toBe('generate');
  });

  test('/gitignore add <pattern> â†?subCommand add + args', () => {
      const r = router.parseInput('/gitignore add node_modules/');
      expect(r.command).toBe('gitignore');
      expect(r.subCommand).toBe('add');
      expect(r.args).toEqual(['node_modules/']);
  });

  test('/gitignore approve <id> â†?subCommand approve + id', () => {
      const r = router.parseInput('/gitignore approve g123');
      expect(r.subCommand).toBe('approve');
      expect(r.args).toEqual(['g123']);
  });

  test('/gitignore review â†?subCommand review', () => {
      const r = router.parseInput('/gitignore review');
      expect(r.subCommand).toBe('review');
  });

  test('/gitignore(è£? â†?subCommand null(å‘ˆçŽ°ä¾§å›žé€€ review)', () => {
      const r = router.parseInput('/gitignore');
      expect(r.command).toBe('gitignore');
      expect(r.subCommand).toBe(null);
  });

  test('/gitignore å‡ºçŽ°åœ?SLASH_COMMANDS(è¡¥å…¨å¯å‘çŽ?', () => {
      const found = (router.SLASH_COMMANDS || []).some((c) => {
        const cmd = typeof c === 'string' ? c : (c && c.cmd);
        return cmd === '/gitignore';
      });
      expect(found).toBeTruthy();
  });

});

