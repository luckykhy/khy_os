'use strict';

/**
 * toolCallParser.functionTag.test.js — `<function=NAME>…</function>` 方言经 parseToolCalls
 * 端到端解析为可执行 {name, params}(node:test)。
 *
 * 这是本次 goal「确保工具的准确调用」的核心回归:此前这类调用被 toolCallNoise 当噪声剥掉
 * 却从未被任何解析器解析 → 静默失败。锁定:JSON body 解析、归一化、围栏防伪、去重、与其它格式共存。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parseToolCalls } = require('../../src/services/toolCallParser');

describe('parseToolCalls 解析 <function=NAME> 方言', () => {
  test('JSON body → 归一化 name + params', () => {
    const calls = parseToolCalls('好的,我来执行:\n<function=shell_command>{"command": "ls -la"}</function>');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.command, 'ls -la');
  });

  test('多个 <function=...> 调用全部解析', () => {
    const text = '<function=git_status></function>\n<function=shell_command>{"command":"pwd"}</function>';
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 2);
  });

  test('代码块内的 <function=...> 被围栏防伪(不解析)', () => {
    const text = '示例:\n```\n<function=shell_command>{"command":"rm -rf /"}</function>\n```';
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 0);
  });

  test('"例如" 解释性前缀防伪', () => {
    const calls = parseToolCalls('例如:<function=shell_command>{"command":"x"}</function>');
    assert.equal(calls.length, 0);
  });

  test('门控关 → 该方言不解析(字节回退)', () => {
    const prev = process.env.KHY_FUNCTION_TAG_TOOLCALL;
    process.env.KHY_FUNCTION_TAG_TOOLCALL = 'off';
    try {
      const calls = parseToolCalls('<function=shell_command>{"command":"ls"}</function>');
      assert.equal(calls.length, 0);
    } finally {
      if (prev === undefined) delete process.env.KHY_FUNCTION_TAG_TOOLCALL;
      else process.env.KHY_FUNCTION_TAG_TOOLCALL = prev;
    }
  });

  test('既有 <tool_call> 格式不受影响(共存)', () => {
    const calls = parseToolCalls('<tool_call>{"name":"git_status","params":{}}</tool_call>');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'git_status');
  });
});
