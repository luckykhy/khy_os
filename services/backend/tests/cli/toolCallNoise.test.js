'use strict';

// Unit tests for the inline tool-call NOISE stripper pure leaf.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const tcn = require('../../src/cli/toolCallNoise');

const ON = { KHY_TOOLCALL_NOISE_STRIP: '1' };
const OFF = { KHY_TOOLCALL_NOISE_STRIP: 'off' };

// ---------------------------------------------------------------------------
// isEnabled — gate ladder (default ON).
// ---------------------------------------------------------------------------

test('isEnabled: unset → on', () => {
  assert.strictEqual(tcn.isEnabled({}), true);
  assert.strictEqual(tcn.isEnabled(undefined), true);
});

test('isEnabled: explicit off tokens → off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(tcn.isEnabled({ KHY_TOOLCALL_NOISE_STRIP: v }), false, `value ${v}`);
  }
});

// ---------------------------------------------------------------------------
// The exact leaked forms from the user's screenshot.
// ---------------------------------------------------------------------------

test('strips bare {"name":...,"params":...} JSON line (open_app / 夸克)', () => {
  const input = [
    '让我换个方式,直接用 open_app 工具来启动夸克。',
    '',
    '{"name": "open_app", "params": {"name": "夸克"}}',
    '',
    '现在启动它。',
  ].join('\n');
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.doesNotMatch(out, /\{"name"/);
  assert.match(out, /让我换个方式/);
  assert.match(out, /现在启动它/);
});

test('strips bare JSON with "command" params (Bash / reg query)', () => {
  const input = '{"name": "Bash", "params": {"command": "reg query \\"HKEY_CURRENT_USER\\\\...\\" /s"}}';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), '');
});

test('strips arguments/input key variants too', () => {
  assert.strictEqual(tcn.stripInlineToolCallNoise('{"name": "Read", "arguments": {"path": "/x"}}', ON), '');
  assert.strictEqual(tcn.stripInlineToolCallNoise('{"name": "Read", "input": {"path": "/x"}}', ON), '');
});

test('strips paired <function=NAME> … </function> block incl. inner lines', () => {
  const input = [
    '前言。',
    '<function=shell_command>',
    'whatever inner garbage',
    '</function>',
    '后语。',
  ].join('\n');
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.doesNotMatch(out, /<function/);
  assert.doesNotMatch(out, /<\/function>/);
  assert.doesNotMatch(out, /inner garbage/);
  assert.match(out, /前言/);
  assert.match(out, /后语/);
});

test('strips standalone empty <function=open_app></function> pair (separate lines)', () => {
  const input = [
    '{"name": "open_app", "params": {"name": "夸克"}}',
    '<function=open_app>',
    '</function>',
  ].join('\n');
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON).trim(), '');
});

test('strips a stray closing </function> with no opener', () => {
  const input = 'hello\n</function>\nworld';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), 'hello\nworld');
});

test('strips a single-line <function=x>…</function> pair, keeps surrounding text', () => {
  const input = 'before <function=x>{"a":1}</function> after';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), 'before  after');
});

// ---------------------------------------------------------------------------
// Load-bearing guard: fenced code blocks are sacred.
// ---------------------------------------------------------------------------

test('preserves identical JSON INSIDE a ``` fenced code block', () => {
  const input = [
    '示例配置:',
    '```json',
    '{"name": "open_app", "params": {"name": "夸克"}}',
    '```',
  ].join('\n');
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.match(out, /\{"name": "open_app"/);
  assert.match(out, /```json/);
});

test('preserves a <function=…> example inside a fenced block', () => {
  const input = '```\n<function=demo>\nx\n</function>\n```';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// Precision: prose / normal markdown untouched.
// ---------------------------------------------------------------------------

test('does NOT strip prose that merely contains braces / the word name', () => {
  const input = 'The config has a name field and params like {"x": 1} embedded mid-sentence.';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

test('does NOT strip a JSON object missing the params/arguments/input key', () => {
  const input = '{"name": "foo", "value": 42}';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

test('normal markdown (headings/list/bold) passes through byte-identical', () => {
  const input = '# Title\n\n- item one\n- **bold** item\n\nA paragraph.';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// Streaming-partial safety: a half-arrived object is left alone.
// ---------------------------------------------------------------------------

test('partial (unclosed) bare JSON is NOT stripped (waits for completion)', () => {
  const input = '{"name": "open_a';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// Gate OFF — byte-identical passthrough.
// ---------------------------------------------------------------------------

test('gate off: passthrough byte-identical for leaked forms', () => {
  const leak = '{"name": "open_app", "params": {"name": "夸克"}}\n<function=x>\n</function>';
  assert.strictEqual(tcn.stripInlineToolCallNoise(leak, OFF), leak);
});

test('non-string / empty → returned unchanged', () => {
  assert.strictEqual(tcn.stripInlineToolCallNoise('', ON), '');
  assert.strictEqual(tcn.stripInlineToolCallNoise(null, ON), null);
  assert.strictEqual(tcn.stripInlineToolCallNoise(undefined, ON), undefined);
  assert.strictEqual(tcn.stripInlineToolCallNoise(42, ON), 42);
});

// ---------------------------------------------------------------------------
// Blank-run handling: the leaf does NOT collapse (fence-unaware collapse would
// eat code-block blanks); it leaves blank runs for the fence-aware caller.
// ---------------------------------------------------------------------------

test('removes the noise line, keeps neighbours; leaves blank run for caller to collapse', () => {
  const input = 'a\n\n{"name": "Bash", "params": {"x":1}}\n\nb';
  // line removed → 'a','','','b' — leaf does NOT collapse the resulting \n\n\n.
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.doesNotMatch(out, /\{"name"/);
  assert.strictEqual(out, 'a\n\n\nb');
});

test('does NOT collapse blank runs inside a fenced code block (fence-safe)', () => {
  const input = '```\nline1\n\n\nline2\n```';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});
