'use strict';

/**
 * postEditDiagnosticsSummary — pins the pure-leaf decision for the CC-parity
 * post-edit "new diagnostics" summary line (aligns with CC's DiagnosticsDisplay
 * "Found N new diagnostic issues in M files", produced from a before/after diff).
 *
 * The leaf holds only pure string logic: normalize a compiler error line into a
 * stable signature, diff before/after error sets, and format the summary string.
 * Gate KHY_POST_EDIT_DIAGNOSTICS default on; gate off / bad input → null.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const d = require('../../src/services/postEditDiagnosticsSummary');

test('postEditDiagnosticsEnabled: default on, {0,false,off,no} off', () => {
  assert.strictEqual(d.postEditDiagnosticsEnabled({}), true);
  assert.strictEqual(d.postEditDiagnosticsEnabled({ KHY_POST_EDIT_DIAGNOSTICS: 'true' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      d.postEditDiagnosticsEnabled({ KHY_POST_EDIT_DIAGNOSTICS: v }), false, `expected off for ${v}`,
    );
  }
});

test('normalizeErrorSignature: drops stack frames, carets, and pure locator headers', () => {
  assert.strictEqual(d.normalizeErrorSignature('    at Object.<anonymous> (/home/x/a.js:3:5)'), '');
  assert.strictEqual(d.normalizeErrorSignature('          ^'), '');
  assert.strictEqual(d.normalizeErrorSignature('   ~~~~  '), '');
  assert.strictEqual(d.normalizeErrorSignature(''), '');
  assert.strictEqual(d.normalizeErrorSignature(null), '');
  // pure path:line locator header (no message word) → noise
  assert.strictEqual(d.normalizeErrorSignature('src/a.js: /home/x/a.js:2'), '');
});

test('normalizeErrorSignature: keeps message-bearing lines, stable across line/path variation', () => {
  const a = d.normalizeErrorSignature("/home/x/a.js:2 SyntaxError: Unexpected token ';'");
  const b = d.normalizeErrorSignature("/tmp/other/a.js:99 SyntaxError: Unexpected token ';'");
  assert.ok(a, 'should produce a non-empty signature');
  assert.strictEqual(a, b, 'signature must be stable across differing abs paths and line numbers');
  assert.match(a, /syntaxerror/);
});

test('toSignatureSet: dedupes and drops noise', () => {
  const set = d.toSignatureSet([
    "/home/x/a.js:2 SyntaxError: bad token",
    "/home/x/a.js:5 SyntaxError: bad token", // same after line-strip → dedup
    '    at foo (a.js:1:1)',                  // noise
    '^',                                       // noise
  ]);
  assert.strictEqual(set.size, 1);
});

test('diffNewErrors: returns only after-lines whose signature is absent from before', () => {
  const before = d.toSignatureSet(["a.js:1 SyntaxError: pre-existing problem"]);
  const after = [
    "a.js:3 SyntaxError: pre-existing problem", // same sig as before → not new
    "a.js:7 SyntaxError: brand new breakage",   // new
    '    at x (a.js:7:2)',                        // noise
  ];
  const news = d.diffNewErrors(before, after);
  assert.strictEqual(news.length, 1);
  assert.match(news[0], /brand new breakage/);
});

test('diffNewErrors: everything new when before is empty (new-file case)', () => {
  const news = d.diffNewErrors(new Set(), ["x.js:1 SyntaxError: boom", "x.js:2 SyntaxError: bang"]);
  assert.strictEqual(news.length, 2);
});

test('diffNewErrors: fail-soft on bad input → []', () => {
  assert.deepStrictEqual(d.diffNewErrors(null, null), []);
  assert.deepStrictEqual(d.diffNewErrors(undefined, undefined), []);
  assert.doesNotThrow(() => d.diffNewErrors());
});

test('buildPostEditDiagnosticsSummary: full form (Chinese, no plural)', () => {
  assert.strictEqual(
    d.buildPostEditDiagnosticsSummary({ issueCount: 2, fileCount: 1 }, {}),
    '发现 2 处新增诊断问题（1 个文件）',
  );
  assert.strictEqual(
    d.buildPostEditDiagnosticsSummary({ issueCount: 1, fileCount: 3 }, {}),
    '发现 1 处新增诊断问题（3 个文件）',
  );
});

test('buildPostEditDiagnosticsSummary: zero/negative/bad → null', () => {
  assert.strictEqual(d.buildPostEditDiagnosticsSummary({ issueCount: 0, fileCount: 1 }, {}), null);
  assert.strictEqual(d.buildPostEditDiagnosticsSummary({ issueCount: 2, fileCount: 0 }, {}), null);
  assert.strictEqual(d.buildPostEditDiagnosticsSummary({ issueCount: -1, fileCount: 1 }, {}), null);
  assert.strictEqual(d.buildPostEditDiagnosticsSummary({}, {}), null);
  assert.doesNotThrow(() => d.buildPostEditDiagnosticsSummary());
  assert.strictEqual(d.buildPostEditDiagnosticsSummary(), null);
});

test('buildPostEditDiagnosticsSummary: gate off → null (byte-identical legacy: no line)', () => {
  assert.strictEqual(
    d.buildPostEditDiagnosticsSummary({ issueCount: 2, fileCount: 1 }, { KHY_POST_EDIT_DIAGNOSTICS: 'off' }),
    null,
  );
});
