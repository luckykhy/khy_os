'use strict';

/**
 * toolCallParser.bracketMarker.test.js — wire marker bracket tool call
 * (`[Tool Call: name(args)]`) dialect end-to-end parse into an executable
 * {name, params} via parseToolCalls (node:test).
 *
 * Background (field report): the gateway's "strip tools and demote to plain
 * text" wire converter (_toolSchemaConverter's hasTools=false branch) inlines
 * history tool_use blocks into `[Tool Call: name(JSON)]`, tool_result blocks
 * into `[Tool Result: id]\n…`. These markers get replayed back into text
 * protocol models, and the model just echoes them verbatim in the body
 * (observed: `[Tool Call: shell_command({})]` bare in the transcript, neither
 * parsed and executed nor rendered as a tool line — user reported "tools are
 * bare and can't be copied"). This suite locks in: marker parsing (name
 * normalization + JSON/KV arguments), empty-argument markers, multi-line JSON
 * argument bodies, coexistence of multiple markers, fence false-positive
 * prevention, and coexistence with <tool_call> tags without duplication.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { parseToolCalls } = require('../../src/services/toolCallParser');

describe('parseToolCalls parses `[Tool Call: name(args)]` wire markers', () => {
  test('field single marker: shell_command empty args → executable call', () => {
    const calls = parseToolCalls('[Tool Call: shell_command({})]');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'shell_command');
    assert.deepEqual(calls[0].params, {});
  });

  test('marker with JSON args parses fully (timeoutMs coerced to number)', () => {
    const calls = parseToolCalls(
      '[Tool Call: shellCommand({"command":"dir /b","timeoutMs":15000})]'
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'shell_command');
    assert.equal(calls[0].params.command, 'dir /b');
    assert.equal(calls[0].params.timeoutMs, 15000);
  });

  test('name normalization: Bash alias → shell_command', () => {
    const calls = parseToolCalls('[Tool Call: Bash({"command":"ls -la"})]');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'shell_command');
    assert.equal(calls[0].params.command, 'ls -la');
  });

  test('multi-line JSON arg body is taken as a whole (not truncated at first paren)', () => {
    const calls = parseToolCalls(
      '[Tool Call: Read({\n  "file_path": "/a/b.txt",\n  "note": "keep (parens)"\n})]'
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'readFile');
    assert.equal(calls[0].params.file_path, '/a/b.txt');
    assert.equal(calls[0].params.note, 'keep (parens)');
  });

  test('two markers in one turn both collected', () => {
    const calls = parseToolCalls(
      '[Tool Call: shell_command({"command":"dir"})]\ndone\n[Tool Call: open_app({"name":"夸克"})]'
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.name), ['shell_command', 'open_app']);
    assert.equal(calls[1].params.name, '夸克');
  });

  test('duplicate markers dedup (same tool + same params)', () => {
    const calls = parseToolCalls(
      '[Tool Call: shell_command({"command":"dir"})]\n[Tool Call: shell_command({"command":"dir"})]'
    );
    assert.equal(calls.length, 1);
  });

  test('fence false-positive prevention: fenced example not executed', () => {
    assert.equal(parseToolCalls('示例:\n```\n[Tool Call: shell_command({"command":"rm -rf /"})]\n```').length, 0);
    assert.equal(
      parseToolCalls('example:\n```js\n[Tool Call: Read({"file_path":"/x"})]\n```').length,
      0
    );
  });

  test('coexists with <tool_call> tag: tag hit and no duplication', () => {
    const text =
      '<tool_call>{"name":"Read","params":{"file_path":"/x"}}</tool_call>\n[Tool Call: shell_command({"command":"dir"})]';
    const calls = parseToolCalls(text);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].name, 'readFile');
    assert.equal(calls[1].name, 'shell_command');
  });

  test('non-identifier after the colon is not treated as a marker', () => {
    // `[Tool Call: see §3(a)]` — the name character class excludes CJK / punctuation,
    // so the line stays inert prose (no crash, no bogus call).
    const calls = parseToolCalls('参考 [Tool Call: 见第3(a)节] 的内容');
    assert.equal(calls.length, 0);
  });
});
