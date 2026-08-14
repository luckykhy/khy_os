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

test('strips bare JSON with trailing tag fragment after closing brace (stream truncation)', () => {
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('{"name": "Read", "params": {"path": "x"}} =Read>', ON),
    ''
  );
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('"name": "Read", "params": {"path": "x"}} =Read>', ON),
    ''
  );
  assert.strictEqual(
    tcn.stripInlineToolCallNoise('{"name": "Read", "params": {"path": "C:/Users/25789/README.md"}} =Read>', ON),
    ''
  );
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
// Truncated / malformed tag fragments (real leak from stepfun step-3.5-flash
// screenshot: '<' swallowed at a chunk boundary + non-standard `}}` ending).
// ---------------------------------------------------------------------------

test('strips real leak sample: prefix-less function line + malformed <arguments={…}} line', () => {
  const input = [
    'function=webSearch>',
    '<arguments={"query":"GitHub Vue.js repository languages .vue files JavaScript TypeScript statistics","freshness":"year"}}',
    '正常文本',
  ].join('\n');
  const out = tcn.stripInlineToolCallNoise(input, ON);
  assert.strictEqual(out.trim(), '正常文本');
});

test('strips function fragment line variants (missing < / missing > / both)', () => {
  for (const frag of ['function=webSearch>', '<function=webSearch', 'function=webSearch', '</function=web.Search>']) {
    const out = tcn.stripInlineToolCallNoise(`前文\n${frag}\n后文`, ON);
    assert.strictEqual(out, '前文\n后文', `fragment: ${frag}`);
  }
});

test('strips <arguments={…} single-line variants regardless of ending', () => {
  for (const line of [
    '<arguments={"q":"x"}>',
    '<arguments={"q":"x"}}',
    '<arguments={"q":"x"}',
    'arguments={"q":"x"}}',
  ]) {
    const out = tcn.stripInlineToolCallNoise(`a\n${line}\nb`, ON);
    assert.strictEqual(out, 'a\nb', `line: ${line}`);
  }
});

test('swallows a multi-line <arguments={ JSON body until its closing brace', () => {
  const input = [
    '前文',
    '<arguments={',
    '"query": "x",',
    '"freshness": "year"',
    '}}',
    '后文',
  ].join('\n');
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), '前文\n后文');
});

test('multi-line arguments swallow stops at an obvious prose line (guard)', () => {
  const input = '<arguments={"q": "x",\n这是普通正文行';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), '这是普通正文行');
});

test('strips orphan </arguments> / <parameter=…> / </parameter> fragment lines', () => {
  const input = 'a\n</arguments>\n<parameter=path>\n</parameter>\nb';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), 'a\nb');
});

test('does NOT strip prose merely containing function= mid-sentence', () => {
  const input = '这是一个 function=add 的示例';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

test('fragment forms inside a fenced block are preserved', () => {
  const input = '```\nfunction=webSearch>\n<arguments={"q":1}}\n```';
  assert.strictEqual(tcn.stripInlineToolCallNoise(input, ON), input);
});

// ---------------------------------------------------------------------------
// splitPendingToolTag — streaming cross-chunk suspension pure helper.
// ---------------------------------------------------------------------------

test('splitPendingToolTag: holds a chunk cut at <fun', () => {
  const r = tcn.splitPendingToolTag('答案前文 <fun');
  assert.strictEqual(r.emit, '答案前文 ');
  assert.strictEqual(r.pending, '<fun');
});

test('splitPendingToolTag: holds a chunk cut inside <arguments={"q', () => {
  const r = tcn.splitPendingToolTag('正文<arguments={"q');
  assert.strictEqual(r.emit, '正文');
  assert.strictEqual(r.pending, '<arguments={"q');
});

test('splitPendingToolTag: closing-tag and tool_call prefixes are held too', () => {
  assert.strictEqual(tcn.splitPendingToolTag('x</functi').pending, '</functi');
  assert.strictEqual(tcn.splitPendingToolTag('x<tool_ca').pending, '<tool_ca');
  assert.strictEqual(tcn.splitPendingToolTag('x<').pending, '<');
});

test('splitPendingToolTag: plain prose with < is NOT held (a < b)', () => {
  const r = tcn.splitPendingToolTag('a < b');
  assert.strictEqual(r.emit, 'a < b');
  assert.strictEqual(r.pending, '');
});

test('splitPendingToolTag: completed tag (has >) is NOT held', () => {
  const r = tcn.splitPendingToolTag('x<function=web>');
  assert.strictEqual(r.emit, 'x<function=web>');
  assert.strictEqual(r.pending, '');
});

test('splitPendingToolTag: over-long suspect tail is released (release valve)', () => {
  const long = '<arguments={"q":"' + 'y'.repeat(3000);
  const r = tcn.splitPendingToolTag('前文' + long);
  assert.strictEqual(r.emit, '前文' + long);
  assert.strictEqual(r.pending, '');
});

test('splitPendingToolTag: empty / non-string → emit-all no pending', () => {
  assert.deepStrictEqual(tcn.splitPendingToolTag(''), { emit: '', pending: '' });
  assert.deepStrictEqual(tcn.splitPendingToolTag(null), { emit: '', pending: '' });
});

// ---------------------------------------------------------------------------
// Gate OFF — byte-identical passthrough.
// ---------------------------------------------------------------------------

test('gate off: passthrough byte-identical for leaked forms', () => {
  const leak = '{"name": "open_app", "params": {"name": "夸克"}}\n<function=x>\n</function>\nfunction=webSearch>\n<arguments={"q":1}}';
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
