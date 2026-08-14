'use strict';

/**
 * postEditDiagnostics (shell service) — exercises the real before/after syntax
 * baseline diff against temp files on disk (quickSyntaxCheck runs node -c), the
 * only way to test it since nothing in-repo injects quickSyntaxCheck.
 *
 * Asserts: a syntax error introduced by an edit is counted as NEW; a pre-existing
 * syntax error is NOT recounted; new-file Write path (empty baseline) counts all;
 * gate off → no-op; reset() clears state.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../../src/services/postEditDiagnostics');

const GOOD = 'const x = 1;\nmodule.exports = x;\n';
const BAD = 'const x = ;\nmodule.exports = x;\n';       // syntax error
const BAD2 = 'const x = 1;\nfunction ( {\n';             // a different syntax error

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ped-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

afterEach(() => svc.reset());

test('edit that introduces a syntax error → counted as 1 new issue in 1 file', () => {
  const f = tmpFile('a.js', GOOD);
  svc.captureBaseline(f);              // pre-edit: clean
  fs.writeFileSync(f, BAD, 'utf-8');   // the "edit"
  const diag = svc.collectNewDiagnostics([f]);
  assert.strictEqual(diag.fileCount, 1);
  assert.ok(diag.issueCount >= 1, `expected >=1 new issue, got ${diag.issueCount}`);
});

test('pre-existing syntax error is NOT recounted as new after an unrelated edit', () => {
  const f = tmpFile('b.js', BAD);      // already broken before we touch it
  svc.captureBaseline(f);              // baseline captures the existing error
  fs.writeFileSync(f, BAD, 'utf-8');   // "edit" leaves the same error
  const diag = svc.collectNewDiagnostics([f]);
  assert.strictEqual(diag.issueCount, 0, 'pre-existing error must not be reported as new');
  assert.strictEqual(diag.fileCount, 0);
});

test('a NEW distinct error on an already-broken file IS reported', () => {
  const f = tmpFile('c.js', BAD);
  svc.captureBaseline(f);
  fs.writeFileSync(f, BAD2, 'utf-8');  // different breakage
  const diag = svc.collectNewDiagnostics([f]);
  assert.ok(diag.issueCount >= 1, 'a genuinely different error should count as new');
  assert.strictEqual(diag.fileCount, 1);
});

test('new-file Write (empty baseline) → all post-write errors are new', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ped-'));
  const f = path.join(dir, 'new.js');
  svc.captureBaseline(f);              // file does not exist yet → empty baseline registered
  fs.writeFileSync(f, BAD, 'utf-8');   // the Write
  const diag = svc.collectNewDiagnostics([f]);
  assert.strictEqual(diag.fileCount, 1);
  assert.ok(diag.issueCount >= 1);
});

test('files without a baseline are skipped (no false positives)', () => {
  const f = tmpFile('d.js', BAD);
  // no captureBaseline call
  const diag = svc.collectNewDiagnostics([f]);
  assert.strictEqual(diag.issueCount, 0);
  assert.strictEqual(diag.fileCount, 0);
});

test('clean edit → no diagnostics', () => {
  const f = tmpFile('e.js', GOOD);
  svc.captureBaseline(f);
  fs.writeFileSync(f, GOOD.replace('1', '2'), 'utf-8');
  const diag = svc.collectNewDiagnostics([f]);
  assert.strictEqual(diag.issueCount, 0);
});

test('gate off → captureBaseline + collectNewDiagnostics are no-ops', () => {
  const prev = process.env.KHY_POST_EDIT_DIAGNOSTICS;
  process.env.KHY_POST_EDIT_DIAGNOSTICS = 'off';
  try {
    const f = tmpFile('f.js', GOOD);
    svc.captureBaseline(f);
    fs.writeFileSync(f, BAD, 'utf-8');
    const diag = svc.collectNewDiagnostics([f]);
    assert.strictEqual(diag.issueCount, 0);
    assert.strictEqual(diag.fileCount, 0);
  } finally {
    if (prev === undefined) delete process.env.KHY_POST_EDIT_DIAGNOSTICS;
    else process.env.KHY_POST_EDIT_DIAGNOSTICS = prev;
  }
});

test('reset() clears the baseline map', () => {
  const f = tmpFile('g.js', GOOD);
  svc.captureBaseline(f);
  assert.ok(svc._baseline.size >= 1);
  svc.reset();
  assert.strictEqual(svc._baseline.size, 0);
});

test('_key: resolves relative + expands ~ deterministically', () => {
  assert.strictEqual(svc._key('a.js', '/tmp/proj'), path.resolve('/tmp/proj', 'a.js'));
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) assert.strictEqual(svc._key('~/a.js', '/tmp/proj'), path.resolve(home + '/a.js'));
});

test('collectNewDiagnostics: dedupes the same file appearing twice', () => {
  const f = tmpFile('h.js', GOOD);
  svc.captureBaseline(f);
  fs.writeFileSync(f, BAD, 'utf-8');
  const diag = svc.collectNewDiagnostics([f, f]); // duplicate
  assert.strictEqual(diag.fileCount, 1);
});

test('never throws on bad input', () => {
  assert.doesNotThrow(() => svc.captureBaseline());
  assert.doesNotThrow(() => svc.collectNewDiagnostics());
  assert.doesNotThrow(() => svc.collectNewDiagnostics(null));
  assert.deepStrictEqual(svc.collectNewDiagnostics(), { issueCount: 0, fileCount: 0, perFile: [] });
});
