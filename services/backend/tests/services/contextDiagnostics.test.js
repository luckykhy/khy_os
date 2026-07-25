'use strict';

// contextDiagnostics — the framework-prescribed process-level measurement layer.
// Pure functions, no model, no network. Each failure mode must be detectable
// from structure alone, AND a healthy context must score high (no false positives).

const diag = require('../../src/services/contextDiagnostics');

function userMsg(text) { return { role: 'user', content: text }; }
function asstMsg(text) { return { role: 'assistant', content: text }; }
function toolMsg(text) { return { role: 'tool', content: text }; }

describe('contextDiagnostics.diagnoseContext', () => {
  test('a healthy multi-turn coding session scores high and flags nothing', () => {
    const messages = [
      userMsg('Add a retry wrapper around the fetch call in api.js'),
      asstMsg('I will read api.js to understand the current fetch usage.'),
      toolMsg('export async function fetchUser(id) { return fetch(`/u/${id}`); }'),
      asstMsg('Now I will add an exponential-backoff retry around the fetch.'),
      userMsg('Also make the timeout configurable via an option.'),
      asstMsg('Understood — I will thread a timeoutMs option through the wrapper.'),
    ];
    const r = diag.diagnoseContext(messages, { contextWindow: 128000 });
    expect(r.health).toBeGreaterThanOrEqual(85);
    expect(r.worst).toBeNull();
    expect(r.failureModes.overflow.level).toBe('ok');
    expect(r.failureModes.distraction.level).toBe('ok');
    expect(r.failureModes.poisoning.level).toBe('ok');
    expect(r.failureModes.confusion.level).toBe('ok');
    expect(diag.hasNonOverflowPathology(r)).toBeNull();
  });

  test('overflow: high token ratio drives overflow risk high', () => {
    // ~40k tokens of content against a 32k window → ratio > 1.
    const big = 'x'.repeat(160000);
    const r = diag.diagnoseContext([userMsg(big)], { contextWindow: 32000 });
    expect(r.failureModes.overflow.level).toBe('high');
    expect(r.failureModes.overflow.signals.usageRatio).toBeGreaterThan(0.9);
    expect(r.recommendations).toContain('compact');
  });

  test('overflow: truncation markers raise risk even when current ratio is modest', () => {
    const messages = [
      userMsg('continue the task'),
      toolMsg('line one\nline two\n... [truncated 4096 chars]'),
    ];
    const r = diag.diagnoseContext(messages, { contextWindow: 128000 });
    expect(r.failureModes.overflow.signals.truncationMarkers).toBe(1);
    expect(r.failureModes.overflow.risk).toBeGreaterThanOrEqual(0.55);
  });

  test('distraction: an oversized tool result drowns signal', () => {
    // window 20000 → single-result cap = 6000 tokens. Make one ~8000-token result.
    const huge = 'a'.repeat(32000); // ~8000 tokens
    const messages = [userMsg('grep the codebase'), toolMsg(huge)];
    const r = diag.diagnoseContext(messages, { contextWindow: 20000 });
    expect(r.failureModes.distraction.signals.oversizedToolResults).toBeGreaterThanOrEqual(1);
    expect(r.failureModes.distraction.level).not.toBe('ok');
    expect(r.recommendations).toContain('truncate_tool_results');
  });

  test('distraction: heavy duplicate lines raise noiseRatio', () => {
    const dupLine = 'WARN repeated boilerplate diagnostic line about cache miss handling';
    const blob = Array.from({ length: 10 }, () => dupLine).join('\n');
    const messages = [userMsg('run it'), toolMsg(blob)];
    const r = diag.diagnoseContext(messages, { contextWindow: 128000 });
    expect(r.failureModes.distraction.signals.noiseRatio).toBeGreaterThan(0.5);
    expect(r.failureModes.distraction.level).toBe('high');
  });

  test('poisoning: a self-reinforcing assistant echo is detected', () => {
    const echo = 'The fix is to wrap the handler in a try/catch and log the error to stderr.';
    const messages = [
      userMsg('fix the crash'),
      asstMsg(echo),
      toolMsg('still crashing'),
      asstMsg(echo),
      toolMsg('still crashing'),
      asstMsg(echo),
    ];
    const r = diag.diagnoseContext(messages, { contextWindow: 128000 });
    expect(r.failureModes.poisoning.signals.selfEchoRepeats).toBeGreaterThanOrEqual(3);
    expect(r.failureModes.poisoning.level).toBe('high');
    expect(r.recommendations).toContain('break_self_echo');
    const path = diag.hasNonOverflowPathology(r);
    expect(path).not.toBeNull();
    expect(['poisoning', 'distraction']).toContain(path.mode);
  });

  test('confusion: an identical tool call repeated thrashes', () => {
    const call = { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.js' } }] };
    const result = { role: 'user', content: [{ type: 'tool_result', content: 'same content' }] };
    const messages = [
      userMsg('open the file'),
      call, result,
      call, result,
      call, result,
    ];
    const r = diag.diagnoseContext(messages, { contextWindow: 128000 });
    expect(r.failureModes.confusion.signals.toolThrash).toBeGreaterThanOrEqual(3);
    expect(r.failureModes.confusion.level).toBe('high');
    expect(r.recommendations).toContain('break_loop');
  });

  test('large window + clean context → zero false positives', () => {
    const messages = Array.from({ length: 6 }, (_, i) => (
      i % 2 === 0 ? userMsg(`task step ${i}: do a distinct unique thing number ${i}`)
                  : asstMsg(`acknowledged, performing distinct unique step ${i} now`)
    ));
    const r = diag.diagnoseContext(messages, { contextWindow: 200000 });
    expect(r.worst).toBeNull();
    expect(r.health).toBeGreaterThanOrEqual(90);
  });

  test('unknown window (0) does not fabricate overflow/distraction', () => {
    const r = diag.diagnoseContext([userMsg('hi'), asstMsg('hello there friend')], { contextWindow: 0 });
    expect(r.failureModes.overflow.risk).toBe(0);
    expect(r.tokens.usageRatio).toBe(0);
  });

  test('summarize produces a compact one-liner', () => {
    const r = diag.diagnoseContext([userMsg('x')], { contextWindow: 128000 });
    const s = diag.summarize(r);
    expect(typeof s).toBe('string');
    expect(s).toMatch(/^ctx health=\d+/);
  });

  test('empty / garbage input never throws', () => {
    expect(() => diag.diagnoseContext(null, {})).not.toThrow();
    expect(() => diag.diagnoseContext(undefined)).not.toThrow();
    expect(() => diag.diagnoseContext([null, undefined, {}], { contextWindow: 1000 })).not.toThrow();
  });
});
