'use strict';
/**
 * ciStatus.test.js �?revived `khy ci` command + ciStatusService wiring.
 *
 * Covers the pure surfaces (no real git / gh / glab IO):
 *  - ciStatusService.classifyCi: status/conclusion �?pass/fail/pending/unknown
 *  - handlers/ci.buildStatusOptions: flag �?options mapping
 *  - handlers/ci.formatClassification: label rendering (no throw)
 *  - handlers/ci.handleCi: injects checkCIStatus/pollCIStatus, --json, fail-soft
 */
const ciSvc = require('../src/services/ciStatusService');
const { handleCi, buildStatusOptions, formatClassification } = require('../src/cli/handlers/ci');
// ── ciStatusService.classifyCi (pure) ───────────────────────────────
// ── handlers/ci.buildStatusOptions (pure) ───────────────────────────
// ── handlers/ci.formatClassification (pure, no throw) ───────────────
// ── handlers/ci.handleCi (injected services) ────────────────────────
// ── ciStatusService.checkCIStatus platform-absent fail-soft ─────────

describe('Ci Status', () => {
  test('classifyCi maps GitHub completed/success �?pass', async () => {
      expect(ciSvc.classifyCi('completed')).toBe('success');
      expect(ciSvc.classifyCi('completed')).toBe('');
  });

  test('classifyCi maps failures and in-progress correctly', async () => {
      expect(ciSvc.classifyCi('completed')).toBe('failure');
      expect(ciSvc.classifyCi('failed')).toBe('fail');
      expect(ciSvc.classifyCi('in_progress')).toBe('pending');
      expect(ciSvc.classifyCi('queued')).toBe('pending');
      expect(ciSvc.classifyCi('something-weird')).toBe('unknown');
  });

  test('buildStatusOptions maps branch/cwd flags', async () => {
      const opt = buildStatusOptions({ branch: 'feat/x', cwd: '/tmp/repo' });
      expect(opt.branch).toBe('feat/x');
      expect(opt.cwd).toBe('/tmp/repo');
  });

  test('buildStatusOptions: empty input yields empty options', async () => {
      assert.deepEqual(buildStatusOptions({}), {});
      assert.deepEqual(buildStatusOptions(), {});
  });

  test('formatClassification returns a non-empty string for every class', async () => {
      for (const c of ['pass', 'fail', 'pending', 'unknown', '', undefined]) {
        const s = formatClassification(c);
        expect(typeof s).toBe('string');
        expect(s.length > 0).toBeTruthy();
      }
  });

  test('handleCi status passes parsed options to checkCIStatus and emits --json', async () => {
      let captured = null;
      const ok = await handleCi('status', [], { branch: 'dev', json: true }, {
        checkCIStatus: (opt) => { captured = opt; return { platform: 'github', classification: 'pass', status: 'completed' }; },
      });
      expect(ok).toBe(true);
      expect(captured).toBeTruthy();
      expect(captured.branch).toBe('dev');
  });

  test('handleCi defaults subCommand to status', async () => {
      let called = false;
      const ok = await handleCi(undefined, [], { json: true }, {
        checkCIStatus: () => { called = true; return { platform: 'github', classification: 'pending', status: 'queued' }; },
      });
      expect(ok).toBe(true);
      expect(called).toBe(true);
  });

  test('handleCi watch delegates to pollCIStatus and is fail-soft on throw', async () => {
      let polled = false;
      const ok = await handleCi('watch', [], { json: true }, {
        pollCIStatus: async () => { polled = true; throw new Error('boom'); },
      });
      expect(ok).toBe(true); // never throws into the CLI
      expect(polled).toBe(true);
  });

  test('handleCi help path does not call the service', async () => {
      let called = false;
      const ok = await handleCi('help', [], {}, { checkCIStatus: () => { called = true; return {}; } });
      expect(ok).toBe(true);
      expect(called).toBe(false);
  });

  test('checkCIStatus returns a structured object, never throws', async () => {
      // gh/glab shell-outs may be absent; either a platform result or an {error}.
      const res = ciSvc.checkCIStatus({ cwd: '/nonexistent-path-khy-ci-test' });
      expect(typeof res).toBe('object');
      expect('error' in res || 'classification' in res).toBeTruthy();
  });

});

