'use strict';

/**
 * completionKeysLazy + router.getCompletions 集成测试。
 *
 * 覆盖:
 *  - 叶子:门控 CANON、buildKeys 安全求值(非数组→[]、抛错→[])。
 *  - 集成:router.getCompletions 在 KHY_COMPLETION_KEYS_LAZY ON / OFF 下对同一串输入
 *    (斜杠 / 非斜杠命令 / 子命令 / 空)输出**逐字节一致**(惰性化=纯重排不变量)。
 *  - LIVE wiring:router.js 源确实 require + 在斜杠 early-return 后惰性构造 allKeys。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const leaf = require('../../src/cli/completionKeysLazy');
const router = require('../../src/cli/router');

test('isEnabled: default-on, CANON off-words', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_COMPLETION_KEYS_LAZY: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.equal(leaf.isEnabled({ KHY_COMPLETION_KEYS_LAZY: off }), false, `off=${off}`);
  }
  assert.deepEqual(leaf.OFF_VALUES, ['0', 'false', 'off', 'no']);
});

test('buildKeys: returns computeFn output when array', () => {
  assert.deepEqual(leaf.buildKeys(() => ['a', 'b']), ['a', 'b']);
});

test('buildKeys: non-array output → [] (fail-soft)', () => {
  assert.deepEqual(leaf.buildKeys(() => null), []);
  assert.deepEqual(leaf.buildKeys(() => undefined), []);
  assert.deepEqual(leaf.buildKeys(() => 'str'), []);
  assert.deepEqual(leaf.buildKeys(() => 42), []);
});

test('buildKeys: computeFn throws → [] not throw', () => {
  assert.deepEqual(leaf.buildKeys(() => { throw new Error('boom'); }), []);
});

test('router.getCompletions: ON vs OFF byte-identical across input classes', () => {
  const inputs = [
    '',            // empty
    '/',           // bare slash
    '/m',          // slash prefix
    '/model',      // slash full
    '/xyz-none',   // slash no-match
    'he',          // non-slash command prefix
    'help',        // non-slash command
    'git ',        // command + space (sub-command context)
    'git st',      // command + sub prefix
    'zzz-nomatch', // non-slash no-match
  ];
  const prev = process.env.KHY_COMPLETION_KEYS_LAZY;
  try {
    for (const inp of inputs) {
      process.env.KHY_COMPLETION_KEYS_LAZY = 'on';
      const on = router.getCompletions(inp);
      process.env.KHY_COMPLETION_KEYS_LAZY = 'off';
      const off = router.getCompletions(inp);
      assert.deepEqual(on, off, `input=${JSON.stringify(inp)} must be identical ON vs OFF`);
    }
  } finally {
    if (prev == null) delete process.env.KHY_COMPLETION_KEYS_LAZY;
    else process.env.KHY_COMPLETION_KEYS_LAZY = prev;
  }
});

test('router.getCompletions: never throws on odd input (defensive)', () => {
  const prev = process.env.KHY_COMPLETION_KEYS_LAZY;
  try {
    process.env.KHY_COMPLETION_KEYS_LAZY = 'on';
    assert.doesNotThrow(() => router.getCompletions(''));
    assert.doesNotThrow(() => router.getCompletions('   '));
    assert.doesNotThrow(() => router.getCompletions('/'));
  } finally {
    if (prev == null) delete process.env.KHY_COMPLETION_KEYS_LAZY;
    else process.env.KHY_COMPLETION_KEYS_LAZY = prev;
  }
});

test('LIVE wiring: router.js requires leaf + lazily builds allKeys after slash return', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../src/cli/router.js'),
    'utf8',
  );
  assert.ok(/require\(['"]\.\/completionKeysLazy['"]\)/.test(src), 'requires completionKeysLazy');
  assert.ok(/completionKeysLazy\(\)\.isEnabled\(/.test(src), 'gates on isEnabled');
  assert.ok(/completionKeysLazy\(\)\.buildKeys\(/.test(src), 'lazily builds via buildKeys');
  // The lazy build call must sit AFTER the slash early-return block (so slash path skips it).
  const idxSlashReturn = src.indexOf('.map(sc => sc.cmd);');
  const idxBuildKeys = src.indexOf('completionKeysLazy().buildKeys(');
  assert.ok(idxSlashReturn > 0 && idxBuildKeys > idxSlashReturn,
    'buildKeys call is positioned after the slash early-return');
});
