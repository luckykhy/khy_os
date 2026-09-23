'use strict';

/**
 * promptAnchors.test.js — 装配锚点叶子单测([DESIGN-ARCH-098] P0)
 *
 *   node --test services/backend/tests/promptAnchors.test.js
 *
 * 覆盖:门控默认关 / annotate 纯附加性 / 解析与逐段计量 / 单条 token 上限 / strip 往返 /
 * 全程 fail-soft(坏输入绝不抛)。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const A = require('../src/constants/promptAnchors');

describe('promptAnchors — 门控', () => {
  test('KHY_PROMPT_ANCHORS 默认关(未设置时不插标记)', () => {
    assert.equal(A.isAnchorEnabled({}), false);
  });

  test('显式开启:1 / true 为开(opt-in 语义,比 default-on 严格)', () => {
    assert.equal(A.isAnchorEnabled({ KHY_PROMPT_ANCHORS: '1' }), true);
    assert.equal(A.isAnchorEnabled({ KHY_PROMPT_ANCHORS: 'true' }), true);
    // opt-in 只认 'true'|'1';'on' 这类词表外取值不开启(登记口径见 flagRegistry)
    assert.equal(A.isAnchorEnabled({ KHY_PROMPT_ANCHORS: 'on' }), false);
    assert.equal(A.isAnchorEnabled({ KHY_PROMPT_ANCHORS: 'yes' }), false);
  });

  test('显式关闭:0 / false / off / no 为关', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.equal(A.isAnchorEnabled({ KHY_PROMPT_ANCHORS: v }), false, `值 ${v} 应为关`);
    }
  });
});

describe('promptAnchors — annotate 的纯附加性(核心不变量)', () => {
  const entries = [
    { slot: 'prefix', id: 'simple_intro', text: 'AAA' },
    { slot: 'dynamic', id: 'memory', text: 'BBB' },
    { slot: 'tail', id: 'git_status', text: 'CCC' },
  ];

  test('门控关 → 只取 text,不插任何标记', () => {
    assert.deepEqual(A.annotate(entries, { KHY_PROMPT_ANCHORS: '0' }), ['AAA', 'BBB', 'CCC']);
  });

  test('门控开 → 标记与 text 交替,且 text 原文一字不改', () => {
    const out = A.annotate(entries, { KHY_PROMPT_ANCHORS: '1' });
    assert.equal(out.length, 6);
    assert.deepEqual(
      out.filter((s, i) => i % 2 === 1),
      ['AAA', 'BBB', 'CCC']
    );
    assert.match(out[0], /^<!-- khy:prefix:simple_intro -->$/);
    assert.match(out[2], /^<!-- khy:dynamic:memory -->$/);
    assert.match(out[4], /^<!-- khy:tail:git_status -->$/);
  });

  test('text 为 null 的段被跳过,且不为它单独产生标记', () => {
    const withNull = [
      { slot: 'prefix', id: 'doing_tasks', text: null },
      { slot: 'prefix', id: 'execution_discipline', text: 'X' },
    ];
    assert.deepEqual(A.annotate(withNull, { KHY_PROMPT_ANCHORS: '1' }), [
      '<!-- khy:prefix:execution_discipline -->',
      'X',
    ]);
  });

  test('坏输入绝不抛', () => {
    assert.deepEqual(A.annotate(null, {}), []);
    assert.deepEqual(A.annotate([], {}), []);
    assert.deepEqual(A.annotate([{ slot: 'prefix', id: 'a', text: undefined }], {}), []);
  });
});

describe('promptAnchors — 解析与逐段计量', () => {
  const system = [
    '<!-- khy:prefix:simple_system -->',
    'AAAA',
    '<!-- khy:dynamic:memory -->',
    'BB',
    '<!-- khy:tail:git_status -->',
    'CCCCCC',
  ].join('\n');

  test('parseAnchors 按标记切段并保留槽位与 id', () => {
    const { entries } = A.parseAnchors(system);
    assert.deepEqual(
      entries.map((e) => [e.slot, e.id]),
      [
        ['prefix', 'simple_system'],
        ['dynamic', 'memory'],
        ['tail', 'git_status'],
      ]
    );
  });

  test('summarizeBySlot 汇总段数与字节,并标记 anchored', () => {
    const s = A.summarizeBySlot(system);
    assert.equal(s.anchored, true);
    assert.equal(s.bySlot.prefix.count, 1);
    assert.equal(s.bySlot.dynamic.count, 1);
    assert.equal(s.bySlot.tail.count, 1);
    assert.equal(s.total, 4 + 2 + 6);
  });

  test('无锚点输入 → anchored=false 且不误报(而不是把整串当一段)', () => {
    const s = A.summarizeBySlot('just some text');
    assert.equal(s.anchored, false);
    assert.equal(s.total, 0);
    assert.deepEqual(A.parseAnchors('just some text').entries, []);
  });
});

describe('promptAnchors — 单条 token 上限(对标 Codex CLI ≤10k tokens/条目)', () => {
  test('estimateTokens:拉丁约 4 字符/token,CJK 约 1 字/token(保守高估)', () => {
    assert.equal(A.estimateTokens(''), 0);
    assert.equal(A.estimateTokens('abcd'), 1);
    assert.equal(A.estimateTokens('abcdefgh'), 2);
    // 10 个 CJK 字 → 10 token(而非按 4 字符/token 算成 2.5)
    assert.equal(A.estimateTokens('中文中文中文中文中文'), 10);
  });

  test('findOversizedEntries 命中超限段并给出 tokens/bytes', () => {
    const big = '中'.repeat(50);
    const sys = ['<!-- khy:dynamic:huge -->', big, '<!-- khy:tail:small -->', 'ok'].join('\n');
    const hit = A.findOversizedEntries(sys, 10);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, 'huge');
    assert.equal(hit[0].slot, 'dynamic');
    assert.equal(hit[0].tokens, 50);
    assert.equal(hit[0].maxTokens, 10);
  });

  test('无锚点 / 坏输入 → 空数组(不误报)', () => {
    assert.deepEqual(A.findOversizedEntries('no anchors here', 1), []);
    assert.deepEqual(A.findOversizedEntries(null, 1), []);
  });

  test('默认上限为 10000 tokens;env 可覆盖', () => {
    assert.equal(A.entryMaxTokens({}), 10000);
    assert.equal(A.entryMaxTokens({ KHY_PROMPT_ENTRY_MAX_TOKENS: '1234' }), 1234);
    assert.equal(A.entryMaxTokens({ KHY_PROMPT_ENTRY_MAX_TOKENS: '0' }), 10000);
    assert.equal(A.entryMaxTokens({ KHY_PROMPT_ENTRY_MAX_TOKENS: 'abc' }), 10000);
  });
});

describe('promptAnchors — strip 往返与坏输入', () => {
  const entries = [
    { slot: 'prefix', id: 'a', text: 'AAA' },
    { slot: 'tail', id: 'b', text: 'BBB' },
  ];

  test('stripAnchors 按分隔符还原 → 与不打锚点逐字节相同(两种分隔符)', () => {
    for (const sep of ['\n', '\n\n']) {
      const on = A.annotate(entries, { KHY_PROMPT_ANCHORS: '1' }).join(sep);
      const off = A.annotate(entries, { KHY_PROMPT_ANCHORS: '0' }).join(sep);
      assert.notEqual(on, off);
      assert.equal(A.stripAnchors(on, sep), off, `分隔符 ${JSON.stringify(sep)} 下未逐字节还原`);
    }
  });

  test('默认分隔符为 \\n\\n(与 assembleSystemPrompt 一致)', () => {
    const on = A.annotate(entries, { KHY_PROMPT_ANCHORS: '1' }).join('\n\n');
    const off = A.annotate(entries, { KHY_PROMPT_ANCHORS: '0' }).join('\n\n');
    assert.equal(A.stripAnchors(on), off);
  });

  test('stripAnchors(null) → 空串,绝不抛', () => {
    assert.equal(A.stripAnchors(null), '');
    assert.equal(A.stripAnchors(undefined), '');
  });

  test('marker() 对非法 id 做安全化,不破坏注释语法', () => {
    const m = A.marker('prefix', 'a b-->c');
    assert.equal(m, '<!-- khy:prefix:a_b___c -->');
  });
});
