'use strict';

/**
 * changeWatchService — thin-IO watcher tests (node:test).
 *
 * Drives the resident change-watcher through injected fakes (no real git/fs):
 * detection-signature de-dup (re-validate only when the working tree changed),
 * verdict persistence, proactive feedback emission + speak de-dup, gate off,
 * non-source-only changes → uncertain, validation throwing → uncertain, and
 * markConsumed. checkOnce/start are async (real validateFiles is async); tests
 * await them. Deterministic: all IO is injected.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../src/services/changeWatchService');

function makeHarness(scriptedDetections, validateImpl, env = {}) {
  let i = 0;
  const records = [];
  const feedbacks = [];
  const store = {
    write: (rec) => { records.push(JSON.parse(JSON.stringify(rec))); },
    read: () => (records.length ? records[records.length - 1] : null),
  };
  const w = svc.create({
    projectDir: '/repo',
    env,
    detectChanges: () => scriptedDetections[Math.min(i++, scriptedDetections.length - 1)],
    validate: validateImpl,
    store,
    onFeedback: (f) => feedbacks.push(f),
    logger: () => {},
  });
  return { w, records, feedbacks, store };
}

test('isWatchEnabled: default-on; {0,false,off,no} disable', () => {
  assert.equal(svc.isWatchEnabled({}), true);
  assert.equal(svc.isWatchEnabled({ KHY_CHANGE_WATCH: 'off' }), false);
  assert.equal(svc.isWatchEnabled({ KHY_CHANGE_WATCH: '1' }), true);
});

test('clean tree (empty signature) → no change, no record', async () => {
  const { w, records } = makeHarness(
    [{ files: [], signature: '' }],
    () => ({ syntax: [], guards: [] }),
  );
  const r = await w.checkOnce();
  assert.equal(r.changed, false);
  assert.equal(records.length, 0);
});

test('same signature twice → validates once (de-dup on detection signature)', async () => {
  let calls = 0;
  const det = { files: ['a.js'], signature: 'sig-1' };
  const { w } = makeHarness(
    [det, det],
    () => { calls++; return { syntax: [], guards: [] }; },
  );
  await w.checkOnce();
  await w.checkOnce();
  assert.equal(calls, 1);
});

test('incorrect change → persists incorrect verdict + emits feedback', async () => {
  const { w, records, feedbacks } = makeHarness(
    [{ files: ['bad.js'], signature: 's1' }],
    () => ({ syntax: [{ file: 'bad.js', line: 2, message: 'Unexpected token' }], guards: [] }),
  );
  const r = await w.checkOnce();
  assert.equal(r.changed, true);
  assert.equal(r.verdict.verdict, 'incorrect');
  assert.equal(records.length, 1);
  assert.equal(records[0].verdict, 'incorrect');
  assert.equal(records[0].consumed, false);
  assert.equal(feedbacks.length, 1);
  assert.match(feedbacks[0].directive, /不对/);
});

test('correct change → persists correct verdict', async () => {
  const { w, records } = makeHarness(
    [{ files: ['ok.js'], signature: 's-ok' }],
    () => ({ syntax: [], guards: [] }),
  );
  const r = await w.checkOnce();
  assert.equal(r.verdict.verdict, 'correct');
  assert.equal(records[0].verdict, 'correct');
});

test('async validate (Promise) is awaited — incorrect verdict not masked', async () => {
  // Regression: validateFiles is async; an un-awaited Promise would always read as
  // "correct" (truthy, no syntax/guards). Ensure the async result is honoured.
  const { w } = makeHarness(
    [{ files: ['bad.js'], signature: 's-async' }],
    async () => ({ syntax: [{ file: 'bad.js', message: 'boom' }], guards: [] }),
  );
  const r = await w.checkOnce();
  assert.equal(r.verdict.verdict, 'incorrect');
});

test('non-source-only change → uncertain (nothing-checked), validate not called', async () => {
  let called = false;
  const { w, records } = makeHarness(
    [{ files: ['README.md', 'logo.png'], signature: 's-doc' }],
    () => { called = true; return { syntax: [], guards: [] }; },
  );
  const r = await w.checkOnce();
  assert.equal(called, false); // no validatable source → validator skipped
  assert.equal(r.verdict.verdict, 'uncertain');
  assert.equal(records[0].reason, 'nothing-checked');
});

test('validator throws → uncertain (fail-soft, no crash)', async () => {
  const { w, records } = makeHarness(
    [{ files: ['x.js'], signature: 's-throw' }],
    () => { throw new Error('guard exploded'); },
  );
  const r = await w.checkOnce();
  assert.equal(r.verdict.verdict, 'uncertain');
  assert.equal(records[0].verdict, 'uncertain');
});

test('speak de-dup: same verdict across different detection sigs spoken once', async () => {
  const { w, feedbacks } = makeHarness(
    [
      { files: ['a.js'], signature: 'd1' },
      { files: ['a.js'], signature: 'd2' }, // tree changed again, same clean verdict
    ],
    () => ({ syntax: [], guards: [] }),
  );
  await w.checkOnce();
  await w.checkOnce();
  assert.equal(feedbacks.length, 1); // verdict identical → spoke only the first time
});

test('gate off → checkOnce is a no-op', async () => {
  const { w, records } = makeHarness(
    [{ files: ['a.js'], signature: 's' }],
    () => ({ syntax: [], guards: [] }),
    { KHY_CHANGE_WATCH: 'off' },
  );
  const r = await w.checkOnce();
  assert.equal(r.changed, false);
  assert.equal(records.length, 0);
});

test('markConsumed flips persisted consumed flag', async () => {
  const { w, store } = makeHarness(
    [{ files: ['bad.js'], signature: 's1' }],
    () => ({ syntax: [{ file: 'bad.js', message: 'boom' }], guards: [] }),
  );
  await w.checkOnce();
  assert.equal(store.read().consumed, false);
  assert.equal(w.markConsumed(), true);
  assert.equal(store.read().consumed, true);
});

test('cross-process dedup: fresh instance skips re-validation when persisted detectSignature matches', async () => {
  // Simulate a prior run (e.g. the daemon) having validated this exact tree state.
  const shared = [];
  const store = {
    write: (rec) => { shared.length = 0; shared.push(JSON.parse(JSON.stringify(rec))); },
    read: () => (shared.length ? shared[0] : null),
  };
  let calls = 0;
  const validate = () => { calls++; return { syntax: [], guards: [] }; };
  const det = () => ({ files: ['a.js'], signature: 'tree-sig-1' });

  const first = svc.create({ projectDir: '/r', detectChanges: det, validate, store, logger: () => {} });
  await first.checkOnce();
  assert.equal(calls, 1); // first run validates

  // A brand-new instance (fresh process) with empty in-memory state, same tree.
  const second = svc.create({ projectDir: '/r', detectChanges: det, validate, store, logger: () => {} });
  const r = await second.checkOnce();
  assert.equal(calls, 1); // re-validation skipped via persisted detectSignature
  assert.equal(r.changed, false);
});

// ── code-level, AI-independent injection channel ─────────────────────────────

test('consumePendingInjection: returns directive once, then null (consumed flag dedup)', async () => {
  const { w } = makeHarness(
    [{ files: ['bad.js'], signature: 's1' }],
    () => ({ syntax: [{ file: 'bad.js', message: 'boom' }], guards: [] }),
  );
  await w.checkOnce(); // persists an unconsumed incorrect verdict
  const first = w.consumePendingInjection();
  assert.ok(first && /不对/.test(first.directive)); // delivered deterministically, no LLM
  assert.equal(first.verdict, 'incorrect');
  const second = w.consumePendingInjection();
  assert.equal(second, null); // already consumed → not re-injected
});

test('consumePendingInjection: no record → null; gate off → null', async () => {
  const { w } = makeHarness([{ files: [], signature: '' }], () => ({ syntax: [], guards: [] }));
  assert.equal(w.consumePendingInjection(), null); // nothing persisted yet

  const off = makeHarness(
    [{ files: ['a.js'], signature: 's' }],
    () => ({ syntax: [{ file: 'a.js', message: 'x' }], guards: [] }),
    { KHY_CHANGE_WATCH: 'off' },
  );
  await off.w.checkOnce();
  assert.equal(off.w.consumePendingInjection(), null); // gate off → silent
});

test('multi-consumer: each distinct consumer gets the same verdict exactly once', async () => {
  const { w } = makeHarness(
    [{ files: ['bad.js'], signature: 's1' }],
    () => ({ syntax: [{ file: 'bad.js', message: 'boom' }], guards: [] }),
  );
  await w.checkOnce();
  // khyos-internal takes it once
  assert.ok(w.consumePendingInjection('khy-internal'));
  assert.equal(w.consumePendingInjection('khy-internal'), null);
  // a separate external tool still gets its own copy (not starved by the internal ack)
  const ext = w.consumePendingInjection('claude-code');
  assert.ok(ext && /不对/.test(ext.directive));
  assert.equal(ext.verdict, 'incorrect');
  assert.equal(w.consumePendingInjection('claude-code'), null); // once per consumer
  // a third tool likewise gets it once
  assert.ok(w.consumePendingInjection('cursor'));
});

test('pendingFor (peek) returns feedback without acking', async () => {
  const { w } = makeHarness(
    [{ files: ['bad.js'], signature: 's1' }],
    () => ({ syntax: [{ file: 'bad.js', message: 'boom' }], guards: [] }),
  );
  await w.checkOnce();
  assert.ok(w.pendingFor('claude-code'));      // peek
  assert.ok(w.pendingFor('claude-code'));      // still pending (peek did not ack)
  assert.ok(w.consumePendingInjection('claude-code')); // now consume
  assert.equal(w.pendingFor('claude-code'), null);     // acked → no longer pending
});

test('record carries the public contract fields (schemaVersion/text/ackedBy)', async () => {
  const { w, records } = makeHarness(
    [{ files: ['ok.js'], signature: 's-ok' }],
    () => ({ syntax: [], guards: [] }),
  );
  await w.checkOnce();
  const rec = records[0];
  assert.equal(rec.schemaVersion, svc.SCHEMA_VERSION);
  assert.equal(typeof rec.text, 'string');
  assert.ok(Array.isArray(rec.ackedBy));
});

test('makePrePromptInjector: pending directive → {action:modify, additionalContext}', async () => {
  const inject = svc.makePrePromptInjector(() => ({ directive: '[SYSTEM: 这次改动不对]' }));
  const r = await inject({ prompt: 'hi', iteration: 1 });
  assert.equal(r.action, 'modify');
  assert.equal(r.additionalContext, '[SYSTEM: 这次改动不对]');
});

test('makePrePromptInjector: no pending → allow; consume throws → allow (fail-soft)', async () => {
  const none = svc.makePrePromptInjector(() => null);
  assert.deepEqual(await none({}), { action: 'allow' });
  const boom = svc.makePrePromptInjector(() => { throw new Error('store down'); });
  assert.deepEqual(await boom({}), { action: 'allow' }); // never blocks the AI pipeline
});

test('start/stop: start runs an immediate check then is idempotent', async () => {
  const { w, records } = makeHarness(
    [{ files: ['a.js'], signature: 's' }],
    () => ({ syntax: [], guards: [] }),
  );
  const r1 = await w.start({ intervalMs: 999999 });
  assert.equal(r1.started, true);
  assert.equal(records.length, 1); // immediate check fired + awaited
  const r2 = await w.start({ intervalMs: 999999 });
  assert.equal(r2.started, false); // already running
  assert.equal(w.stop().stopped, true);
});

// ── projectDir 锚定到 git 仓库顶层(修复:子目录 cwd 下改动集/校验全「找不到」误报)──────
test('_repoRootAnchorEnabled: default-on; {0,false,off,no} disable', () => {
  assert.equal(svc._repoRootAnchorEnabled({}), true);
  assert.equal(svc._repoRootAnchorEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(svc._repoRootAnchorEnabled({ KHY_CHANGE_WATCH_REPO_ROOT: off }), false, `off=${off}`);
  }
  assert.equal(svc._repoRootAnchorEnabled({ KHY_CHANGE_WATCH_REPO_ROOT: '1' }), true);
});

test('auto-resolved projectDir anchors to git top-level (gate on); byte-reverts to raw cwd (gate off)', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const cp = require('node:child_process');

  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cw-anchor-'));
  try {
    cp.execSync('git init -q', { cwd: top });
    const sub = path.join(top, 'services', 'backend');
    fs.mkdirSync(sub, { recursive: true });
    const realTop = fs.realpathSync(top); // git rev-parse returns realpath-resolved

    // gate on (default): cwd in a subdir → projectDir anchored to the repo top-level.
    const on = svc.create({ env: { KHYQUANT_CWD: sub } });
    assert.equal(on._projectDir, realTop, 'gate-on must anchor subdir cwd to repo top');

    // gate off: byte-revert to today's behavior (raw cwd, unanchored).
    const off = svc.create({ env: { KHYQUANT_CWD: sub, KHY_CHANGE_WATCH_REPO_ROOT: 'off' } });
    assert.equal(off._projectDir, sub, 'gate-off must keep the raw subdir cwd');

    // explicit deps.projectDir is always respected verbatim (existing tests + deliberate callers).
    const explicit = svc.create({ projectDir: '/repo', env: { KHYQUANT_CWD: sub } });
    assert.equal(explicit._projectDir, '/repo', 'explicit projectDir must be respected unchanged');
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test('non-git dir: anchoring falls back to the raw cwd (fail-soft)', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');

  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-cw-nogit-'));
  try {
    const w = svc.create({ env: { KHYQUANT_CWD: bare } });
    assert.equal(w._projectDir, bare, 'non-git → rev-parse fails → keep raw cwd');
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

// ── 排除守卫自测夹具(scripts/tests/*.test.js 的设计基线违规 ≠ 本次改动的真实回归)────────
test('_guardFixtureExclusionEnabled: default-on; {0,false,off,no} disable', () => {
  assert.equal(svc._guardFixtureExclusionEnabled({}), true);
  assert.equal(svc._guardFixtureExclusionEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(svc._guardFixtureExclusionEnabled({ KHY_CHANGE_WATCH_SKIP_GUARD_FIXTURES: off }), false, `off=${off}`);
  }
  assert.equal(svc._guardFixtureExclusionEnabled({ KHY_CHANGE_WATCH_SKIP_GUARD_FIXTURES: '1' }), true);
});

test('_isGuardSelfTestFixture: matches scripts/tests/*.test.js only', () => {
  assert.equal(svc._isGuardSelfTestFixture('scripts/tests/leaf-contract.test.js'), true);
  assert.equal(svc._isGuardSelfTestFixture('scripts/tests/flag-registry.test.js'), true);
  assert.equal(svc._isGuardSelfTestFixture('some/nested/scripts/tests/x.test.js'), true);
  // real source / real product tests must NOT be excluded.
  assert.equal(svc._isGuardSelfTestFixture('services/backend/tests/changeWatchService.test.js'), false);
  assert.equal(svc._isGuardSelfTestFixture('scripts/check-leaf-contract.js'), false);
  assert.equal(svc._isGuardSelfTestFixture('scripts/tests/helper.js'), false); // not a *.test.js
  assert.equal(svc._isGuardSelfTestFixture('src/services/changeWatchService.js'), false);
});

test('guard-fixture exclusion: fixture-only failure no longer poisons the verdict (gate on)', async () => {
  // The tree's only "failure" comes from a guard self-test fixture; excluding it → not
  // validated → the real source file (ok.js) is clean → verdict flips to correct.
  let validatedWith = null;
  const { w, records } = makeHarness(
    [{ files: ['scripts/tests/leaf-contract.test.js', 'ok.js'], signature: 'gf-1' }],
    (fileList) => {
      validatedWith = fileList.slice();
      // Simulate primitives flagging the fixture (its intentional IO) but ok.js clean.
      const guards = fileList
        .filter((f) => /scripts\/tests\/.*\.test\.js$/.test(f))
        .map((f) => ({ file: f, severity: 'error', message: '[leaf-io] intentional fixture violation' }));
      return { syntax: [], guards };
    },
  );
  const r = await w.checkOnce();
  assert.deepEqual(validatedWith, ['ok.js'], 'fixture must be dropped from the validatable set');
  assert.equal(r.verdict.verdict, 'correct', 'no fixture in the set → nothing fails → correct');
  assert.equal(records[0].verdict, 'correct');
});

test('guard-fixture exclusion gate off → fixture is validated (byte-revert) and still flags incorrect', async () => {
  let validatedWith = null;
  const { w } = makeHarness(
    [{ files: ['scripts/tests/leaf-contract.test.js', 'ok.js'], signature: 'gf-2' }],
    (fileList) => {
      validatedWith = fileList.slice();
      const guards = fileList
        .filter((f) => /scripts\/tests\/.*\.test\.js$/.test(f))
        .map((f) => ({ file: f, severity: 'error', message: '[leaf-io] intentional fixture violation' }));
      return { syntax: [], guards };
    },
    { KHY_CHANGE_WATCH_SKIP_GUARD_FIXTURES: 'off' },
  );
  const r = await w.checkOnce();
  assert.ok(validatedWith.includes('scripts/tests/leaf-contract.test.js'), 'gate-off must keep the fixture in the set');
  assert.equal(r.verdict.verdict, 'incorrect', 'gate-off reproduces today’s false-positive verbatim');
});

test('guard-fixture exclusion: a real broken source file still yields incorrect', async () => {
  // Excluding fixtures must NOT mask genuine regressions in real source.
  const { w } = makeHarness(
    [{ files: ['scripts/tests/leaf-contract.test.js', 'real.js'], signature: 'gf-3' }],
    (fileList) => ({
      syntax: fileList.includes('real.js') ? [{ file: 'real.js', line: 3, message: 'Unexpected token' }] : [],
      guards: [],
    }),
  );
  const r = await w.checkOnce();
  assert.equal(r.verdict.verdict, 'incorrect', 'real source breakage must survive fixture exclusion');
});

// ── 自基线以来的增量归因(修「整棵累积 WIP 脏树全归因你刚才那次改动」)──────────────────
function persistentStore() {
  let rec = null;
  return {
    write: (r) => { rec = JSON.parse(JSON.stringify(r)); },
    read: () => (rec ? JSON.parse(JSON.stringify(rec)) : null),
    _peek: () => rec,
  };
}

test('_deltaAttributionEnabled: default-on; {0,false,off,no} disable', () => {
  assert.equal(svc._deltaAttributionEnabled({}), true);
  assert.equal(svc._deltaAttributionEnabled(undefined), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.equal(svc._deltaAttributionEnabled({ KHY_CHANGE_WATCH_DELTA_ATTRIBUTION: off }), false, `off=${off}`);
  }
});

test('delta: first observation establishes baseline silently; only later edits are attributed', async () => {
  const store = persistentStore();
  const validatedWith = [];
  const validate = (fileList) => {
    validatedWith.push(fileList.slice());
    return { syntax: fileList.filter((f) => f === 'broken.js').map((f) => ({ file: f, message: 'boom' })), guards: [] };
  };
  // det1: a big PRE-EXISTING dirty tree that already contains a broken file — none of it is "yours".
  const det1 = {
    files: ['pre1.js', 'pre2.js', 'broken.js'], signature: 'sig1',
    fileSigs: { 'pre1.js': '1:10', 'pre2.js': '1:10', 'broken.js': '1:10' },
  };
  // det2: the user edits ONE brand-new file; the pre-existing broken.js is left untouched.
  const det2 = {
    files: ['pre1.js', 'pre2.js', 'broken.js', 'fresh.js'], signature: 'sig2',
    fileSigs: { 'pre1.js': '1:10', 'pre2.js': '1:10', 'broken.js': '1:10', 'fresh.js': '2:20' },
  };
  const seq = [det1, det2]; let i = 0;
  const w = svc.create({ projectDir: '/repo', detectChanges: () => seq[Math.min(i++, seq.length - 1)], validate, store, logger: () => {} });

  const r1 = await w.checkOnce();
  assert.equal(r1.changed, false, 'first obs must NOT attribute the pre-existing tree');
  assert.equal(r1.baseline, 'baseline-established');
  assert.equal(validatedWith.length, 0, 'nothing validated on baseline establishment');
  assert.equal(store._peek().directive, '', 'baseline record injects nothing');
  assert.ok(store._peek().detectBaseline, 'baseline persisted for the next process');

  const r2 = await w.checkOnce();
  assert.equal(r2.changed, true);
  assert.deepEqual(validatedWith[0], ['fresh.js'], 'only the newly-edited file is attributed — NOT the pre-existing broken.js');
  assert.equal(r2.verdict.verdict, 'correct', 'the untouched pre-existing broken.js must not poison the verdict');
});

test('delta: a genuinely-new broken edit IS attributed (targeted, not the whole tree)', async () => {
  const store = persistentStore();
  const validatedWith = [];
  const validate = (fileList) => {
    validatedWith.push(fileList.slice());
    return { syntax: fileList.map((f) => ({ file: f, line: 1, message: 'Unexpected token' })), guards: [] };
  };
  const det1 = { files: ['a.js', 'b.js'], signature: 's1', fileSigs: { 'a.js': '1:1', 'b.js': '1:1' } };
  const det2 = { files: ['a.js', 'b.js'], signature: 's2', fileSigs: { 'a.js': '1:1', 'b.js': '9:9' } }; // b.js edited
  const seq = [det1, det2]; let i = 0;
  const w = svc.create({ projectDir: '/repo', detectChanges: () => seq[Math.min(i++, seq.length - 1)], validate, store, logger: () => {} });
  await w.checkOnce();                     // baseline {a,b}
  const r = await w.checkOnce();           // only b.js changed
  assert.deepEqual(validatedWith[0], ['b.js'], 'only the changed file is attributed');
  assert.equal(r.verdict.verdict, 'incorrect');
  assert.equal(r.verdict.failures.length, 1, 'exactly the one changed file is blamed');
});

test('delta gate off → whole dirty tree attributed on first observation (byte-revert)', async () => {
  const store = persistentStore();
  const validatedWith = [];
  const validate = (fileList) => {
    validatedWith.push(fileList.slice());
    return { syntax: fileList.filter((f) => f === 'broken.js').map((f) => ({ file: f, message: 'boom' })), guards: [] };
  };
  const det1 = { files: ['pre1.js', 'broken.js'], signature: 's1', fileSigs: { 'pre1.js': '1:1', 'broken.js': '1:1' } };
  const w = svc.create({
    projectDir: '/repo', detectChanges: () => det1, validate, store,
    env: { KHY_CHANGE_WATCH_DELTA_ATTRIBUTION: 'off' }, logger: () => {},
  });
  const r = await w.checkOnce();
  assert.equal(r.changed, true, 'gate off: no baseline concept, validates the whole tree immediately');
  assert.deepEqual(validatedWith[0].slice().sort(), ['broken.js', 'pre1.js']);
  assert.equal(r.verdict.verdict, 'incorrect', 'gate off reproduces today’s whole-tree attribution verbatim');
});

test('delta: baseline recovers across a fresh process via persisted detectBaseline', async () => {
  const store = persistentStore();
  const det1 = { files: ['a.js'], signature: 's1', fileSigs: { 'a.js': '1:1' } };
  const det2 = { files: ['a.js', 'new.js'], signature: 's2', fileSigs: { 'a.js': '1:1', 'new.js': '2:2' } };
  // process 1 establishes the baseline, then exits.
  const p1 = svc.create({ projectDir: '/repo', detectChanges: () => det1, validate: () => ({ syntax: [], guards: [] }), store, logger: () => {} });
  await p1.checkOnce();
  assert.ok(store._peek().detectBaseline, 'baseline persisted');
  // process 2 has empty in-memory state; it must diff against the PERSISTED baseline, not re-attribute a.js.
  const validatedWith = [];
  const p2 = svc.create({ projectDir: '/repo', detectChanges: () => det2, validate: (f) => { validatedWith.push(f.slice()); return { syntax: [], guards: [] }; }, store, logger: () => {} });
  await p2.checkOnce();
  assert.deepEqual(validatedWith[0], ['new.js'], 'fresh process diffs against persisted baseline → only new.js');
});

test('delta: files only leaving the dirty set → baseline advances silently (no attribution)', async () => {
  const store = persistentStore();
  const det1 = { files: ['a.js', 'b.js'], signature: 's1', fileSigs: { 'a.js': '1:1', 'b.js': '1:1' } };
  const det2 = { files: ['a.js'], signature: 's2', fileSigs: { 'a.js': '1:1' } }; // b.js committed/reverted
  const seq = [det1, det2]; let i = 0; let validateCalls = 0;
  const w = svc.create({ projectDir: '/repo', detectChanges: () => seq[Math.min(i++, seq.length - 1)], validate: () => { validateCalls++; return { syntax: [], guards: [] }; }, store, logger: () => {} });
  await w.checkOnce();                     // baseline {a,b}
  const r = await w.checkOnce();           // only a removal → nothing new
  assert.equal(r.changed, false);
  assert.equal(r.baseline, 'baseline-advanced');
  assert.equal(validateCalls, 0, 'nothing validated when only removals occur');
});
