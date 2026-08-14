'use strict';

/**
 * prCreate.test.js — revived `khy pr` command + prCreateService wiring.
 *
 * Covers the pure surfaces (no real git / gh / glab IO):
 *  - prCreateService.buildDescriptionPrompt: includes diff context + rules
 *  - prCreateService.createPR: platform-absent fail-soft path
 *  - handlers/pr.buildCreateOptions: flag/arg → options mapping
 *  - handlers/pr.handlePr: injects callModel into createPR, renders + --json
 */

const { test } = require('node:test');
const assert = require('node:assert');

const prSvc = require('../src/services/prCreateService');
const { handlePr, buildCreateOptions } = require('../src/cli/handlers/pr');

// ── prCreateService.buildDescriptionPrompt ──────────────────────────

test('buildDescriptionPrompt embeds commit log / diff stat / diff + rules', () => {
  const out = prSvc.buildDescriptionPrompt(
    { log: 'abc123 fix bug', diffStat: ' 1 file changed', diff: '-old\n+new' },
    { userContext: 'closes #42' }
  );
  assert.match(out, /abc123 fix bug/);
  assert.match(out, /1 file changed/);
  assert.match(out, /\+new/);
  assert.match(out, /TITLE:/);
  assert.match(out, /Developer notes: closes #42/);
});

test('buildDescriptionPrompt is fail-soft on empty context', () => {
  const out = prSvc.buildDescriptionPrompt({}, {});
  assert.match(out, /\(no commits\)/);
  assert.match(out, /\(no diff\)/);
});

// ── handlers/pr.buildCreateOptions (pure) ───────────────────────────

test('buildCreateOptions maps flags and positional args', () => {
  const opt = buildCreateOptions(['closes', '#42'], { base: 'main', draft: true });
  assert.equal(opt.base, 'main');
  assert.equal(opt.draft, true);
  assert.equal(opt.userContext, 'closes #42');
});

test('buildCreateOptions: explicit title/body skip AI, ignores dash tokens', () => {
  const opt = buildCreateOptions(['--verbose'], { title: 'My PR', body: 'details' });
  assert.equal(opt.title, 'My PR');
  assert.equal(opt.body, 'details');
  assert.ok(!('userContext' in opt));
});

test('buildCreateOptions: empty input yields empty options', () => {
  const opt = buildCreateOptions([], {});
  assert.deepEqual(opt, {});
});

// ── handlers/pr.handlePr (injected createPR / callModel) ─────────────

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
  assert.equal(ok, true);
  assert.ok(captured, 'createPR was invoked');
  assert.equal(typeof captured.deps.callModel, 'function');
  assert.equal(captured.options.base, 'dev');
  assert.equal(captured.options.userContext, 'hello');
});

test('handlePr defaults subCommand to create and is fail-soft on throw', async () => {
  const ok = await handlePr(undefined, [], { json: true }, {
    createPR: async () => { throw new Error('boom'); },
  });
  assert.equal(ok, true); // never throws into the CLI
});

test('handlePr help path does not call createPR', async () => {
  let called = false;
  const ok = await handlePr('help', [], {}, { createPR: async () => { called = true; return {}; } });
  assert.equal(ok, true);
  assert.equal(called, false);
});

// ── prCreateService.createPR platform-absent fail-soft ──────────────

test('createPR returns a helpful error when no gh/glab present', async () => {
  // detectPlatform shells out to gh/glab; in CI neither is guaranteed.
  // Either it finds a platform (and fails later on branch) or reports none —
  // both must be a structured {success:false} object, never a throw.
  const res = await prSvc.createPR(
    { callModel: async () => ({ reply: 'TITLE: t\n---\nBODY:\nx' }) },
    { cwd: '/nonexistent-path-khy-pr-test' }
  );
  assert.equal(typeof res, 'object');
  assert.equal(res.success, false);
  assert.equal(typeof res.error, 'string');
});
