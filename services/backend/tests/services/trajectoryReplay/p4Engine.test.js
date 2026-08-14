'use strict';

/**
 * p4Engine.test.js — DESIGN-ARCH-048 PHASE 4 (replay engine).
 *
 * Exercises the engine against a real bundle exported from a recorded ledger,
 * driving re-execution through the live executeTool funnel. Verifies: FILE
 * restoration of a deleted file with matching hash; injected hash mismatch →
 * diverged + divergedAt; NETWORK_AI always skipped; SHELL skipped without
 * pre-approval and replayed with it; env mismatch refused without force and
 * proceeding with it; precondition guard refuses to clobber un-recorded data.
 *
 * KHY_PROJECT_DATA_HOME is set before requiring persistence-touching modules.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-p4-engine-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
// Keep dep-healing off and the shell allow list empty by default.
process.env.KHY_DEP_HEALING = 'off';
delete process.env.KHY_REPLAY_SHELL_ALLOW;

const replayLedger = require('../../../src/services/trajectoryReplay/replayLedger');
const replayBundle = require('../../../src/services/trajectoryReplay/replayBundle');
const replayEngine = require('../../../src/services/trajectoryReplay/replayEngine');
const { sha256Hex } = require('../../../src/services/sourceSnapshotCrypto');

// A scratch workspace for actual file artifacts. The write-path boundary guard
// restricts writes to project/home roots; allow this scratch root explicitly via
// the documented env knob (零硬编码) so replay can re-create files under it.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-p4-work-'));
process.env.KHY_WRITE_EXTRA_ROOTS = WORK;

function recordWrite(sessionId, absPath, content) {
  replayLedger.recordToolTurn({
    sessionId,
    name: 'write_file',
    params: { path: absPath, content },
    result: { success: true },
    writeDiff: { filePath: absPath, beforeContent: '', afterContent: content },
  });
}

test('FILE step restores a deleted file with a matching hash', async () => {
  const sessionId = 'p4-restore';
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, 'restore.txt');
  recordWrite(sessionId, target, 'hello-replay');

  const exp = replayBundle.exportBundle(sessionId);
  assert.strictEqual(exp.ok, true);

  // Delete the artifact, then replay should bring it back.
  if (fs.existsSync(target)) fs.unlinkSync(target);
  assert.ok(!fs.existsSync(target));

  const report = await replayEngine.replay(exp.bundleDir, { force: true });
  assert.strictEqual(report.status, 'completed', JSON.stringify(report));
  assert.strictEqual(report.summary.restored, 1);
  assert.ok(fs.existsSync(target));
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'hello-replay');
});

test('an injected hash mismatch halts with diverged + divergedAt', async () => {
  const sessionId = 'p4-diverge';
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, 'diverge.txt');
  recordWrite(sessionId, target, 'correct-bytes');
  const exp = replayBundle.exportBundle(sessionId);

  // Tamper the recorded expected hash so verification can never pass.
  const m = exp.manifest;
  m.steps[0].artifacts[0].sha256 = sha256Hex(Buffer.from('WRONG', 'utf-8'));

  if (fs.existsSync(target)) fs.unlinkSync(target);
  const report = await replayEngine.replay({ manifest: m }, { force: true });
  assert.strictEqual(report.status, 'diverged');
  assert.strictEqual(report.divergedAt, 0);
  const halted = report.steps.find((s) => s.action === 'halted');
  assert.ok(halted && halted.verify && halted.verify.ok === false);
});

test('NETWORK_AI steps are always skipped', async () => {
  const sessionId = 'p4-network';
  replayLedger._resetSeq(sessionId);
  replayLedger.recordToolTurn({
    sessionId, name: 'web_search', params: { query: 'x' }, result: { success: true }, writeDiff: null,
  });
  const exp = replayBundle.exportBundle(sessionId);
  const report = await replayEngine.replay(exp.bundleDir, { force: true });
  assert.strictEqual(report.summary.skipped, 1);
  assert.strictEqual(report.steps[0].action, 'skipped');
  assert.match(report.steps[0].reason, /网络\/AI/);
});

test('SHELL is skipped without pre-approval and replayed with confirm', async () => {
  const sessionId = 'p4-shell';
  replayLedger._resetSeq(sessionId);
  replayLedger.recordToolTurn({
    sessionId,
    name: 'shell_command',
    params: { command: 'echo hi' },
    result: { success: true },
    writeDiff: null,
  });
  const exp = replayBundle.exportBundle(sessionId);

  // No pre-approval, no confirm → skipped.
  const skipReport = await replayEngine.replay(exp.bundleDir, { force: true });
  assert.strictEqual(skipReport.steps[0].action, 'skipped');
  assert.match(skipReport.steps[0].reason, /未预批准/);

  // confirm()=true → the step is replayed (no artifacts → trivially verifies).
  const okReport = await replayEngine.replay(exp.bundleDir, { force: true, confirm: () => true });
  assert.strictEqual(okReport.steps[0].action, 'replayed');
});

test('SHELL pre-approval via command pattern allows replay', async () => {
  const sessionId = 'p4-shell-allow';
  replayLedger._resetSeq(sessionId);
  replayLedger.recordToolTurn({
    sessionId,
    name: 'shell_command',
    params: { command: 'echo hi' },
    result: { success: true },
    writeDiff: null,
  });
  const exp = replayBundle.exportBundle(sessionId);
  const report = await replayEngine.replay(exp.bundleDir, { force: true, preApprovedShell: ['echo *'] });
  assert.strictEqual(report.steps[0].action, 'replayed');
});

test('env mismatch is refused without force and proceeds with force', async () => {
  const sessionId = 'p4-env';
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, 'env.txt');
  recordWrite(sessionId, target, 'env-bytes');
  const exp = replayBundle.exportBundle(sessionId);

  // Corrupt the recorded env so capture() can never match.
  exp.manifest.env.node = 'v0.0.0-not-a-real-version';

  const refused = await replayEngine.replay({ manifest: exp.manifest });
  assert.strictEqual(refused.status, 'env-mismatch');
  assert.ok(refused.envDiffs.length >= 1);

  if (fs.existsSync(target)) fs.unlinkSync(target);
  const forced = await replayEngine.replay({ manifest: exp.manifest }, { force: true });
  assert.strictEqual(forced.status, 'completed');
  assert.ok(fs.existsSync(target));
});

test('precondition guard halts rather than clobber un-recorded data', async () => {
  const sessionId = 'p4-precond';
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, 'precond.txt');
  // Recorded as a modify: before='v1', after='v2'.
  replayLedger.recordToolTurn({
    sessionId,
    name: 'edit_file',
    params: { path: target, content: 'v2' },
    result: { success: true },
    writeDiff: { filePath: target, beforeContent: 'v1', afterContent: 'v2' },
  });
  const exp = replayBundle.exportBundle(sessionId);

  // Put an UNEXPECTED prior state on disk (not 'v1', not 'v2').
  fs.writeFileSync(target, 'UNRECORDED-LOCAL-EDITS');
  const report = await replayEngine.replay({ manifest: exp.manifest }, { force: true });
  assert.strictEqual(report.status, 'diverged');
  assert.strictEqual(report.divergedAt, 0);
  // The local file must be left untouched.
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'UNRECORDED-LOCAL-EDITS');
});

test('already-satisfied artifacts are skipped (idempotent replay)', async () => {
  const sessionId = 'p4-idem';
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, 'idem.txt');
  recordWrite(sessionId, target, 'already-there');
  const exp = replayBundle.exportBundle(sessionId);

  // File already at the recorded terminal state.
  fs.writeFileSync(target, 'already-there');
  const report = await replayEngine.replay({ manifest: exp.manifest }, { force: true });
  assert.strictEqual(report.status, 'completed');
  assert.strictEqual(report.steps[0].action, 'skipped');
  assert.match(report.steps[0].reason, /目标状态/);
});
