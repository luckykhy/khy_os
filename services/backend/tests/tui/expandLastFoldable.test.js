'use strict';

/**
 * expandLastFoldable — unit coverage for the Ctrl+O "expand committed turn"
 * support (Ink mode). Exercises the PURE, React-free helpers that pick the
 * target turn and build the synthetic `expansion` message. The render side
 * (MessageBlock role:'expansion') is covered by the ink render smoke test;
 * here we lock the selection/build contract that drives it.
 *
 * Runnable under both jest (describe/test/expect) and `node --test` via the
 * tiny shim below, because this checkout ships no jest binary.
 */

const { selectLastFoldableMessage, buildExpansionMessage } = require('../../src/cli/tui/hooks/useQueryBridge');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeTruthy: () => assert.ok(actual),
  });
}

/* ── fixtures ───────────────────────────────────────────────────────────── */
const userMsg = (content) => ({ role: 'user', content });
const toolStep = (name, text) => ({ name, result: { text, success: true } });
const assistantWithTools = (text, tools) => ({
  role: 'assistant',
  selfRender: true,
  timeline: [
    { type: 'text', text },
    { type: 'tools', tools },
  ],
});
const assistantPlainText = (text) => ({
  role: 'assistant',
  selfRender: true,
  timeline: [{ type: 'text', text }],
});
const assistantLegacyTools = (tools) => ({ role: 'assistant', tools });

_describe('selectLastFoldableMessage', () => {
  _test('returns null for an empty / non-array transcript', () => {
    _expect(selectLastFoldableMessage([])).toBeNull();
    _expect(selectLastFoldableMessage(null)).toBeNull();
    _expect(selectLastFoldableMessage(undefined)).toBeNull();
  });

  _test('returns null when no assistant turn carries foldable detail', () => {
    const msgs = [userMsg('hi'), assistantPlainText('just prose, no tools')];
    _expect(selectLastFoldableMessage(msgs)).toBeNull();
  });

  _test('picks the MOST RECENT assistant turn that has a tool process group', () => {
    const older = assistantWithTools('first', [toolStep('shell', 'dir A')]);
    const newer = assistantWithTools('second', [toolStep('shell', 'dir B')]);
    const msgs = [userMsg('a'), older, userMsg('b'), newer, userMsg('c'), assistantPlainText('no tools here')];
    // scans from the end → newer is the last assistant WITH foldable detail.
    _expect(selectLastFoldableMessage(msgs)).toBe(newer);
  });

  _test('recognizes folded thinking as foldable even without tools', () => {
    const thinking = { role: 'assistant', timeline: [{ type: 'thinking', text: 'reasoning…' }] };
    _expect(selectLastFoldableMessage([userMsg('a'), thinking])).toBe(thinking);
  });

  _test('recognizes legacy (timeline-less) tools array', () => {
    const legacy = assistantLegacyTools([toolStep('grep', 'match')]);
    _expect(selectLastFoldableMessage([legacy])).toBe(legacy);
  });

  _test('skips synthetic expansion items so repeated Ctrl+O targets the real turn', () => {
    const real = assistantWithTools('ran', [toolStep('shell', 'dir')]);
    const priorExpansion = { role: 'expansion', timeline: [{ type: 'tools', tools: [toolStep('shell', 'dir')] }] };
    const msgs = [real, priorExpansion];
    // expansion role is not 'assistant' → skipped; selection falls back to `real`.
    _expect(selectLastFoldableMessage(msgs)).toBe(real);
  });
});

_describe('buildExpansionMessage', () => {
  _test('returns null when the target is not foldable', () => {
    _expect(buildExpansionMessage(assistantPlainText('prose'), 123)).toBeNull();
    _expect(buildExpansionMessage(null, 123)).toBeNull();
  });

  _test('carries ONLY the foldable timeline entries (drops prose text)', () => {
    const tools = [toolStep('shell', 'dir output')];
    const target = assistantWithTools('the answer prose', tools);
    const exp = buildExpansionMessage(target, 999);
    _expect(exp.role).toBe('expansion');
    _expect(exp.timestamp).toBe(999);
    // text entry stripped; only the tools group survives.
    _expect(exp.timeline).toEqual([{ type: 'tools', tools }]);
  });

  _test('keeps folded thinking entries', () => {
    const target = {
      role: 'assistant',
      timeline: [{ type: 'text', text: 'hi' }, { type: 'thinking', text: 'why' }],
    };
    const exp = buildExpansionMessage(target, 1);
    _expect(exp.timeline).toEqual([{ type: 'thinking', text: 'why' }]);
  });

  _test('falls back to the legacy tools array when there is no timeline', () => {
    const tools = [toolStep('grep', 'm')];
    const exp = buildExpansionMessage(assistantLegacyTools(tools), 7);
    _expect(exp.timeline).toBe(undefined);
    _expect(exp.tools).toBe(tools);
  });

  _test('defaults timestamp to 0 (purity — caller injects the real clock)', () => {
    const exp = buildExpansionMessage(assistantWithTools('x', [toolStep('shell', 'o')]));
    _expect(exp.timestamp).toBe(0);
  });
});
