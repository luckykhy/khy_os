'use strict';

/**
 * toolCallEqualsKvSplit.test.js — 纯叶子契约 + parseFunctionArgs 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、splitEqualsKvPairs(开门只在 `,`+`<key>=`
 * 边界切、值内逗号保留·关门返 null·非字符串返 null·已 trim·多对仍切)、fail-soft;
 * parseFunctionArgs 门开修(command/content/awk 值内逗号保住、多对仍分、R4 URL 不回归)、
 * 门关逐字节回退 legacy 全逗号切(垃圾伪参数保留)、合法多对两态一致。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/toolCallEqualsKvSplit'));

test('toolCallEqKvSplitEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.toolCallEqKvSplitEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.toolCallEqKvSplitEnabled({ KHY_TOOLCALL_EQ_KV_SPLIT: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.toolCallEqKvSplitEnabled({ KHY_TOOLCALL_EQ_KV_SPLIT: 'yes' }), true);
});

test('splitEqualsKvPairs: ON → splits only at comma-before-key=, keeps value commas', () => {
  assert.deepStrictEqual(leaf.splitEqualsKvPairs('command=echo a,b,c', {}), ['command=echo a,b,c']);
  assert.deepStrictEqual(leaf.splitEqualsKvPairs('path=/a/b, content=hello,world', {}), ['path=/a/b', 'content=hello,world']);
  // multi-pair still splits at every real boundary
  assert.deepStrictEqual(leaf.splitEqualsKvPairs('a=1, b=2, c=3', {}), ['a=1', 'b=2', 'c=3']);
  // hyphenated key boundary honored
  assert.deepStrictEqual(leaf.splitEqualsKvPairs('x=v,w, max-count=5', {}), ['x=v,w', 'max-count=5']);
});

test('splitEqualsKvPairs: OFF → null; non-string → null', () => {
  assert.strictEqual(leaf.splitEqualsKvPairs('a=1,b=2', { KHY_TOOLCALL_EQ_KV_SPLIT: '0' }), null);
  assert.strictEqual(leaf.splitEqualsKvPairs(null, {}), null);
  assert.strictEqual(leaf.splitEqualsKvPairs(42, {}), null);
});

test('fail-soft: never throws on bad env', () => {
  assert.doesNotThrow(() => leaf.splitEqualsKvPairs('a=1', undefined));
  assert.doesNotThrow(() => leaf.toolCallEqKvSplitEnabled(null));
});

// ── parseFunctionArgs 接线(真跑解析)────────────────────────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function freshParser() {
  delete require.cache[require.resolve('../src/services/toolCallParser')];
  delete require.cache[require.resolve('../src/services/toolCallEqualsKvSplit')];
  return require('../src/services/toolCallParser');
}

test('parseFunctionArgs: gate ON → value commas preserved, multi-pair still split', () => {
  withEnv({ KHY_TOOLCALL_EQ_KV_SPLIT: undefined }, () => {
    const p = freshParser();
    assert.deepStrictEqual(p.parseFunctionArgs('shell_command', 'command=echo a,b,c'), { command: 'echo a,b,c' });
    assert.deepStrictEqual(p.parseFunctionArgs('shell_command', 'command=awk -F, x'), { command: 'awk -F, x' });
    assert.deepStrictEqual(p.parseFunctionArgs('write_file', 'path=/a/b, content=hello,world'), { path: '/a/b', content: 'hello,world' });
    // multi-pair unchanged from legacy
    assert.deepStrictEqual(p.parseFunctionArgs('x', 'a=1, b=2'), { a: 1, b: 2 });
    // R4 colon-KV path not regressed
    assert.deepStrictEqual(p.parseFunctionArgs('shell_command', 'command=curl https://x.com'), { command: 'curl https://x.com' });
  });
});

test('parseFunctionArgs: gate OFF → byte-revert to legacy (comma-truncated garbage preserved)', () => {
  withEnv({ KHY_TOOLCALL_EQ_KV_SPLIT: '0' }, () => {
    const p = freshParser();
    assert.deepStrictEqual(p.parseFunctionArgs('shell_command', 'command=echo a,b,c'), { command: 'echo a', b: '', c: '' });
    assert.deepStrictEqual(p.parseFunctionArgs('write_file', 'path=/a/b, content=hello,world'), { path: '/a/b', content: 'hello', world: '' });
    // legit multi-pair identical under both gates
    assert.deepStrictEqual(p.parseFunctionArgs('x', 'a=1, b=2'), { a: 1, b: 2 });
  });
});
