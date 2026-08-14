'use strict';

// compactInstructions 叶子契约测试(node:test)。
// 核心:`/compact <文本>` 的用户参数被接进 compactConversation 的 options.instructions,
// 而门控关 / 无参数时逐字节回退今日硬编码的 { mode:'auto' }。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  compactInstructionsEnabled,
  extractCompactInstructions,
  buildCompactOptions,
} = require('../../src/cli/compactInstructions');

test('门控默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(compactInstructionsEnabled({}), true);
  assert.strictEqual(compactInstructionsEnabled({ KHY_COMPACT_INSTRUCTIONS: '' }), true);
  assert.strictEqual(compactInstructionsEnabled({ KHY_COMPACT_INSTRUCTIONS: 'whatever' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      compactInstructionsEnabled({ KHY_COMPACT_INSTRUCTIONS: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('extractCompactInstructions:subCommand + args 拼接 + 空白归一 + 去空', () => {
  assert.strictEqual(
    extractCompactInstructions({ subCommand: 'focus', args: ['on', 'the', 'API'] }),
    'focus on the API',
  );
  // 仅 args
  assert.strictEqual(
    extractCompactInstructions({ args: ['keep', 'the', 'diff'] }),
    'keep the diff',
  );
  // 内部多空白 / 前后空白归一
  assert.strictEqual(
    extractCompactInstructions({ subCommand: '  keep   ', args: ['  bug   fixes '] }),
    'keep bug fixes',
  );
  // 无参数 → ''
  assert.strictEqual(extractCompactInstructions({}), '');
  assert.strictEqual(extractCompactInstructions({ args: [] }), '');
  assert.strictEqual(extractCompactInstructions({ subCommand: null, args: null }), '');
});

test('buildCompactOptions 门控开 + 有参数 → 携 instructions', () => {
  const opts = buildCompactOptions(
    { subCommand: 'focus', args: ['on', 'auth'] },
    { KHY_COMPACT_INSTRUCTIONS: '1' },
  );
  assert.deepStrictEqual(opts, { mode: 'auto', instructions: 'focus on auth' });
});

test('buildCompactOptions 无参数 → {mode:"auto"}(逐字节回退今日)', () => {
  assert.deepStrictEqual(buildCompactOptions({}, {}), { mode: 'auto' });
  assert.deepStrictEqual(buildCompactOptions({ args: [] }, {}), { mode: 'auto' });
});

test('buildCompactOptions 门控关 → {mode:"auto"}(丢弃参数·byte-identical)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.deepStrictEqual(
      buildCompactOptions(
        { subCommand: 'focus', args: ['on', 'auth'] },
        { KHY_COMPACT_INSTRUCTIONS: off },
      ),
      { mode: 'auto' },
      `门控关(${off})应回退 {mode:'auto'} 且不携 instructions`,
    );
  }
});

test('畸形输入绝不抛,均回退安全 options', () => {
  assert.deepStrictEqual(buildCompactOptions(undefined, {}), { mode: 'auto' });
  assert.deepStrictEqual(buildCompactOptions(null, {}), { mode: 'auto' });
  assert.deepStrictEqual(buildCompactOptions({ args: 'not-an-array' }, {}), { mode: 'auto' });
  // args 含 null / 数字混入不抛
  const opts = buildCompactOptions({ args: [null, 'x', 42] }, { KHY_COMPACT_INSTRUCTIONS: '1' });
  assert.deepStrictEqual(opts, { mode: 'auto', instructions: 'x 42' });
});
