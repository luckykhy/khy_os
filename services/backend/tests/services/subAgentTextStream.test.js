'use strict';

const test = require('node:test');
const assert = require('node:assert');

const s = require('../../src/services/subAgentTextStream');

test('isEnabled: default-on; only FALSY {0,false,off,no} disables', () => {
  assert.strictEqual(s.isEnabled({}), true);
  assert.strictEqual(s.isEnabled({ KHY_SUBAGENT_TEXT_STREAM: undefined }), true);
  assert.strictEqual(s.isEnabled({ KHY_SUBAGENT_TEXT_STREAM: 'true' }), true);
  assert.strictEqual(s.isEnabled({ KHY_SUBAGENT_TEXT_STREAM: 'on' }), true);
  assert.strictEqual(s.isEnabled({ KHY_SUBAGENT_TEXT_STREAM: '1' }), true);
  assert.strictEqual(s.isEnabled({ KHY_SUBAGENT_TEXT_STREAM: '0' }), false);
  assert.strictEqual(s.isEnabled({ KHY_SUBAGENT_TEXT_STREAM: 'false' }), false);
  assert.strictEqual(s.isEnabled({ KHY_SUBAGENT_TEXT_STREAM: 'off' }), false);
  assert.strictEqual(s.isEnabled({ KHY_SUBAGENT_TEXT_STREAM: 'no' }), false);
});

test('textFromChunk: only {type:text,text} and bare strings; ignores other shapes', () => {
  assert.strictEqual(s.textFromChunk({ type: 'text', text: 'hello' }), 'hello');
  assert.strictEqual(s.textFromChunk('bare'), 'bare');
  assert.strictEqual(s.textFromChunk({ type: 'assistant_preface', text: 'x' }), '');
  assert.strictEqual(s.textFromChunk({ type: 'tool_use', name: 'Read' }), '');
  assert.strictEqual(s.textFromChunk({ type: 'text', text: 123 }), '');
  assert.strictEqual(s.textFromChunk(null), '');
  assert.strictEqual(s.textFromChunk(undefined), '');
  assert.strictEqual(s.textFromChunk(42), '');
});

test('appendDelta: pure append, never mutates, ignores empty', () => {
  assert.strictEqual(s.appendDelta('ab', 'cd'), 'abcd');
  assert.strictEqual(s.appendDelta('', 'x'), 'x');
  assert.strictEqual(s.appendDelta('x', ''), 'x');
  assert.strictEqual(s.appendDelta('x', null), 'x');
  assert.strictEqual(s.appendDelta(null, 'x'), 'x');
  assert.strictEqual(s.appendDelta(undefined, undefined), '');
});

test('appendDelta: bounded buffer keeps only the tail (cap 2000)', () => {
  const big = 'a'.repeat(2500);
  const out = s.appendDelta('', big);
  assert.strictEqual(out.length, 2000);
  // tail preserved, head dropped
  const out2 = s.appendDelta('z'.repeat(1999), 'X'.repeat(10));
  assert.strictEqual(out2.length, 2000);
  assert.ok(out2.endsWith('X'.repeat(10)));
});

test('previewLine: last non-empty line, whitespace-collapsed, trimmed', () => {
  assert.strictEqual(s.previewLine('first line\nsecond line'), 'second line');
  assert.strictEqual(s.previewLine('only line'), 'only line');
  assert.strictEqual(s.previewLine('tail\n\n   '), 'tail'); // trailing blank lines skipped
  assert.strictEqual(s.previewLine('  multiple   spaces   here  '), 'multiple spaces here');
  assert.strictEqual(s.previewLine(''), '');
  assert.strictEqual(s.previewLine('\n\n\n'), '');
  assert.strictEqual(s.previewLine(null), '');
});

test('previewLine: clips to max with ellipsis', () => {
  const long = 'x'.repeat(200);
  const out = s.previewLine(long, 72);
  assert.strictEqual(out.length, 72);
  assert.ok(out.endsWith('…'));
  // custom max
  assert.strictEqual(s.previewLine('abcdef', 4), 'abc…');
  // short stays intact
  assert.strictEqual(s.previewLine('abc', 72), 'abc');
});

test('buildAgentTextEvent: normalized shape', () => {
  assert.deepStrictEqual(s.buildAgentTextEvent('hi'), { type: 'agent_text', text: 'hi' });
  assert.deepStrictEqual(s.buildAgentTextEvent(null), { type: 'agent_text', text: '' });
});

test('end-to-end coalesce: token stream → stable preview deltas', () => {
  // Simulate a sub-agent streaming tokens; mirror the AgentTool forwarder logic.
  let buf = '';
  let last = '';
  const emitted = [];
  const tokens = [
    { type: 'text', text: 'Analyz' },
    { type: 'text', text: 'ing the ' },
    { type: 'tool_use', name: 'Read' }, // ignored
    { type: 'text', text: 'repo.\nNow ' },
    { type: 'text', text: 'reading server.js' },
  ];
  for (const chunk of tokens) {
    const delta = s.textFromChunk(chunk);
    if (!delta) continue;
    buf = s.appendDelta(buf, delta);
    const preview = s.previewLine(buf);
    if (preview && preview !== last) { last = preview; emitted.push(preview); }
  }
  assert.deepStrictEqual(emitted, [
    'Analyz',
    'Analyzing the',
    'Now',
    'Now reading server.js',
  ]);
});

test('determinism: same buffer → same preview', () => {
  const a = s.previewLine('alpha\nbeta gamma');
  const b = s.previewLine('alpha\nbeta gamma');
  assert.strictEqual(a, b);
});

test('describeSubAgentTextStream: stable self-describe', () => {
  const d = s.describeSubAgentTextStream();
  assert.strictEqual(d.gate, 'KHY_SUBAGENT_TEXT_STREAM');
  assert.strictEqual(d.defaultOn, true);
  assert.strictEqual(d.bufferCap, 2000);
  assert.strictEqual(d.previewMax, 72);
  assert.ok(typeof d.summary === 'string' && d.summary.length > 0);
});

test('never throws on hostile input', () => {
  assert.doesNotThrow(() => s.appendDelta({}, {}));
  assert.doesNotThrow(() => s.previewLine({}));
  assert.doesNotThrow(() => s.textFromChunk(Object.create(null)));
  assert.doesNotThrow(() => s.isEnabled(null));
});
