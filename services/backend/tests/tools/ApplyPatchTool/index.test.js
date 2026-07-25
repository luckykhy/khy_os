'use strict';

/**
 * ApplyPatchTool (apply_patch) — unified-diff parse + hunk application.
 *
 * Two stacked regressions, both silent data-loss in a high-risk write tool:
 *
 *  1. parsePatch bodyHunkRegex used `(?=…|$)` under the `m` flag, so `$` matched
 *     at every line-end and the lazy `[\s\S]*?` body capture stopped after the
 *     FIRST body line — every multi-line hunk was truncated to one line.
 *
 *  2. applyHunk spliced only `hunk.added` over the matched block (context +
 *     removed lines), so the context lines inside the block were deleted from
 *     the "after" image. A 1-context/1-removed/2-added hunk replaced 2 source
 *     lines with just the 2 added lines.
 *
 * With both fixed, apply_patch produces the true unified-diff result. No-context
 * hunks (removed→added only) and pure additions are byte-identical to before.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ApplyPatchTool = require('../../../src/tools/ApplyPatchTool/index.js');
const { parsePatch, applyHunk } = ApplyPatchTool.__test__;

// Parse a patch and apply all its hunks (bottom-up, as execute() does) to a
// copy of `src`, returning the resulting line array.
function applyAll(patch, src) {
  const files = parsePatch(patch);
  const lines = [...src];
  const sorted = [...files[0].hunks].sort((a, b) => b.srcStart - a.srcStart);
  for (const h of sorted) applyHunk(lines, h);
  return lines;
}

test('parsePatch captures the full multi-line hunk body (not just line 1)', () => {
  const patch = [
    '--- a/foo.js', '+++ b/foo.js', '@@ -1,3 +1,4 @@',
    ' const x = 1;', '-const y = 2;', '+const y = 3;', '+const z = 4;',
    ' module.exports = { x, y };', '',
  ].join('\n');
  const hunk = parsePatch(patch)[0].hunks[0];
  assert.strictEqual(hunk.rawLines.length, 5);
  assert.deepStrictEqual(hunk.removed, ['const y = 2;']);
  assert.deepStrictEqual(hunk.added, ['const y = 3;', 'const z = 4;']);
  assert.deepStrictEqual(hunk.context, ['const x = 1;', 'module.exports = { x, y };']);
});

test('applyHunk preserves context lines in the after image', () => {
  const patch = [
    '--- a/foo.js', '+++ b/foo.js', '@@ -1,3 +1,4 @@',
    ' const x = 1;', '-const y = 2;', '+const y = 3;', '+const z = 4;',
    ' module.exports = { x, y };', '',
  ].join('\n');
  const src = ['const x = 1;', 'const y = 2;', 'module.exports = { x, y };'];
  assert.deepStrictEqual(applyAll(patch, src), [
    'const x = 1;', 'const y = 3;', 'const z = 4;', 'module.exports = { x, y };',
  ]);
});

test('multiple hunks in one file each apply at the right spot', () => {
  const patch = [
    '--- a/f.txt', '+++ b/f.txt',
    '@@ -1,2 +1,2 @@', ' a', '-b', '+B',
    '@@ -5,2 +5,2 @@', ' e', '-f', '+F', '',
  ].join('\n');
  const src = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.deepStrictEqual(applyAll(patch, src), ['a', 'B', 'c', 'd', 'e', 'F']);
});

test('no-context single replace is byte-identical (added == after image)', () => {
  const patch = ['--- a/s.txt', '+++ b/s.txt', '@@ -2,1 +2,1 @@', '-old', '+new', ''].join('\n');
  assert.deepStrictEqual(applyAll(patch, ['keep1', 'old', 'keep2']), ['keep1', 'new', 'keep2']);
});

test('a "\\ No newline at end of file" marker is ignored in the after image', () => {
  const patch = [
    '--- a/nn.txt', '+++ b/nn.txt', '@@ -1,2 +1,2 @@',
    ' first', '-second', '+SECOND', '\\ No newline at end of file', '',
  ].join('\n');
  assert.deepStrictEqual(applyAll(patch, ['first', 'second']), ['first', 'SECOND']);
});

test('execute() writes the correctly patched file end-to-end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'applypatch-e2e-'));
  const foo = path.join(dir, 'foo.js');
  fs.writeFileSync(foo, 'const x = 1;\nconst y = 2;\nmodule.exports = { x, y };\n');
  const prev = process.env.KHYQUANT_CWD;
  process.env.KHYQUANT_CWD = dir;
  try {
    const patch = [
      '--- a/foo.js', '+++ b/foo.js', '@@ -1,3 +1,4 @@',
      ' const x = 1;', '-const y = 2;', '+const y = 3;', '+const z = 4;',
      ' module.exports = { x, y };', '',
    ].join('\n');
    const res = await new ApplyPatchTool().execute({ patch });
    assert.strictEqual(res.success, true);
    assert.strictEqual(
      fs.readFileSync(foo, 'utf-8'),
      'const x = 1;\nconst y = 3;\nconst z = 4;\nmodule.exports = { x, y };\n',
    );
  } finally {
    if (prev === undefined) delete process.env.KHYQUANT_CWD;
    else process.env.KHYQUANT_CWD = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
