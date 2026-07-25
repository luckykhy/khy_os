'use strict';

/**
 * ciStatus.test.js — revived `khy ci` command + ciStatusService wiring.
 *
 * Covers the pure surfaces (no real git / gh / glab IO):
 *  - ciStatusService.classifyCi: status/conclusion → pass/fail/pending/unknown
 *  - handlers/ci.buildStatusOptions: flag → options mapping
 *  - handlers/ci.formatClassification: label rendering (no throw)
 *  - handlers/ci.handleCi: injects checkCIStatus/pollCIStatus, --json, fail-soft
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ciSvc = require('../src/services/ciStatusService');
const { handleCi, buildStatusOptions, formatClassification } = require('../src/cli/handlers/ci');

// ── ciStatusService.classifyCi (pure) ───────────────────────────────

test('classifyCi maps GitHub completed/success → pass', () => {
  assert.equal(ciSvc.classifyCi('completed', 'success'), 'pass');
  assert.equal(ciSvc.classifyCi('completed', ''), 'pass');
});

test('classifyCi maps failures and in-progress correctly', () => {
  assert.equal(ciSvc.classifyCi('completed', 'failure'), 'fail');
  assert.equal(ciSvc.classifyCi('failed'), 'fail');
  assert.equal(ciSvc.classifyCi('in_progress'), 'pending');
  assert.equal(ciSvc.classifyCi('queued'), 'pending');
  assert.equal(ciSvc.classifyCi('something-weird'), 'unknown');
});

// ── handlers/ci.buildStatusOptions (pure) ───────────────────────────

test('buildStatusOptions maps branch/cwd flags', () => {
  const opt = buildStatusOptions({ branch: 'feat/x', cwd: '/tmp/repo' });
  assert.equal(opt.branch, 'feat/x');
  assert.equal(opt.cwd, '/tmp/repo');
});

test('buildStatusOptions: empty input yields empty options', () => {
  assert.deepEqual(buildStatusOptions({}), {});
  assert.deepEqual(buildStatusOptions(), {});
});

// ── handlers/ci.formatClassification (pure, no throw) ───────────────

test('formatClassification returns a non-empty string for every class', () => {
  for (const c of ['pass', 'fail', 'pending', 'unknown', '', undefined]) {
    const s = formatClassification(c);
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 0);
  }
});

// ── handlers/ci.handleCi (injected services) ────────────────────────

test('handleCi status passes parsed options to checkCIStatus and emits --json', async () => {
  let captured = null;
  const ok = await handleCi('status', [], { branch: 'dev', json: true }, {
    checkCIStatus: (opt) => { captured = opt; return { platform: 'github', classification: 'pass', status: 'completed' }; },
  });
  assert.equal(ok, true);
  assert.ok(captured, 'checkCIStatus was invoked');
  assert.equal(captured.branch, 'dev');
});

test('handleCi defaults subCommand to status', async () => {
  let called = false;
  const ok = await handleCi(undefined, [], { json: true }, {
    checkCIStatus: () => { called = true; return { platform: 'github', classification: 'pending', status: 'queued' }; },
  });
  assert.equal(ok, true);
  assert.equal(called, true);
});

test('handleCi watch delegates to pollCIStatus and is fail-soft on throw', async () => {
  let polled = false;
  const ok = await handleCi('watch', [], { json: true }, {
    pollCIStatus: async () => { polled = true; throw new Error('boom'); },
  });
  assert.equal(ok, true); // never throws into the CLI
  assert.equal(polled, true);
});

test('handleCi help path does not call the service', async () => {
  let called = false;
  const ok = await handleCi('help', [], {}, { checkCIStatus: () => { called = true; return {}; } });
  assert.equal(ok, true);
  assert.equal(called, false);
});

// ── ciStatusService.checkCIStatus platform-absent fail-soft ─────────

test('checkCIStatus returns a structured object, never throws', () => {
  // gh/glab shell-outs may be absent; either a platform result or an {error}.
  const res = ciSvc.checkCIStatus({ cwd: '/nonexistent-path-khy-ci-test' });
  assert.equal(typeof res, 'object');
  assert.ok('error' in res || 'classification' in res);
});
