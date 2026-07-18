'use strict';

/**
 * toolCallParser.duplicateCollapse.test.js — Format 1(JSON-style <tool_call>{...}</tool_call>)
 * 精确重复调用折叠契约(node:test)。
 *
 * 背景(现场复现):弱模型(api:agnes:agnes-2.0-flash · khy OS v0.1.165)在单次 completion 里把整段
 * 输出重复两遍(A+A)。当 A 含一个 <tool_call>{JSON}</tool_call> 工具调用时,doubling 产生两个逐字
 * 相同的调用(如 local_knowledge 同 query),二者落入同一并行批次、在 executedCallKeys 记录首个之前
 * 都读到空 Map → 双双执行、双双失败 → 用户看到「搜索过程重复两次」。
 *
 * 根因是格式不对称:Format 2(func-call)与 Format 2b(<function=>)早有「same tool+same params」
 * 去重,唯 Format 1(JSON)缺失。本套件锁定 Format 1 现已与兄弟对称:精确重复折叠为一个,
 * 参数不同的调用逐字保留(非精确输入 byte-behavior 不变)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parseToolCalls } = require('../../src/services/toolCallParser');

const tc = (obj) => `<tool_call>${JSON.stringify(obj)}</tool_call>`;

describe('parseToolCalls Format 1 精确重复折叠', () => {
  test('两个逐字相同的 local_knowledge 调用(A+A doubling)→ 折叠为一个', () => {
    const one = tc({ name: 'local_knowledge', params: { query: '云南省曲靖市 旅游景点 好玩的地方' } });
    const calls = parseToolCalls(one + '\n' + one);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.query, '云南省曲靖市 旅游景点 好玩的地方');
  });

  test('两个相同的 Bash JSON 调用 → 折叠为一个', () => {
    const one = tc({ name: 'Bash', params: { command: 'ls -la' } });
    const calls = parseToolCalls(one + one);
    assert.equal(calls.length, 1);
  });

  test('参数不同 → 两个都保留(合法多步,不误折叠)', () => {
    const text =
      tc({ name: 'local_knowledge', params: { query: '曲靖 景点' } }) +
      tc({ name: 'local_knowledge', params: { query: '昆明 美食' } });
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.params.query), ['曲靖 景点', '昆明 美食']);
  });

  test('同名不同工具间不误折叠(name 不同)', () => {
    const text =
      tc({ name: 'local_knowledge', params: { query: 'x' } }) +
      tc({ name: 'web_search', params: { query: 'x' } });
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 2);
  });

  test('单个调用 → 原样(byte-behavior 不变)', () => {
    const calls = parseToolCalls(tc({ name: 'Read', params: { file_path: '/a/b.txt' } }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.file_path, '/a/b.txt');
  });

  test('三个相同调用(A+A+A)→ 全部折叠为一个', () => {
    const one = tc({ name: 'local_knowledge', params: { query: 'dup' } });
    const calls = parseToolCalls(one + one + one);
    assert.equal(calls.length, 1);
  });

  test('两个相同 + 一个不同 → 去重后剩两个', () => {
    const dup = tc({ name: 'local_knowledge', params: { query: 'same' } });
    const other = tc({ name: 'local_knowledge', params: { query: 'other' } });
    const calls = parseToolCalls(dup + other + dup);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.params.query).sort(), ['other', 'same']);
  });
});
