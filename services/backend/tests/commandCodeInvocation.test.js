'use strict';

/**
 * Unit tests for commandCodeInvocation.js — the pure leaf that builds the
 * `cmdcode --print [--model <id>]` argv list for the cliToolAdapter bridge.
 *
 * Two builders are exported:
 *   - buildPrintArgs       : legacy form, carries the `__PROMPT__` placeholder
 *                            and is left here so any future non-stdin
 *                            consumer (Linux/macOS path, custom spawn shape)
 *                            can still use the documented contract.
 *   - buildPrintArgsStdin  : Windows-safe form (no `__PROMPT__`, prompt is
 *                            piped via stdin by cliToolAdapter) — sidesteps
 *                            the cmd /c arg-split AND the Windows ~32KB
 *                            command-line limit. This is what the live
 *                            CommandCode tool entry in cliToolAdapter.js uses
 *                            since the stdin fix landed.
 *
 * The test uses node:test (the project's node:test track is auto-discovered
 * by jest.config.js via the `require('node:test')` marker) and never touches
 * a real child process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const invocation = require('../src/services/gateway/adapters/commandCodeInvocation');

test('looksLikeProviderModel: rejects bare / empty / single-segment ids', () => {
  assert.equal(invocation.looksLikeProviderModel(''), false);
  assert.equal(invocation.looksLikeProviderModel('   '), false);
  assert.equal(invocation.looksLikeProviderModel(null), false);
  assert.equal(invocation.looksLikeProviderModel(undefined), false);
  assert.equal(invocation.looksLikeProviderModel(42), false);
  assert.equal(invocation.looksLikeProviderModel('noSlash'), false);
  assert.equal(invocation.looksLikeProviderModel('trailing/'), false);
  assert.equal(invocation.looksLikeProviderModel('/leading'), false);
});

test('looksLikeProviderModel: accepts provider/model shapes', () => {
  assert.equal(invocation.looksLikeProviderModel('minimax/minimax-m3-free'), true);
  assert.equal(invocation.looksLikeProviderModel('MiniMaxAI/MiniMax-M3'), true);
  // model id itself can carry a slash (per the module doc).
  assert.equal(invocation.looksLikeProviderModel('poolside/laguna-s-2.1-free'), true);
  // surrounding whitespace is trimmed; the function still sees the slash.
  assert.equal(invocation.looksLikeProviderModel('  agnes/agnes-2.5-flash  '), true);
});

test('buildPrintArgs: carries __PROMPT__ placeholder by default', () => {
  assert.deepEqual(invocation.buildPrintArgs(), ['--print', '__PROMPT__']);
  assert.deepEqual(invocation.buildPrintArgs({}), ['--print', '__PROMPT__']);
  // Non-string model is ignored (fail-soft, never throws).
  assert.deepEqual(invocation.buildPrintArgs({ model: 42 }), ['--print', '__PROMPT__']);
});

test('buildPrintArgs: appends --model when model looks like provider/model', () => {
  assert.deepEqual(
    invocation.buildPrintArgs({ model: 'minimax/minimax-m3-free' }),
    ['--print', '__PROMPT__', '--model', 'minimax/minimax-m3-free']
  );
  // Trims surrounding whitespace before injection.
  assert.deepEqual(
    invocation.buildPrintArgs({ model: '  agnes/agnes-2.5-flash  ' }),
    ['--print', '__PROMPT__', '--model', 'agnes/agnes-2.5-flash']
  );
});

test('buildPrintArgs: omits --model when model is missing or malformed', () => {
  assert.deepEqual(invocation.buildPrintArgs({ model: '' }), ['--print', '__PROMPT__']);
  assert.deepEqual(invocation.buildPrintArgs({ model: 'noSlash' }), ['--print', '__PROMPT__']);
  assert.deepEqual(
    invocation.buildPrintArgs({ model: 'trailing/' }),
    ['--print', '__PROMPT__']
  );
});

test('buildPrintArgsStdin: no __PROMPT__ placeholder (prompt goes via stdin)', () => {
  assert.deepEqual(invocation.buildPrintArgsStdin(), ['--print']);
  assert.deepEqual(invocation.buildPrintArgsStdin({}), ['--print']);
});

test('buildPrintArgsStdin: appends --model when model is valid', () => {
  assert.deepEqual(
    invocation.buildPrintArgsStdin({ model: 'minimax/minimax-m3-free' }),
    ['--print', '--model', 'minimax/minimax-m3-free']
  );
});

test('buildPrintArgsStdin: omits --model for malformed ids', () => {
  assert.deepEqual(invocation.buildPrintArgsStdin({ model: '' }), ['--print']);
  assert.deepEqual(
    invocation.buildPrintArgsStdin({ model: 'noSlash' }),
    ['--print']
  );
});

test('applyModelArg: appends --model in place without mutating the input', () => {
  const base = ['--print'];
  const out = invocation.applyModelArg(base, 'minimax/minimax-m3-free');
  assert.deepEqual(out, ['--print', '--model', 'minimax/minimax-m3-free']);
  // Input array must be untouched (pure function contract).
  assert.deepEqual(base, ['--print']);
  // Out must be a fresh array, not a reference to the input.
  assert.notEqual(out, base);
});

test('applyModelArg: returns a shallow copy when model is missing/malformed', () => {
  const base = ['--print', '__PROMPT__'];
  const out = invocation.applyModelArg(base, '');
  assert.deepEqual(out, base);
  assert.notEqual(out, base);
  const out2 = invocation.applyModelArg(base, 'noSlash');
  assert.deepEqual(out2, base);
  assert.notEqual(out2, base);
});

test('applyModelArg: tolerates non-array input (returns shallow copy of [])', () => {
  const out = invocation.applyModelArg(null, 'minimax/minimax-m3-free');
  assert.deepEqual(out, ['--model', 'minimax/minimax-m3-free']);
  // Bad input never throws.
  const out2 = invocation.applyModelArg(undefined, '');
  assert.deepEqual(out2, []);
});

test('isEnabled: gate is off by default; explicit 1/true/on/yes flips it on', () => {
  // Undefined env value → off.
  assert.equal(invocation.isEnabled({}), false);
  // Other truthy strings → off (avoid accidental activation by stray values).
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: 'enabled' }), false);
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: 'on-the-other-hand' }), false);
  // The four accepted truthy literals.
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: '1' }), true);
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: 'true' }), true);
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: 'on' }), true);
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: 'yes' }), true);
  // Case + whitespace insensitive.
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: '  YES  ' }), true);
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: 'On' }), true);
  // Explicit "off" family stays off.
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: '0' }), false);
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: 'false' }), false);
  assert.equal(invocation.isEnabled({ KHY_COMMANDCODE: 'off' }), false);
});

test('isEnabled: tolerates missing / null / undefined env (never throws)', () => {
  // Both null and undefined env must short-circuit to false, not throw.
  assert.equal(invocation.isEnabled(undefined), false);
  assert.equal(invocation.isEnabled(null), false);
});
