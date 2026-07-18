'use strict';

/**
 * gitignoreCommand.parse.test.js — /gitignore 命令的解析与子命令剥离(确定性)。
 *
 * 锁定 router.parseInput 对 /gitignore 的处理:
 *   ① /gitignore generate → command:'gitignore', subCommand:'generate';
 *   ② /gitignore add node_modules/ → subCommand:'add', args:['node_modules/'];
 *   ③ /gitignore approve g123 → subCommand:'approve', args:['g123'];
 *   ④ /gitignore(裸) → command:'gitignore', subCommand:null(呈现侧回退 review)。
 * 这些证明 commandSchema 的 token 注册 + ROUTER_SUB_COMMANDS 登记生效。
 */

const test = require('node:test');
const assert = require('node:assert');

const router = require('../../src/cli/router');

test('/gitignore generate → subCommand generate', () => {
  const r = router.parseInput('/gitignore generate');
  assert.strictEqual(r.command, 'gitignore');
  assert.strictEqual(r.subCommand, 'generate');
});

test('/gitignore add <pattern> → subCommand add + args', () => {
  const r = router.parseInput('/gitignore add node_modules/');
  assert.strictEqual(r.command, 'gitignore');
  assert.strictEqual(r.subCommand, 'add');
  assert.deepStrictEqual(r.args, ['node_modules/']);
});

test('/gitignore approve <id> → subCommand approve + id', () => {
  const r = router.parseInput('/gitignore approve g123');
  assert.strictEqual(r.subCommand, 'approve');
  assert.deepStrictEqual(r.args, ['g123']);
});

test('/gitignore review → subCommand review', () => {
  const r = router.parseInput('/gitignore review');
  assert.strictEqual(r.subCommand, 'review');
});

test('/gitignore(裸) → subCommand null(呈现侧回退 review)', () => {
  const r = router.parseInput('/gitignore');
  assert.strictEqual(r.command, 'gitignore');
  assert.strictEqual(r.subCommand, null);
});

test('/gitignore 出现在 SLASH_COMMANDS(补全可发现)', () => {
  const found = (router.SLASH_COMMANDS || []).some((c) => {
    const cmd = typeof c === 'string' ? c : (c && c.cmd);
    return cmd === '/gitignore';
  });
  assert.ok(found, '/gitignore 应登记在 SLASH_COMMANDS');
});
