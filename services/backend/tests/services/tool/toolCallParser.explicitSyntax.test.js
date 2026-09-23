'use strict';

/**
 * toolCallParser.explicitSyntax.test.js — hasExplicitToolCallSyntax 的划界。
 *
 * 这条判据只有一个用途:能力探测时回答「模型是不是在试图发出调用,只是走了文本通道」。
 * 它必须是**严格的**——一个错误的负面裁决会让该模型的原生 tools 从每个后续请求里被删掉,
 * 且删掉之后再也观察不到原生调用,判错就锁死(见 BUG-014)。所以这里同时钉两个方向:
 *   - 显式方言(带标签/括号/JSON 体)必须认;
 *   - 自然语言意图与「模型自述不会调用工具」必须**不**认 —— 那是证据的缺席,不是不支持。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parseToolCalls, hasExplicitToolCallSyntax } = require('../../../src/services/tool/toolCallParser');

describe('hasExplicitToolCallSyntax — 认显式方言', () => {
  const explicit = [
    ['Format 1 JSON 方言', '<tool_call>{"name":"khy_probe_echo","arguments":{"ok":"yes"}}</tool_call>'],
    ['Format 2 name(args) 方言', '<tool_call>khy_probe_echo(ok="yes")</tool_call>'],
    ['Format 2b harmony 方言', '<function=khy_probe_echo>{"ok":"yes"}</function>'],
    [
      'Format 2d 嵌套 XML 方言',
      '<tool_call><Read><args><file_path>x.js</file_path></args></Read></tool_call>',
    ],
    ['Format 2e wire marker', '[Tool Call: khy_probe_echo({"ok":"yes"})]'],
    ['Format 2c 裸名 + JSON 体', 'Read\n{"file_path": "x.js"}'],
  ];
  for (const [name, text] of explicit) {
    test(name, () => {
      assert.equal(hasExplicitToolCallSyntax(text), true, `应认作显式调用: ${name}`);
    });
  }
});

describe('hasExplicitToolCallSyntax — 不认「没在调用」的文本', () => {
  const notExplicit = [
    ['纯客套', 'Sure, I can help with that. Let me know what you need.'],
    ['模型自述不会调用工具', 'I cannot call tools, here is text.'],
    ['被截断的前言', 'I will now call the tool'],
    ['中文客套', '好的,我来处理这件事。'],
    ['空串', ''],
  ];
  for (const [name, text] of notExplicit) {
    test(name, () => {
      assert.equal(hasExplicitToolCallSyntax(text), false, `不得认作显式调用: ${name}`);
    });
  }
});

describe('与 parseToolCalls 的唯一区别就是 Format 3（自然语言）', () => {
  // 自然语言档是概率检测(syntheticToolLayer 的领域),不是「模型在试图调用」的确证。
  // 这里不强断言某个具体句子一定被 Format 3 命中——自然语言映射的覆盖率由它自己的测试
  // 负责;只钉住「显式判据不会比解析器更宽」这条不变量。
  test('显式判据 ⊆ 解析器（判据认的,解析器必须也认）', () => {
    const samples = [
      '<tool_call>{"name":"khy_probe_echo"}</tool_call>',
      '<function=khy_probe_echo>{"ok":"yes"}</function>',
      'Read\n{"file_path": "x.js"}',
      'prose only',
      'I cannot call tools',
    ];
    for (const s of samples) {
      if (hasExplicitToolCallSyntax(s)) {
        assert.ok(parseToolCalls(s).length > 0, `显式判据认了但解析器不认(会与方言漂移): ${s}`);
      }
    }
  });

  test('关掉自然语言档不影响显式方言的解析结果', () => {
    const t = '<tool_call>{"name":"khy_probe_echo","arguments":{"ok":"yes"}}</tool_call>';
    const withNl = parseToolCalls(t);
    const withoutNl = parseToolCalls(t, { disableNaturalLanguage: true });
    assert.deepEqual(withoutNl, withNl);
  });
});

describe('绝不抛', () => {
  test('junk 输入一律 false', () => {
    for (const j of [null, undefined, 42, {}, [], () => {}, Symbol('x')]) {
      assert.doesNotThrow(() => hasExplicitToolCallSyntax(j));
      assert.equal(hasExplicitToolCallSyntax(j), false);
    }
  });
});
