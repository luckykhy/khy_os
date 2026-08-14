'use strict';

/**
 * toolProtocolAdapter.textInterception.test.js — 「非原生工具调用的模型靠 khy agent 工程
 * 拦截层实现工具调用」的端到端接线锁定(node:test)。
 *
 * 目标(/goal):不会原生 function calling 的模型,其**纯文本**输出经文本协议适配器
 * (toolUseLoop 在文本协议下调 `_activeAdapter.parseToolCalls`;native 协议无结构化块时经
 * 同源 toolCallParser 回退)被拦截、还原成可执行的 canonical {name, params},再由
 * formatToolResults 把结果以纯文本回灌 → 模型据此续轮。本套件锁定拦截 seam 本身。
 *
 * 现场依据:sensenova-6.7-flash-lite(名字含 lite/flash 被判缺原生工具调用)吐 Claude-Code
 * 风格 `Bash\n{"command":...,"timeoutMs":...}` 而非教学的 <tool_call>。此前拦截层不识别 →
 * 显示不执行。现经 toolCallParser Format 2c 还原 → 本测证明它穿过拦截 seam 成为可执行调用。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const adapter = require('../../src/services/toolProtocolAdapter');

describe('文本协议拦截:非原生模型的纯文本输出 → 可执行工具调用', () => {
  test('CC 方言 Bash+JSON 经 textAdapter.parseToolCalls 还原为 shell_command', () => {
    const aiResult = { reply: '让我先看看装了哪些软件。\nBash\n{"command": "dir /b", "timeoutMs": 15000}' };
    const calls = adapter.textAdapter.parseToolCalls(aiResult);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'shell_command');
    assert.equal(calls[0].params.command, 'dir /b');
  });

  test('教学的 <tool_call> 语法照常被拦截(Read → readFile)', () => {
    const aiResult = { reply: '<tool_call>{"name":"Read","params":{"file_path":"/etc/hosts"}}</tool_call>' };
    const calls = adapter.textAdapter.parseToolCalls(aiResult);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'readFile');
    assert.equal(calls[0].params.file_path, '/etc/hosts');
  });

  test('多块 CC 方言全部还原(模型一轮吐多个工具调用)', () => {
    const aiResult = { reply: [
      'Grep', '{"pattern": "TODO", "path": "/src"}',
      'Bash', '{"command": "ls -la"}',
    ].join('\n') };
    const calls = adapter.textAdapter.parseToolCalls(aiResult);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'grep');
    assert.equal(calls[1].name, 'shell_command');
  });

  test('围栏防伪:代码块内的示例调用绝不被拦截执行', () => {
    const aiResult = { reply: '示例格式:\n```Bash\n{"command": "rm -rf /"}\n```' };
    assert.equal(adapter.textAdapter.parseToolCalls(aiResult).length, 0);
  });

  test('回灌闭环:formatToolResults 把执行结果转成纯文本供模型续轮', () => {
    const out = adapter.textAdapter.formatToolResults([
      { tool: 'shell_command', result: { success: true, output: 'a.exe\nb.exe' } },
    ]);
    assert.equal(typeof out.text, 'string');
    assert.ok(out.text.length > 0);
    assert.equal(out.structuredBlocks, null); // 纯文本协议:无结构化块
  });

  test('extractToolCalls 直接暴露:字符串入参亦可拦截', () => {
    const calls = adapter.extractToolCalls('Bash\n{"command": "whoami"}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.command, 'whoami');
  });
});
