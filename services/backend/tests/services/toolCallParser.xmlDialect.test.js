'use strict';

/**
 * toolCallParser.xmlDialect.test.js — Claude/Codex 风格 XML 工具方言经 parseToolCalls
 * 端到端解析为可执行 {name, params}(node:test)。
 *
 * 背景(现场复现):弱模型(sensenova-6.8-flash-lite)按 Claude/Codex 语料把工具调用写成
 * 嵌套 XML ——
 *     <tool_call>
 *     <Write>
 *     <args>
 *     <file_path>C:\...\x.html</file_path>
 *     <content>…整段 HTML…</content>
 *     </args>
 *     </Write>
 *     </tool_call>
 * 而非教学的 <tool_call>{json}</tool_call>。此前任何格式都不解析它 → 惰性文本、Write/Read
 * 从未执行,整块裸标签泄进正文。本套件锁定:Write/Read 解析、多行 HTML content 保留、
 * 缺省 </tool_call> 闭合、参数标量(coerceValue)、围栏防伪(fenced 示例绝不执行)、
 * 普通文本不误判、与 JSON 形式共存不重复。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parseToolCalls } = require('../../src/services/toolCallParser');

const HTML_CONTENT = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head>',
  '    <title>测试</title>',
  '    <style>body { margin: 0; }</style>',
  '</head>',
  '<body>',
  '    <p>这是<strong>加粗</strong>的段落。</p>',
  '</body>',
  '</html>',
].join('\n');

describe('parseToolCalls 解析 Claude/Codex XML 工具方言', () => {
  test('Write 带整段 HTML content → writeFile,内容完整保留', () => {
    const text = [
      '<tool_call>',
      '<Write>',
      '<args>',
      '<file_path>C:\\Users\\25789\\Desktop\\html-practice.html</file_path>',
      '<content>',
      HTML_CONTENT,
      '</content>',
      '</args>',
      '</Write>',
      '</tool_call>',
    ].join('\n');
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'writeFile');
    assert.equal(calls[0].params.file_path, 'C:\\Users\\25789\\Desktop\\html-practice.html');
    assert.equal(calls[0].params.content, HTML_CONTENT, 'content 逐字节保留');
    assert.ok(calls[0].params.content.includes('<strong>加粗</strong>'), '嵌套标签原样保留');
  });

  test('Read 缺省 </tool_call> 闭合(实测模型直接以 </Read> 收尾)', () => {
    const text = [
      '这是第三轮，验证文件并给你使用说明。',
      '<tool_call>',
      '<Read>',
      '<args>',
      '<file_path>C:\\Users\\25789\\Desktop\\html-practice.html</file_path>',
      '<timeoutMs>5000</timeoutMs>',
      '</args>',
      '</Read>',
    ].join('\n');
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'readFile');
    assert.equal(calls[0].params.file_path, 'C:\\Users\\25789\\Desktop\\html-practice.html');
    assert.equal(calls[0].params.timeoutMs, 5000, 'timeoutMs 标量转为数字');
  });

  test('围栏防伪:```xml 代码块内的教学示例绝不执行', () => {
    const text = [
      '格式如下：',
      '```xml',
      '<tool_call>',
      '<Read>',
      '<args>',
      '<file_path>a.txt</file_path>',
      '</args>',
      '</Read>',
      '</tool_call>',
      '```',
      '然后我总结。',
    ].join('\n');
    assert.equal(parseToolCalls(text).length, 0);
  });

  test('普通 XML 文本(无 <args>)不误判', () => {
    assert.equal(parseToolCalls('这是普通文本 <div>hello</div> 结束').length, 0);
    assert.equal(parseToolCalls('<tool_call>不是工具</tool_call>').length, 0);
  });

  test('与 JSON 形式共存不重复(同名同参去重)', () => {
    const text = [
      '<tool_call>{"name": "Read", "params": {"file_path": "x.txt"}}</tool_call>',
      '<tool_call>',
      '<Read>',
      '<args>',
      '<file_path>x.txt</file_path>',
      '</args>',
      '</Read>',
      '</tool_call>',
    ].join('\n');
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 1, 'JSON 与 XML 同参只执行一次');
  });
});
