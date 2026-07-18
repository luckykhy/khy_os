'use strict';

/**
 * g2EngineRepairSeam.test.js — DESIGN-ARCH-049 G2 (replayEngine repair hook).
 *
 * Verifies the additive opts.repair seam:
 *   - absent hook ⇒ byte-identical 048 behavior (skip/halt paths unchanged);
 *   - a fake hook that reproduces a file turns a post-verify divergence into a
 *     'repaired' step (counted as replayed + repaired), with sha256 still the
 *     sole oracle (a lying hook that doesn't fix the file still halts);
 *   - a hook returning {attempted:false} declines and the original path runs;
 *   - a hook can bridge a NETWORK_AI step into 'repaired'.
 *
 * No model is involved — the hook is a plain function (proves the engine is
 * model-free and the bridge is purely injected).
 *
 * KHY_PROJECT_DATA_HOME / write roots are set before requiring funnel modules.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g2-home-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
process.env.KHY_DEP_HEALING = 'off';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g2-work-'));
process.env.KHY_WRITE_EXTRA_ROOTS = WORK;

const replayEngine = require('../../../src/services/trajectoryReplay/replayEngine');
const artifactHash = require('../../../src/services/trajectoryReplay/artifactHash');

/** Build a single-FILE-step manifest whose artifact is `content` at `target`. */
function fileManifest(target, content, tier = 'FILE') {
  const sha256 = artifactHash.sha256Hex(content);
  return {
    v: 1,
    kind: 'khyos-replay-bundle',
    sessionId: 'g2',
    env: null, // compare(null, …) yields match → no env gate in this unit test
    steps: [
      {
        seq: 0,
        name: 'write_file',
        tier,
        params: { path: target, content },
        writeDiff: { filePath: target, beforeHash: null, afterHash: sha256 },
        artifacts: [{ path: target, sha256, op: 'create' }],
      },
    ],
  };
}

test('absent repair hook: NETWORK_AI step is skipped exactly as in 048', async () => {
  const target = path.join(WORK, 'g2-net.txt');
  const m = fileManifest(target, 'net', 'NETWORK_AI');
  const report = await replayEngine.replay(m, { force: true });
  assert.strictEqual(report.status, 'completed');
  assert.strictEqual(report.summary.skipped, 1);
  assert.strictEqual(report.summary.repaired, 0);
  assert.strictEqual(report.steps[0].action, 'skipped');
});

test('repair hook bridges a NETWORK_AI step by producing the artifact', async () => {
  const target = path.join(WORK, 'g2-net-fixed.txt');
  const content = 'bridged-net';
  const m = fileManifest(target, content, 'NETWORK_AI');
  if (fs.existsSync(target)) fs.unlinkSync(target);

  let calls = 0;
  const repair = async (step, ctx) => {
    calls += 1;
    assert.strictEqual(ctx.kind, 'network_ai');
    fs.writeFileSync(step.artifacts[0].path, content); // perform the operation, NOT touch the hash
    return { attempted: true };
  };

  const report = await replayEngine.replay(m, { force: true, repair });
  assert.strictEqual(calls, 1);
  assert.strictEqual(report.status, 'completed');
  assert.strictEqual(report.summary.repaired, 1);
  assert.strictEqual(report.summary.replayed, 1);
  assert.strictEqual(report.steps[0].action, 'repaired');
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), content);
});

test('sha256 stays the oracle: a hook that does NOT fix the file still halts', async () => {
  const target = path.join(WORK, 'g2-liar.txt');
  const m = fileManifest(target, 'genuine', 'NETWORK_AI');
  if (fs.existsSync(target)) fs.unlinkSync(target);

  const repair = async () => ({ attempted: true }); // claims success but writes nothing
  const report = await replayEngine.replay(m, { force: true, repair });
  assert.strictEqual(report.status, 'diverged');
  assert.strictEqual(report.divergedAt, 0);
  assert.strictEqual(report.steps[0].action, 'halted');
  assert.ok(!fs.existsSync(target));
});

test('hook returning {attempted:false} declines → original skip path runs', async () => {
  const target = path.join(WORK, 'g2-decline.txt');
  const m = fileManifest(target, 'x', 'NETWORK_AI');
  const repair = async () => ({ attempted: false });
  const report = await replayEngine.replay(m, { force: true, repair });
  assert.strictEqual(report.status, 'completed');
  assert.strictEqual(report.summary.skipped, 1);
  assert.strictEqual(report.summary.repaired, 0);
});

test('post-verify divergence is rescued by the repair hook', async () => {
  // Tamper the recorded hash so the deterministic write produces a mismatch,
  // then let the hook rewrite the artifact to the (true) recorded bytes.
  const target = path.join(WORK, 'g2-postverify.txt');
  const content = 'real-bytes';
  const m = fileManifest(target, content, 'FILE');
  const trueHash = m.steps[0].artifacts[0].sha256;
  if (fs.existsSync(target)) fs.unlinkSync(target);

  let repaired = false;
  const repair = async (step, ctx) => {
    assert.strictEqual(ctx.kind, 'post-verify');
    fs.writeFileSync(step.artifacts[0].path, content);
    step.artifacts[0].sha256 = trueHash; // restore the (legit) hash the engine re-checks
    repaired = true;
    return { attempted: true };
  };

  // Force a post-verify mismatch: the recorded params write 'real-bytes' but we
  // point the artifact hash at a wrong value so the deterministic write diverges.
  m.steps[0].artifacts[0].sha256 = 'a'.repeat(64);
  const report = await replayEngine.replay(m, { force: true, repair });
  assert.strictEqual(repaired, true);
  assert.strictEqual(report.status, 'completed');
  assert.strictEqual(report.summary.repaired, 1);
});

test('repair error is caught and halts (never throws out of replay)', async () => {
  const target = path.join(WORK, 'g2-throw.txt');
  const m = fileManifest(target, 'y', 'NETWORK_AI');
  const repair = async () => { throw new Error('boom'); };
  const report = await replayEngine.replay(m, { force: true, repair });
  assert.strictEqual(report.status, 'diverged');
  assert.match(report.steps[0].reason, /repair error/);
});
