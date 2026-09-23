'use strict';

/**
 * turnCheckpointService — per-turn multi-file atomic rollback.
 *
 * This is the test-first contract for aligning goal A from
 * [DESIGN-ARCH-096] §2-A (按回合撤销深化 / turn-undo):
 *
 *   1. turn-grouped snapshots — `beginTurn` / per-file `record` / `endTurn`
 *      aggregate the pre-edit snapshots a turn takes into one manifest.
 *   2. per-turn atomic multi-file rollback — `rollbackTurn` is two-phase
 *      (validate-all → apply-all); any single-file conflict aborts the WHOLE
 *      turn with ZERO writes (冲突零写入), never a half-rolled state.
 *   3. startup recorder-coverage gate — `validateRecorderCoverage` refuses to
 *      start when a tool that declares mutates_files was not wired into the
 *      recorder (漏接即启动失败).
 *   4. semantic correction block — `buildSemanticCorrection` produces the
 *      "the files written above are now stale, re-verify" context to inject
 *      into the model's next turn after a rollback.
 *
 * Isolation: follows the established node:test pattern
 * (workspaceCheckpointCas.test.js) — fresh tmp data home, env pinned before
 * require, require.cache cleared, env restored + tmp removed in finally.
 */

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const SERVICE_REL = '../../src/services/turnCheckpointService';
const DATAHOME_REL = '../../src/utils/dataHome';

/**
 * Reload the service (and dataHome) against a pinned tmp data home.
 * @param {string} appHome - directory the service should store under
 * @returns {object} the fresh turnCheckpointService module
 */
function loadService(appHome) {
  const svcPath = require.resolve(SERVICE_REL);
  const dhPath = require.resolve(DATAHOME_REL);
  delete require.cache[svcPath];
  delete require.cache[dhPath];
  process.env.KHY_APP_HOME = appHome;
  process.env.KHY_DATA_HOME = appHome;
  return require(SERVICE_REL);
}

function withIsolatedEnv(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-turn-ckpt-'));
  const appHome = path.join(root, 'app-home');
  const proj = path.join(root, 'proj');
  const prevApp = process.env.KHY_APP_HOME;
  const prevData = process.env.KHY_DATA_HOME;
  fs.mkdirSync(appHome, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  try {
    return fn({ root, appHome, proj });
  } finally {
    if (prevApp === undefined) delete process.env.KHY_APP_HOME;
    else process.env.KHY_APP_HOME = prevApp;
    if (prevData === undefined) delete process.env.KHY_DATA_HOME;
    else process.env.KHY_DATA_HOME = prevData;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeProj(proj, rel, content) {
  const abs = path.join(proj, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

// ── 1. turn-grouped snapshots ─────────────────────────────────────────

test('begin/record/end aggregates per-file pre-edit snapshots into one turn manifest', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const a = writeProj(proj, 'a.js', 'v1-a\n');
    const b = writeProj(proj, 'b.js', 'v1-b\n');

    const turnId = svc.beginTurn('sess-1');
    assert.ok(typeof turnId === 'string' && turnId.length > 0);

    // Simulate the write tools' pre-edit snapshot step, tagged with the turn.
    assert.equal(svc.recordMutatedFile(turnId, a, { reason: 'editFile' }).success, true);
    assert.equal(svc.recordMutatedFile(turnId, b, { reason: 'writeFile' }).success, true);

    const manifest = svc.endTurn(turnId);
    assert.equal(manifest.success, true);
    const files = manifest.turn.files.map((f) => f.path).sort();
    assert.deepEqual(files, [a, b].sort());
    // Each file recorded its PRE-edit content.
    const aEntry = manifest.turn.files.find((f) => f.path === a);
    assert.equal(aEntry.preContent, 'v1-a\n');
  });
});

test('duplicate record of the same file within a turn keeps the first pre-content', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const a = writeProj(proj, 'a.js', 'first\n');
    const turnId = svc.beginTurn('sess-2');
    svc.recordMutatedFile(turnId, a, { reason: 'editFile' });
    fs.writeFileSync(a, 'second\n');
    // Second record of the same file in the same turn must not clobber the
    // original pre-content we captured before the first write.
    const res = svc.recordMutatedFile(turnId, a, { reason: 'editFile' });
    assert.equal(res.success, true);
    assert.equal(res.duplicate, true);
    svc.endTurn(turnId);
    const state = svc.loadTurn(turnId);
    assert.equal(state.files.length, 1);
    assert.equal(state.files[0].preContent, 'first\n');
  });
});

test('unknown turnId fails cleanly, never throws', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const r = svc.endTurn('no-such-turn');
    assert.equal(r.success, false);
    assert.match(String(r.error), /no turn|unknown|not found/i);
  });
});

// ── 2. per-turn atomic multi-file rollback + conflict zero-write ─────

test('rollbackTurn restores every file in the turn to its pre-edit content', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const a = writeProj(proj, 'a.js', 'A-before\n');
    const b = writeProj(proj, 'b.js', 'B-before\n');
    const turnId = svc.beginTurn('sess-3');
    svc.recordMutatedFile(turnId, a, { reason: 'editFile' });
    svc.recordMutatedFile(turnId, b, { reason: 'editFile' });
    svc.endTurn(turnId);

    // The turn "happened": files mutated after their snapshots.
    fs.writeFileSync(a, 'A-after\n');
    fs.writeFileSync(b, 'B-after\n');

    const r = svc.rollbackTurn(turnId);
    assert.equal(r.success, true);
    assert.equal(r.restored, true);
    assert.equal(r.conflicts, 0);
    assert.equal(fs.readFileSync(a, 'utf8'), 'A-before\n');
    assert.equal(fs.readFileSync(b, 'utf8'), 'B-before\n');
    // Rollback is terminal for the turn.
    assert.equal(svc.loadTurn(turnId).status, 'rolledback');
  });
});

test('rollbackTurn is CONFLICT ZERO-WRITE: one conflicted file aborts the whole turn', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const a = writeProj(proj, 'a.js', 'A-before\n');
    const b = writeProj(proj, 'b.js', 'B-before\n');
    const turnId = svc.beginTurn('sess-4');
    svc.recordMutatedFile(turnId, a, { reason: 'editFile' });
    svc.recordMutatedFile(turnId, b, { reason: 'editFile' });
    svc.endTurn(turnId);

    // a.js: the content the turn expected to undo is in place (clean).
    fs.writeFileSync(a, 'A-after\n');
    // b.js: EXTERNAL change happened after the turn closed (conflict) — its
    // current content no longer matches what the turn assumed.
    fs.writeFileSync(b, 'B-externally-modified\n');

    const r = svc.rollbackTurn(turnId, { expectedContents: { [b]: 'B-after\n' } });
    // The turn must be reported as conflicted and NOTHING written.
    assert.equal(r.success, false);
    assert.equal(r.restored, false);
    assert.equal(r.conflicts, 1);
    assert.deepEqual(r.conflictedFiles, [b]);
    // ZERO-WRITE proof: a.js is untouched even though it was clean.
    assert.equal(fs.readFileSync(a, 'utf8'), 'A-after\n');
    assert.equal(fs.readFileSync(b, 'utf8'), 'B-externally-modified\n');
  });
});

test('rollbackTurn default (no expectedContents) restores any current content back to pre-edit', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const a = writeProj(proj, 'a.js', 'v0\n');
    const turnId = svc.beginTurn('sess-5');
    svc.recordMutatedFile(turnId, a, { reason: 'writeFile' });
    svc.endTurn(turnId);
    fs.writeFileSync(a, 'v1\n');
    const r = svc.rollbackTurn(turnId);
    assert.equal(r.success, true);
    assert.equal(fs.readFileSync(a, 'utf8'), 'v0\n');
  });
});

test('rollbackTurn to a rolledback turn is idempotent and refused (no re-apply)', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const a = writeProj(proj, 'a.js', 'v0\n');
    const turnId = svc.beginTurn('sess-6');
    svc.recordMutatedFile(turnId, a, { reason: 'editFile' });
    svc.endTurn(turnId);
    fs.writeFileSync(a, 'v1\n');
    assert.equal(svc.rollbackTurn(turnId).success, true);
    // Second call: already rolled back → honest refusal, not a re-write.
    const again = svc.rollbackTurn(turnId);
    assert.equal(again.success, false);
    assert.match(String(again.error), /already|rolled|terminal/i);
    assert.equal(fs.readFileSync(a, 'utf8'), 'v0\n'); // unchanged
  });
});

// ── 3. startup recorder-coverage gate ─────────────────────────────────

test('validateRecorderCoverage fails startup when a mutating tool is not wired', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    svc.resetRecorderWiring();
    // A registry where a tool that declares mutates_files is NOT in the
    // built-in first-party set and NOT in the explicit wired set → uncovered.
    // (custom_mutation is deliberately not a built-in mutating tool.)
    const registry = {
      getToolSpecs: () => [
        { name: 'write_file', mutates_files: true }, // built-in, covered
        { name: 'custom_mutation', mutates_files: true }, // the gap
        { name: 'read_file', mutates_files: false },
      ],
    };
    const report = svc.validateRecorderCoverage(registry, ['write_file']);
    assert.equal(report.ok, false);
    assert.deepEqual(report.uncovered, ['custom_mutation']);
  });
});

test('validateRecorderCoverage passes when every mutating tool is wired', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    svc.resetRecorderWiring();
    const registry = {
      getToolSpecs: () => [
        { name: 'write_file', mutates_files: true },
        { name: 'edit_file', mutates_files: true },
        { name: 'custom_mutation', mutates_files: true },
        { name: 'read_file', mutates_files: false },
      ],
    };
    const report = svc.validateRecorderCoverage(registry, ['custom_mutation']);
    assert.equal(report.ok, true);
    assert.deepEqual(report.uncovered, []);
  });
});

test('a registry without getToolSpecs is treated as "no mutating tools" (ok)', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const report = svc.validateRecorderCoverage({});
    assert.equal(report.ok, true);
  });
});

// ── 4. semantic correction block ─────────────────────────────────────

test('buildSemanticCorrection returns an injection block listing rolled-back files', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const a = writeProj(proj, 'a.js', 'v0\n');
    const b = writeProj(proj, 'b.js', 'v0\n');
    const turnId = svc.beginTurn('sess-7');
    svc.recordMutatedFile(turnId, a, { reason: 'editFile' });
    svc.recordMutatedFile(turnId, b, { reason: 'writeFile' });
    svc.endTurn(turnId);
    fs.writeFileSync(a, 'v1\n');
    fs.writeFileSync(b, 'v1\n');

    const r = svc.rollbackTurn(turnId);
    assert.equal(r.success, true);
    const block = svc.buildSemanticCorrection(r, turnId);
    assert.equal(typeof block, 'string');
    assert.match(block, /a\.js/);
    assert.match(block, /b\.js/);
    // It must tell the model the earlier results are now stale.
    assert.match(block, /invalid|stale|no longer|已失效|re-?verify/i);
  });
});

test('buildSemanticCorrection for a non-rolled-back turn returns a short note, not a file list', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const a = writeProj(proj, 'a.js', 'v0\n');
    const turnId = svc.beginTurn('sess-8');
    svc.recordMutatedFile(turnId, a, { reason: 'editFile' });
    svc.endTurn(turnId);
    // No rollback performed yet.
    const block = svc.buildSemanticCorrection({ success: false, restored: false, error: 'no' }, turnId);
    assert.equal(typeof block, 'string');
    assert.ok(block.length > 0);
    assert.doesNotMatch(block, /a\.js/); // nothing rolled back → no file list
  });
});

// ── misc: persistence + listing ───────────────────────────────────────

test('listTurns returns turns newest-first and loadTurn persists across reloads', () => {
  withIsolatedEnv(({ proj }) => {
    const home = path.join(proj, 'app-home');
    const svc = loadService(home);
    const a = writeProj(proj, 'a.js', 'v0\n');
    const t1 = svc.beginTurn('sess-9');
    svc.recordMutatedFile(t1, a, { reason: 'editFile' });
    svc.endTurn(t1);

    // Reload the module fresh (simulates a new process) against the same home.
    const svc2 = loadService(home);
    const loaded = svc2.loadTurn(t1);
    assert.equal(loaded.success, true);
    assert.equal(loaded.status, 'ended');
    assert.equal(loaded.files.length, 1);

    const turns = svc2.listTurns('sess-9');
    assert.ok(Array.isArray(turns));
    assert.ok(turns.some((t) => t.turnId === t1));
  });
});

// ── 5. read-only preview (no writes) ────────────────────────────────

test('previewTurnRollback reports file count and conflicts without writing', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    const a = writeProj(proj, 'a.js', 'before\n');
    const turnId = svc.beginTurn('sess-pv');
    svc.recordMutatedFile(turnId, a, { reason: 'editFile' });
    svc.endTurn(turnId);
    fs.writeFileSync(a, 'after\n');

    const preview = svc.previewTurnRollback(turnId, { [a]: 'external\n' });
    assert.equal(preview.success, true);
    assert.equal(preview.fileCount, 1);
    assert.equal(preview.conflicts, 1);
    assert.deepEqual(preview.conflictedFiles, [a]);
    // Preview is ZERO-WRITE: file content is untouched.
    assert.equal(fs.readFileSync(a, 'utf8'), 'after\n');

    // Clean expected content → zero conflicts.
    const clean = svc.previewTurnRollback(turnId, { [a]: 'after\n' });
    assert.equal(clean.conflicts, 0);
  });
});

// ── 6. first-party coverage gate matches the REAL tool names ────────

test('validateRecorderCoverage recognizes the real first-party mutating tool names', () => {
  withIsolatedEnv(({ proj }) => {
    const svc = loadService(path.join(proj, 'app-home'));
    svc.resetRecorderWiring();
    // The six actual write tools (canonical names from src/tools/*) plus snake
    // aliases must be covered WITHOUT any runtime registration → ok.
    const registry = {
      getToolSpecs: () => [
        { name: 'editFile', mutates_files: true },
        { name: 'writeFile', mutates_files: true },
        { name: 'Edit', mutates_files: true },
        { name: 'Write', mutates_files: true },
        { name: 'apply_patch', mutates_files: true },
        { name: 'MultiEdit', mutates_files: true },
        { name: 'read_file', mutates_files: false },
      ],
    };
    const report = svc.validateRecorderCoverage(registry);
    assert.equal(report.ok, true, `expected all six write tools covered, got uncovered=${JSON.stringify(report.uncovered)}`);
    assert.deepEqual(report.uncovered, []);

    // A brand-new mutating tool (not in the first-party set) is uncovered.
    const reg2 = {
      getToolSpecs: () => [{ name: 'brand_new_mutation', mutates_files: true }],
    };
    const rep2 = svc.validateRecorderCoverage(reg2);
    assert.equal(rep2.ok, false);
    assert.deepEqual(rep2.uncovered, ['brand_new_mutation']);
  });
});
