'use strict';

/**
 * e2eReplay.test.js — DESIGN-ARCH-048 end-to-end deterministic replay.
 *
 * Drives the complete loop through the REAL executeTool funnel (no mocks, no AI):
 *   ① record a write via executeTool → ledger gets 1 FILE entry whose artifact
 *      hash equals sha256Hex(content), and a content blob is stored;
 *   ② exportBundle → manifest + content/<hash>;
 *   ③ delete the produced file;
 *   ④ replay(bundle, {force}) → status 'completed', restored===1, file back with
 *      a matching hash;
 *   ⑤ negative: tamper the recorded hash → diverged at seq 0.
 *
 * KHY_PROJECT_DATA_HOME / write roots are set before requiring funnel modules.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-e2e-home-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
process.env.KHY_DEP_HEALING = 'off';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-e2e-work-'));
process.env.KHY_WRITE_EXTRA_ROOTS = WORK;

const { executeTool } = require('../../../src/services/toolCalling');
const { EXEC_APPROVED } = require('../../../src/services/execApproval');
const replayLedger = require('../../../src/services/trajectoryReplay/replayLedger');
const replayBundle = require('../../../src/services/trajectoryReplay/replayBundle');
const replayEngine = require('../../../src/services/trajectoryReplay/replayEngine');
const { sha256Hex } = require('../../../src/services/sourceSnapshotCrypto');

// Simulate the recording hot-path seam: run a real tool through the funnel, then
// record it into the ledger exactly as toolUseLoop now does.
async function recordedWrite(sessionId, target, content) {
  const params = { path: target, content };
  if (EXEC_APPROVED) params[EXEC_APPROVED] = true;
  const result = await executeTool('write_file', params, {
    sessionId, source: 'test', onControlRequest: async () => ({ behavior: 'allow', typed: 'YES' }),
  });
  // Build the same _khyWriteDiff shape toolUseLoop produces (before empty → create).
  const writeDiff = { filePath: target, beforeContent: '', afterContent: content };
  replayLedger.recordToolTurn({ sessionId, name: 'write_file', params: { path: target, content }, result, writeDiff });
  return result;
}

test('E2E: record → export → delete → replay reproduces the artifact', async () => {
  const sessionId = 'e2e-happy';
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, 'artifact.txt');
  const content = 'hello';

  // ① record
  const res = await recordedWrite(sessionId, target, content);
  assert.strictEqual(res.success, true);
  assert.ok(fs.existsSync(target));

  const ledgerPath = replayLedger.ledgerPathFor(
    require('../../../src/services/sessionPersistence').jsonlPathFor(sessionId),
  );
  const entries = replayLedger.read(ledgerPath);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].tier, 'FILE');
  assert.strictEqual(entries[0].artifacts[0].sha256, sha256Hex(Buffer.from(content, 'utf-8')));

  // content blob stored
  const blob = path.join(replayLedger._contentStoreDir(sessionId), sha256Hex(Buffer.from(content, 'utf-8')));
  assert.ok(fs.existsSync(blob));

  // ② export
  const exp = replayBundle.exportBundle(sessionId);
  assert.strictEqual(exp.ok, true);
  assert.ok(fs.existsSync(path.join(exp.bundleDir, 'manifest.json')));
  assert.ok(fs.existsSync(replayBundle.contentPath(exp.bundleDir, sha256Hex(Buffer.from(content, 'utf-8')))));

  // ③ delete the produced file
  fs.unlinkSync(target);
  assert.ok(!fs.existsSync(target));

  // ④ replay reproduces it
  const report = await replayEngine.replay(exp.bundleDir, { force: true });
  assert.strictEqual(report.status, 'completed', JSON.stringify(report));
  assert.strictEqual(report.summary.restored, 1);
  assert.ok(fs.existsSync(target));
  assert.strictEqual(fs.readFileSync(target, 'utf-8'), content);
  assert.strictEqual(sha256Hex(fs.readFileSync(target)), sha256Hex(Buffer.from(content, 'utf-8')));
});

test('E2E negative: a tampered recorded hash diverges at seq 0', async () => {
  const sessionId = 'e2e-tamper';
  replayLedger._resetSeq(sessionId);
  const target = path.join(WORK, 'tamper.txt');
  await recordedWrite(sessionId, target, 'genuine');

  const exp = replayBundle.exportBundle(sessionId);
  exp.manifest.steps[0].artifacts[0].sha256 = sha256Hex(Buffer.from('forged', 'utf-8'));

  fs.unlinkSync(target);
  const report = await replayEngine.replay({ manifest: exp.manifest }, { force: true });
  assert.strictEqual(report.status, 'diverged');
  assert.strictEqual(report.divergedAt, 0);
});
