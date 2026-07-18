/**
 * Fix G — stream-json tool_use input recovery.
 *
 * Regression coverage for the headless `khy -p` bug where a shell tool call
 * reached the syscall gateway with EMPTY input ({}) → empty command → L2
 * critical → non-interactive fail-closed, so echo/node/sleep/timeout could
 * never run headlessly.
 *
 * Two seams are covered:
 *   1. ai.js `_resolveToolBlockInput` / `_streamToolRawInputEnabled` — the
 *      authoritative interceptor collector must prefer the structured rawInput.
 *   2. cliToolAdapter `processStreamEvent` — content_block_stop must re-surface
 *      the COMPLETED tool_use carrying the full accumulated input.
 *
 * Every gate defaults ON; gate off must byte-revert to the historical behavior.
 */
'use strict';

const assert = require('assert');

const ai = require('../src/cli/ai');
const { _resolveToolBlockInput, _streamToolRawInputEnabled } = ai.__test__ || ai;

const cliToolAdapter = require('../src/services/gateway/adapters/cliToolAdapter');
const { processStreamEvent, _cliToolUseStopInputEnabled } = cliToolAdapter.__test__;

function run(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    return true;
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`        ${err && err.message}`);
    return false;
  }
}

const results = [];

// ---------------------------------------------------------------------------
// _streamToolRawInputEnabled — gate semantics
// ---------------------------------------------------------------------------
results.push(run('_streamToolRawInputEnabled defaults ON (unset)', () => {
  assert.strictEqual(_streamToolRawInputEnabled({}), true);
}));

results.push(run('_streamToolRawInputEnabled OFF for 0/false/off/no', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      _streamToolRawInputEnabled({ KHY_STREAM_TOOL_RAW_INPUT: v }),
      false,
      `expected OFF for ${JSON.stringify(v)}`,
    );
  }
}));

results.push(run('_streamToolRawInputEnabled ON for any other value', () => {
  assert.strictEqual(_streamToolRawInputEnabled({ KHY_STREAM_TOOL_RAW_INPUT: '1' }), true);
  assert.strictEqual(_streamToolRawInputEnabled({ KHY_STREAM_TOOL_RAW_INPUT: 'yes' }), true);
}));

// ---------------------------------------------------------------------------
// _resolveToolBlockInput — the core input recovery
// ---------------------------------------------------------------------------
results.push(run('prefers structured rawInput object over display summary string', () => {
  const chunk = {
    input: 'command=echo hello, cwd=/tmp',            // truncated display summary
    rawInput: { command: 'echo hello-khy-abc123' },   // the real, executable args
  };
  assert.deepStrictEqual(_resolveToolBlockInput(chunk, {}), { command: 'echo hello-khy-abc123' });
}));

results.push(run('empty rawInput + object input → returns the object input', () => {
  const chunk = { input: { command: 'ls' }, rawInput: {} };
  assert.deepStrictEqual(_resolveToolBlockInput(chunk, {}), { command: 'ls' });
}));

results.push(run('string input that is valid JSON → parsed object', () => {
  const chunk = { input: '{"command":"pwd"}' };
  assert.deepStrictEqual(_resolveToolBlockInput(chunk, {}), { command: 'pwd' });
}));

results.push(run('string input that is a summary (not JSON) → {} (never a fake command)', () => {
  const chunk = { input: 'command=pwd' };
  assert.deepStrictEqual(_resolveToolBlockInput(chunk, {}), {});
}));

results.push(run('rawInput array is ignored (not a valid args object)', () => {
  const chunk = { input: { command: 'ls' }, rawInput: ['a', 'b'] };
  assert.deepStrictEqual(_resolveToolBlockInput(chunk, {}), { command: 'ls' });
}));

results.push(run('missing everything → {}', () => {
  assert.deepStrictEqual(_resolveToolBlockInput({}, {}), {});
  assert.deepStrictEqual(_resolveToolBlockInput(null, {}), {});
}));

results.push(run('gate OFF → byte-revert to (chunk.input || {})', () => {
  const env = { KHY_STREAM_TOOL_RAW_INPUT: 'off' };
  // rawInput is present and richer, but gate off must ignore it entirely.
  const chunk = { input: 'command=echo hi', rawInput: { command: 'echo hi' } };
  assert.strictEqual(_resolveToolBlockInput(chunk, env), 'command=echo hi');
  assert.deepStrictEqual(_resolveToolBlockInput({ input: undefined }, env), {});
}));

// ---------------------------------------------------------------------------
// cliToolAdapter.processStreamEvent — content_block_stop re-emission
// ---------------------------------------------------------------------------
function feedStreamedToolCall(env) {
  const savedEnv = process.env.KHY_CLI_TOOLUSE_STOP_INPUT;
  if (env && 'KHY_CLI_TOOLUSE_STOP_INPUT' in env) {
    process.env.KHY_CLI_TOOLUSE_STOP_INPUT = env.KHY_CLI_TOOLUSE_STOP_INPUT;
  } else {
    delete process.env.KHY_CLI_TOOLUSE_STOP_INPUT;
  }
  const chunks = [];
  const onChunk = (c) => chunks.push(c);
  const append = () => {};
  const state = { blocks: new Map(), sawStreamEvent: false, sawAssistantText: false };
  try {
    // content_block_start: tool_use with EMPTY input (args stream later)
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash', id: 'toolu_1', input: {} } } },
      onChunk, append, state,
    );
    // content_block_delta: accumulate the real args char-by-char
    const full = '{"command":"echo hello-khy-abc123"}';
    for (let i = 0; i < full.length; i += 7) {
      processStreamEvent(
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: full.slice(i, i + 7) } } },
        onChunk, append, state,
      );
    }
    // content_block_stop: block complete
    processStreamEvent({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }, onChunk, append, state);
  } finally {
    if (savedEnv === undefined) delete process.env.KHY_CLI_TOOLUSE_STOP_INPUT;
    else process.env.KHY_CLI_TOOLUSE_STOP_INPUT = savedEnv;
  }
  return chunks;
}

results.push(run('_cliToolUseStopInputEnabled defaults ON / OFF for 0-false-off-no', () => {
  assert.strictEqual(_cliToolUseStopInputEnabled({}), true);
  assert.strictEqual(_cliToolUseStopInputEnabled({ KHY_CLI_TOOLUSE_STOP_INPUT: 'off' }), false);
  assert.strictEqual(_cliToolUseStopInputEnabled({ KHY_CLI_TOOLUSE_STOP_INPUT: '0' }), false);
}));

results.push(run('gate ON: content_block_stop re-emits tool_use with FULL accumulated input', () => {
  const chunks = feedStreamedToolCall({ KHY_CLI_TOOLUSE_STOP_INPUT: '1' });
  const stopToolUse = chunks.filter((c) => c.type === 'tool_use');
  // start emission (empty) + stop re-emission (full)
  assert.ok(stopToolUse.length >= 2, `expected >=2 tool_use chunks, got ${stopToolUse.length}`);
  const last = stopToolUse[stopToolUse.length - 1];
  assert.deepStrictEqual(last.rawInput, { command: 'echo hello-khy-abc123' });
  assert.strictEqual(last.id, 'toolu_1');
  assert.strictEqual(last.tool, 'Bash');
}));

results.push(run('gate OFF: content_block_stop byte-reverts to display-only tool_result', () => {
  const chunks = feedStreamedToolCall({ KHY_CLI_TOOLUSE_STOP_INPUT: 'off' });
  const toolUses = chunks.filter((c) => c.type === 'tool_use');
  // only the (empty) start emission — no completed re-emission
  assert.strictEqual(toolUses.length, 1, 'gate off must not re-emit a completed tool_use');
  const toolResults = chunks.filter((c) => c.type === 'tool_result');
  assert.ok(toolResults.length >= 1, 'gate off keeps the display-only 参数 tool_result');
  assert.ok(String(toolResults[toolResults.length - 1].content).includes('参数'));
}));

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r).length;
console.log(`\nstreamToolInputRecovery: ${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
