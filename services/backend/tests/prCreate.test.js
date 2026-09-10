'use strict';
/**
 * prCreate.test.js �?revived `khy pr` command + prCreateService wiring.
 *
 * Covers the pure surfaces (no real git / gh / glab IO):
 *  - prCreateService.buildDescriptionPrompt: includes diff context + rules
 *  - prCreateService.createPR: platform-absent fail-soft path
 *  - handlers/pr.buildCreateOptions: flag/arg �?options mapping
 *  - handlers/pr.handlePr: injects callModel into createPR, renders + --json
 */
const prSvc = require('../src/services/prCreateService');
const { handlePr, buildCreateOptions } = require('../src/cli/handlers/pr');
// ── prCreateService.buildDescriptionPrompt ──────────────────────────
// ── handlers/pr.buildCreateOptions (pure) ───────────────────────────
// ── handlers/pr.handlePr (injected createPR / callModel) ─────────────
// ── prCreateService.createPR platform-absent fail-soft ──────────────

describe('Pr Create', () => {
  test('buildDescriptionPrompt embeds commit log / diff stat / diff + rules', async () => {
      const out = prSvc.buildDescriptionPrompt(
        { log: 'abc123 fix bug', diffStat: ' 1 file changed', diff: '-old\n+new' },
        { userContext: 'closes #42' }
      );
      expect(out).toMatch(/abc123 fix bug/);
      expect(out).toMatch(/1 file changed/);
      expect(out).toMatch(/\+new/);
      expect(out).toMatch(/TITLE:/);
      expect(out).toMatch(/Developer notes: closes #42/);
  });

  test('buildDescriptionPrompt is fail-soft on empty context', async () => {
      const out = prSvc.buildDescriptionPrompt({}, {});
      expect(out).toMatch(/\(no commits\)/);
      expect(out).toMatch(/\(no diff\)/);
  });

  test('buildCreateOptions maps flags and positional args', async () => {
      const opt = buildCreateOptions(['closes', '#42'], { base: 'main', draft: true });
      expect(opt.base).toBe('main');
      expect(opt.draft).toBe(true);
      expect(opt.userContext).toBe('closes #42');
  });

  test('buildCreateOptions: explicit title/body skip AI, ignores dash tokens', async () => {
      const opt = buildCreateOptions(['--verbose'], { title: 'My PR', body: 'details' });
      expect(opt.title).toBe('My PR');
      expect(opt.body).toBe('details');
      expect(!('userContext' in opt).toBeTruthy());
  });

  test('buildCreateOptions: empty input yields empty options', async () => {
      const opt = buildCreateOptions([], {});
      assert.deepEqual(opt, {});
  });

  test('handlePr passes a callModel dep and parsed options to createPR', async () => {
      let captured = null;
      const fakeCreatePR = async (deps, options) => {
        captured = { deps, options };
        return { success: true, url: 'https://github.com/o/r/pull/1', title: 'T' };
      };
      const ok = await handlePr('create', ['hello'], { base: 'dev', json: true }, {
        createPR: fakeCreatePR,
        callModel: async () => ({ reply: 'x' }),
      });
      expect(ok).toBe(true);
      expect(captured).toBeTruthy();
      expect(typeof captured.deps.callModel).toBe('function');
      expect(captured.options.base).toBe('dev');
      expect(captured.options.userContext).toBe('hello');
  });

  test('handlePr defaults subCommand to create and is fail-soft on throw', async () => {
      const ok = await handlePr(undefined, [], { json: true }, {
        createPR: async () => { throw new Error('boom'); },
      });
      expect(ok).toBe(true); // never throws into the CLI
  });

  test('handlePr help path does not call createPR', async () => {
      let called = false;
      const ok = await handlePr('help', [], {}, { createPR: async () => { called = true; return {}; } });
      expect(ok).toBe(true);
      expect(called).toBe(false);
  });

  test('createPR returns a helpful error when no gh/glab present', async () => {
      // detectPlatform shells out to gh/glab; in CI neither is guaranteed.
      // Either it finds a platform (and fails later on branch) or reports none �?
      // both must be a structured {success:false} object, never a throw.
      const res = await prSvc.createPR(
        { callModel: async () => ({ reply: 'TITLE: t\n---\nBODY:\nx' }) },
        { cwd: '/nonexistent-path-khy-pr-test' }
      );
      expect(typeof res).toBe('object');
      expect(res.success).toBe(false);
      expect(typeof res.error).toBe('string');
  });

});

