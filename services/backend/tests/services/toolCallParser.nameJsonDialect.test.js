'use strict';

/**
 * toolCallParser.nameJsonDialect.test.js — Claude-Code-style「工具名 header 行 + JSON 参数对象」
 * 方言经 parseToolCalls 端到端解析为可执行 {name, params}(node:test)。
 *
 * 背景(现场复现):弱模型(sensenova-6.7-flash-lite 这类被判缺乏原生工具调用、走文本协议的
 * 全尺寸小名模型)常被 CC transcript 微调,把工具调用打成
 *     Bash
 *     {"command": "dir C:\\", "timeoutMs": 15000}
 * 而非教学的 <tool_call>{...}</tool_call>。此前任何格式都不解析它 → 渲染成惰性文本、永不执行
 *(用户报告「显示了命令但是不会执行」)。本套件锁定:名+JSON 解析、多块收集、多行 body、
 * 归一化(Bash→shell_command)、围栏防伪(fenced 例子绝不执行)、非白名单 header 不误触发、
 * 与 <tool_call> 标签共存不重复。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parseToolCalls, scanBalancedObject } = require('../../src/services/toolCallParser');

describe('parseToolCalls 解析「工具名 + JSON」方言', () => {
  test('现场单块:Bash header + JSON → shell_command', () => {
    const text = '让我先看看你电脑上装了哪些软件。\nBash\n{"command": "dir /b", "timeoutMs": 15000}';
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'shell_command');
    assert.equal(calls[0].params.command, 'dir /b');
    assert.equal(calls[0].params.timeoutMs, 15000);
  });

  test('连续三块全部收集(截图第二轮)', () => {
    const text = [
      'Bash', '{"command": "dir A", "timeoutMs": 15000}',
      'Bash', '{"command": "dir B", "timeoutMs": 10000}',
      'Bash', '{"command": "dir C", "timeoutMs": 10000}',
    ].join('\n');
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.params.command), ['dir A', 'dir B', 'dir C']);
    assert.ok(calls.every((c) => c.name === 'shell_command'));
  });

  test('多行 JSON body 也解析(Read → readFile)', () => {
    const calls = parseToolCalls('Read\n{\n  "file_path": "/a/b.txt"\n}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'readFile');
    assert.equal(calls[0].params.file_path, '/a/b.txt');
  });

  test('bold **Bash** header 亦解析', () => {
    const calls = parseToolCalls('**Bash**\n{"command": "ls"}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.command, 'ls');
  });

  test('围栏防伪:```Bash 代码块内不执行', () => {
    const calls = parseToolCalls('示例:\n```Bash\n{"command": "rm -rf /"}\n```');
    assert.equal(calls.length, 0);
  });

  test('围栏防伪:无语言标记的 ``` 代码块内不执行', () => {
    const calls = parseToolCalls('example:\n```\nBash\n{"command": "rm -rf /"}\n```');
    assert.equal(calls.length, 0);
  });

  test('非白名单 header(散文标题)不误触发', () => {
    assert.equal(parseToolCalls('Note\n{"foo": 1}').length, 0);
    assert.equal(parseToolCalls('Summary\n{"a": 2}').length, 0);
  });

  test('空对象跳过', () => {
    assert.equal(parseToolCalls('Bash\n{}').length, 0);
  });

  test('与 <tool_call> 标签共存:标签命中即不再走名+JSON 回退', () => {
    const text = '<tool_call>{"name":"Read","params":{"file_path":"/x"}}</tool_call>';
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'readFile');
  });

  test('scanBalancedObject:嵌套/字符串内括号不误判', () => {
    const src = 'x\n{"a": {"b": "}{"}, "c": 1}\ntail';
    assert.equal(scanBalancedObject(src), '{"a": {"b": "}{"}, "c": 1}');
    assert.equal(scanBalancedObject('no object here'), null);
    assert.equal(scanBalancedObject('{"truncated": '), null); // 不平衡 → null
  });
});
