'use strict';

/**
 * codexShellControlTokensHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the shell control-token Set in
 * extractTrackedFileOpsFromShellCommand(): the `|`/`||`/`&&`/`;` delimiter
 * Set is now a single shared module constant instead of a fresh
 * `new Set([...])` per bash-tool item. Behavior must be byte-identical.
 */

const test = require('node:test');
const assert = require('node:assert');

const codex = require('../src/services/gateway/adapters/codexAdapter.js');
const { extractTrackedFileOpsFromShellCommand } = codex.__test__;

function paths(ops) {
  return ops.map((o) => `${o.operation}:${o.path}`).sort();
}

test('empty / non-string command yields no ops', () => {
  assert.deepStrictEqual(extractTrackedFileOpsFromShellCommand(''), []);
  assert.deepStrictEqual(extractTrackedFileOpsFromShellCommand('   '), []);
});

test('rm/mv/unlink recognized as tracked relocation/deletion', () => {
  const rm = extractTrackedFileOpsFromShellCommand('rm foo.txt');
  assert.ok(rm.some((o) => o.path === 'foo.txt'));
  const mv = extractTrackedFileOpsFromShellCommand('mv a.txt b.txt');
  assert.ok(mv.length >= 1);
});

test('control token && stops arg collection for the first command', () => {
  // `rm a.txt && echo done` — the && must delimit so b args of echo are not
  // swept into rm's positional list. rm should still track a.txt.
  const ops = extractTrackedFileOpsFromShellCommand('rm a.txt && echo done');
  assert.ok(ops.some((o) => o.path === 'a.txt'));
  // 'done' must NOT be tracked as an rm target.
  assert.ok(!ops.some((o) => o.path === 'done'));
});

test('pipe | and semicolon ; delimit commands', () => {
  const piped = extractTrackedFileOpsFromShellCommand('cat x | rm y.txt');
  assert.ok(piped.some((o) => o.path === 'y.txt'));
  const seq = extractTrackedFileOpsFromShellCommand('echo hi ; rm z.txt');
  assert.ok(seq.some((o) => o.path === 'z.txt'));
});

test('repeated calls are independent (shared Set not corrupted)', () => {
  const a = extractTrackedFileOpsFromShellCommand('rm one.txt');
  const b = extractTrackedFileOpsFromShellCommand('rm two.txt');
  assert.notDeepStrictEqual(paths(a), paths(b));
  // Re-running the first command yields the same result as the first time —
  // proves the hoisted control-token Set was not mutated between calls.
  const aAgain = extractTrackedFileOpsFromShellCommand('rm one.txt');
  assert.deepStrictEqual(paths(aAgain), paths(a));
});
