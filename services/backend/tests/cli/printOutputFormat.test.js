'use strict';

const test = require('node:test');
const assert = require('node:assert');

const pof = require('../../src/cli/printOutputFormat');

test('parsePrintFlags: default format is text, no flags consumed', () => {
  const r = pof.parsePrintFlags(['hello', 'world']);
  assert.strictEqual(r.format, 'text');
  assert.strictEqual(r.maxTurns, null);
  assert.deepStrictEqual(r.args, ['hello', 'world']);
  assert.strictEqual(r.error, null);
});

test('parsePrintFlags: --output-format json is parsed and stripped', () => {
  const r = pof.parsePrintFlags(['explain', 'this', '--output-format', 'json']);
  assert.strictEqual(r.format, 'json');
  assert.deepStrictEqual(r.args, ['explain', 'this']);
  assert.strictEqual(r.error, null);
});

test('parsePrintFlags: --output-format=stream-json equals form', () => {
  const r = pof.parsePrintFlags(['--output-format=stream-json', 'q']);
  assert.strictEqual(r.format, 'stream-json');
  assert.deepStrictEqual(r.args, ['q']);
});

test('parsePrintFlags: invalid format reports error, does not throw', () => {
  const r = pof.parsePrintFlags(['q', '--output-format', 'yaml']);
  assert.match(r.error, /invalid --output-format/);
});

test('parsePrintFlags: --max-turns parsed, capped at 100, stripped', () => {
  const r = pof.parsePrintFlags(['q', '--max-turns', '250']);
  assert.strictEqual(r.maxTurns, 100);
  assert.deepStrictEqual(r.args, ['q']);
  const r2 = pof.parsePrintFlags(['q', '--max-turns', '3']);
  assert.strictEqual(r2.maxTurns, 3);
});

test('parsePrintFlags: bad --max-turns reports error', () => {
  assert.match(pof.parsePrintFlags(['q', '--max-turns', 'abc']).error, /positive integer/);
  assert.match(pof.parsePrintFlags(['q', '--max-turns', '0']).error, /positive integer/);
});

test('parsePrintFlags: missing value for --output-format reports error', () => {
  assert.match(pof.parsePrintFlags(['q', '--output-format']).error, /requires a value/);
});

test('parsePrintFlags: --system-prompt / --append-system-prompt parsed and stripped', () => {
  const r = pof.parsePrintFlags(['q', '--system-prompt', 'You are a DBA', '--append-system-prompt', 'Be terse']);
  assert.strictEqual(r.systemPrompt, 'You are a DBA');
  assert.strictEqual(r.appendSystemPrompt, 'Be terse');
  assert.deepStrictEqual(r.args, ['q']);
  assert.strictEqual(r.error, null);
});

test('parsePrintFlags: --system-prompt=value equals form', () => {
  const r = pof.parsePrintFlags(['--append-system-prompt=Cite sources', 'q']);
  assert.strictEqual(r.appendSystemPrompt, 'Cite sources');
  assert.deepStrictEqual(r.args, ['q']);
});

test('parsePrintFlags: missing --system-prompt value reports error', () => {
  assert.match(pof.parsePrintFlags(['q', '--system-prompt']).error, /requires a value/);
  assert.match(pof.parsePrintFlags(['q', '--append-system-prompt']).error, /requires a value/);
});

test('parsePrintFlags: system-prompt flags default to null', () => {
  const r = pof.parsePrintFlags(['just', 'a', 'prompt']);
  assert.strictEqual(r.systemPrompt, null);
  assert.strictEqual(r.appendSystemPrompt, null);
});

test('parsePrintFlags: --allowedTools / --disallowedTools comma+space lists', () => {
  const r = pof.parsePrintFlags(['q', '--allowedTools', 'Read,Write Bash', '--disallowedTools', 'WebFetch']);
  assert.deepStrictEqual(r.allowedTools, ['Read', 'Write', 'Bash']);
  assert.deepStrictEqual(r.disallowedTools, ['WebFetch']);
  assert.deepStrictEqual(r.args, ['q']);
  assert.strictEqual(r.error, null);
});

test('parsePrintFlags: --allowedTools=value and kebab alias', () => {
  const r = pof.parsePrintFlags(['--allowed-tools=Read,Grep', 'q']);
  assert.deepStrictEqual(r.allowedTools, ['Read', 'Grep']);
  assert.deepStrictEqual(r.args, ['q']);
});

test('parsePrintFlags: missing tool-list value reports error', () => {
  assert.match(pof.parsePrintFlags(['q', '--allowedTools']).error, /requires a value/);
  assert.match(pof.parsePrintFlags(['q', '--disallowedTools']).error, /requires a value/);
});

test('parsePrintFlags: tool lists default to null', () => {
  const r = pof.parsePrintFlags(['just', 'a', 'prompt']);
  assert.strictEqual(r.allowedTools, null);
  assert.strictEqual(r.disallowedTools, null);
});

test('parsePrintFlags: --continue / -c set continueSession, stripped', () => {
  const r = pof.parsePrintFlags(['--continue', 'keep', 'going']);
  assert.strictEqual(r.continueSession, true);
  assert.strictEqual(r.resumeSessionId, null);
  assert.deepStrictEqual(r.args, ['keep', 'going']);
  assert.strictEqual(r.error, null);
  const r2 = pof.parsePrintFlags(['-c', 'q']);
  assert.strictEqual(r2.continueSession, true);
  assert.deepStrictEqual(r2.args, ['q']);
});

test('parsePrintFlags: --resume <id> / -r <id> captures id, stripped', () => {
  const r = pof.parsePrintFlags(['--resume', 'sess-abc', 'next', 'turn']);
  assert.strictEqual(r.resumeSessionId, 'sess-abc');
  assert.strictEqual(r.continueSession, false);
  assert.deepStrictEqual(r.args, ['next', 'turn']);
  const r2 = pof.parsePrintFlags(['-r', 'sess-xyz', 'q']);
  assert.strictEqual(r2.resumeSessionId, 'sess-xyz');
  assert.deepStrictEqual(r2.args, ['q']);
});

test('parsePrintFlags: --resume=value equals form', () => {
  const r = pof.parsePrintFlags(['--resume=sid123', 'q']);
  assert.strictEqual(r.resumeSessionId, 'sid123');
  assert.deepStrictEqual(r.args, ['q']);
});

test('parsePrintFlags: --resume without id reports error', () => {
  assert.match(pof.parsePrintFlags(['q', '--resume']).error, /requires a session id/);
  assert.match(pof.parsePrintFlags(['q', '--resume=']).error, /requires a session id/);
});

test('parsePrintFlags: session flags default to off', () => {
  const r = pof.parsePrintFlags(['just', 'a', 'prompt']);
  assert.strictEqual(r.continueSession, false);
  assert.strictEqual(r.resumeSessionId, null);
});

test('parsePrintFlags: continue + resume coexist (caller prefers resume)', () => {
  const r = pof.parsePrintFlags(['--continue', '--resume', 'sid', 'q']);
  assert.strictEqual(r.continueSession, true);
  assert.strictEqual(r.resumeSessionId, 'sid');
  assert.deepStrictEqual(r.args, ['q']);
});

test('countTurns: tool rounds + 1 trailing model turn', () => {
  assert.strictEqual(pof.countTurns({ toolCallLog: [] }), 1);
  assert.strictEqual(pof.countTurns({ toolCallLog: [{}, {}, {}] }), 4);
  assert.strictEqual(pof.countTurns({}), 1);
});

test('deriveSubtype: success / error_during_execution / error_max_turns', () => {
  assert.strictEqual(pof.deriveSubtype({ errorType: '', maxTurnsHit: false }), 'success');
  assert.strictEqual(pof.deriveSubtype({ errorType: 'network', maxTurnsHit: false }), 'error_during_execution');
  assert.strictEqual(pof.deriveSubtype({ errorType: 'network', maxTurnsHit: true }), 'error_max_turns');
});

test('detectMaxTurnsHit: stopReason and turn-count signals', () => {
  assert.strictEqual(pof.detectMaxTurnsHit({ stopReason: 'max_iterations' }, 3), true);
  assert.strictEqual(pof.detectMaxTurnsHit({ toolCallLog: [{}, {}, {}] }, 3), true);
  assert.strictEqual(pof.detectMaxTurnsHit({ toolCallLog: [{}] }, 3), false);
  assert.strictEqual(pof.detectMaxTurnsHit({ toolCallLog: [{}, {}, {}] }, null), false);
});

test('buildResultMessage: schema matches Claude Code contract (success)', () => {
  const msg = pof.buildResultMessage(
    { reply: 'hi there', errorType: '', elapsed: 1234, toolCallLog: [{}, {}], tokenUsage: null },
    { sessionId: 'abc123', maxTurns: null },
  );
  assert.deepStrictEqual(Object.keys(msg).sort(), [
    'duration_api_ms', 'duration_ms', 'is_error', 'num_turns',
    'result', 'session_id', 'subtype', 'total_cost_usd', 'type',
  ]);
  assert.strictEqual(msg.type, 'result');
  assert.strictEqual(msg.subtype, 'success');
  assert.strictEqual(msg.is_error, false);
  assert.strictEqual(msg.duration_ms, 1234);
  assert.strictEqual(msg.num_turns, 3);
  assert.strictEqual(msg.result, 'hi there');
  assert.strictEqual(msg.session_id, 'abc123');
  assert.strictEqual(msg.total_cost_usd, 0);
});

test('buildResultMessage: error run sets is_error and subtype', () => {
  const msg = pof.buildResultMessage(
    { reply: '', errorType: 'network', elapsed: 50, toolCallLog: [] },
    { sessionId: 's' },
  );
  assert.strictEqual(msg.is_error, true);
  assert.strictEqual(msg.subtype, 'error_during_execution');
});

test('extractCostUsd: honours explicit cost field, else 0', () => {
  assert.strictEqual(pof.extractCostUsd(null), 0);
  assert.strictEqual(pof.extractCostUsd({ inputTokens: 10 }), 0);
  assert.strictEqual(pof.extractCostUsd({ costUsd: 0.003 }), 0.003);
  assert.strictEqual(pof.extractCostUsd({ total_cost_usd: 1.5 }), 1.5);
});

test('render text: returns plain reply', () => {
  assert.strictEqual(pof.render('text', { reply: 'plain' }, {}), 'plain');
  assert.strictEqual(pof.render('text', {}, {}), '');
});

test('render json: single parseable result object', () => {
  const out = pof.render('json', { reply: 'r', elapsed: 7, toolCallLog: [] }, { sessionId: 'z' });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.type, 'result');
  assert.strictEqual(parsed.result, 'r');
  assert.strictEqual(parsed.session_id, 'z');
});

test('render stream-json: NDJSON init → user → assistant → result', () => {
  const out = pof.render(
    'stream-json',
    { reply: 'answer', elapsed: 9, toolCallLog: [{}] },
    { sessionId: 'sid', cwd: '/tmp', prompt: 'ask', model: 'm', tools: ['Read'] },
  );
  const lines = out.split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(lines.length, 4);
  assert.strictEqual(lines[0].type, 'system');
  assert.strictEqual(lines[0].subtype, 'init');
  assert.strictEqual(lines[0].cwd, '/tmp');
  assert.deepStrictEqual(lines[0].tools, ['Read']);
  assert.strictEqual(lines[1].type, 'user');
  assert.strictEqual(lines[1].message.content, 'ask');
  assert.strictEqual(lines[2].type, 'assistant');
  assert.strictEqual(lines[2].message.content, 'answer');
  assert.strictEqual(lines[3].type, 'result');
  assert.strictEqual(lines[3].result, 'answer');
  // session_id threaded through every message
  assert.ok(lines.every((l) => l.session_id === 'sid'));
});

test('parsePrintFlags: --output-schema inline JSON captured and stripped', () => {
  const r = pof.parsePrintFlags(['q', '--output-schema', '{"type":"object"}']);
  assert.strictEqual(r.outputSchema, '{"type":"object"}');
  assert.deepStrictEqual(r.args, ['q']);
  assert.strictEqual(r.error, null);
});

test('parsePrintFlags: --output-schema=@file equals form captured', () => {
  const r = pof.parsePrintFlags(['--output-schema=@schema.json', 'q']);
  assert.strictEqual(r.outputSchema, '@schema.json');
  assert.deepStrictEqual(r.args, ['q']);
});

test('parsePrintFlags: missing --output-schema value reports error', () => {
  const r = pof.parsePrintFlags(['q', '--output-schema']);
  assert.match(r.error, /--output-schema requires a value/);
});

test('parsePrintFlags: absent --output-schema -> null (byte fallback)', () => {
  const r = pof.parsePrintFlags(['q']);
  assert.strictEqual(r.outputSchema, null);
});

// ── Q3a: resolveExitCode + detectMaxTurnsHit authoritative override ──────────────────
// 修复「headless 达迭代上限却退出码 0 / json 报 success」——契约变更 opt-in(KHY_HEADLESS_EXIT_ON_LIMIT)。

test('resolveExitCode: clean success -> 0', () => {
  assert.strictEqual(pof.resolveExitCode({}), 0);
  assert.strictEqual(pof.resolveExitCode(null), 0);
});

test('resolveExitCode: errorType -> 2 (existing behaviour)', () => {
  assert.strictEqual(pof.resolveExitCode({ errorType: 'model_not_found' }), 2);
});

test('resolveExitCode: limit but flag off -> 0 (byte-revert)', () => {
  assert.strictEqual(pof.resolveExitCode({ maxIterationsReached: true }), 0);
  assert.strictEqual(pof.resolveExitCode({ maxIterationsReached: true }, { limitExitEnabled: false }), 0);
});

test('resolveExitCode: limit + flag on -> 3 (retryable, distinct from hard error)', () => {
  assert.strictEqual(pof.resolveExitCode({ maxIterationsReached: true }, { limitExitEnabled: true }), 3);
  assert.strictEqual(pof.resolveExitCode({ stoppedByLimit: true }, { limitExitEnabled: true }), 3);
  assert.strictEqual(pof.resolveExitCode({ maxTurnsHit: true }, { limitExitEnabled: true }), 3);
});

test('resolveExitCode: errorType wins over limit', () => {
  assert.strictEqual(pof.resolveExitCode({ errorType: 'x', maxIterationsReached: true }, { limitExitEnabled: true }), 2);
});

test('detectMaxTurnsHit: no signal + no maxTurns -> false (byte-revert)', () => {
  assert.strictEqual(pof.detectMaxTurnsHit({}, null), false);
});

test('detectMaxTurnsHit: explicit maxTurnsHit override wins independent of ctx.maxTurns', () => {
  assert.strictEqual(pof.detectMaxTurnsHit({ maxTurnsHit: true }, null), true);
});

test('detectMaxTurnsHit: maxIterationsReached alone does NOT flip (bin gates via maxTurnsHit)', () => {
  assert.strictEqual(pof.detectMaxTurnsHit({ maxIterationsReached: true }, null), false);
});

test('render json: absent maxTurnsHit -> success/is_error false (byte-revert)', () => {
  const j = JSON.parse(pof.render('json', { reply: 'partial', toolCallLog: [] }, { maxTurns: null }));
  assert.strictEqual(j.subtype, 'success');
  assert.strictEqual(j.is_error, false);
});

test('render json: maxTurnsHit set -> error_max_turns/is_error true (flag-on path)', () => {
  const j = JSON.parse(pof.render('json', { reply: 'partial', toolCallLog: [], maxTurnsHit: true }, { maxTurns: null }));
  assert.strictEqual(j.subtype, 'error_max_turns');
  assert.strictEqual(j.is_error, true);
});
