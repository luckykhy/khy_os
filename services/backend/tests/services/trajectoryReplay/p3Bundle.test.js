'use strict';

/**
 * p3Bundle.test.js — DESIGN-ARCH-048 PHASE 3 (self-contained replay bundle).
 *
 * Covers export (manifest + ledger copy + content blobs), round-trip read,
 * integrity verification, tamper detection (mutated blob / mutated ledger), and
 * NETWORK_AI accounting as skipped.
 *
 * KHY_PROJECT_DATA_HOME is set before requiring persistence-touching modules.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-p3-bundle-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const replayLedger = require('../../../src/services/trajectoryReplay/replayLedger');
const replayBundle = require('../../../src/services/trajectoryReplay/replayBundle');
const { sha256Hex } = require('../../../src/services/sourceSnapshotCrypto');

function seed(sessionId) {
  replayLedger._resetSeq(sessionId);
  replayLedger.recordToolTurn({
    sessionId,
    name: 'write_file',
    params: { path: '/abs/a.txt', content: 'alpha' },
    result: { success: true },
    writeDiff: { filePath: '/abs/a.txt', beforeContent: '', afterContent: 'alpha' },
  });
  replayLedger.recordToolTurn({
    sessionId,
    name: 'web_search',
    params: { query: 'cats' },
    result: { success: true },
    writeDiff: null,
  });
}

test('exportBundle produces manifest, ledger copy and content blobs', () => {
  const sessionId = 'p3-export';
  seed(sessionId);
  const res = replayBundle.exportBundle(sessionId);
  assert.strictEqual(res.ok, true);
  assert.ok(fs.existsSync(path.join(res.bundleDir, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(res.bundleDir, 'ledger.jsonl')));
  assert.ok(fs.existsSync(path.join(res.bundleDir, 'env.json')));

  const sha = sha256Hex(Buffer.from('alpha', 'utf-8'));
  assert.ok(fs.existsSync(replayBundle.contentPath(res.bundleDir, sha)), 'FILE blob present');

  const m = res.manifest;
  assert.strictEqual(m.kind, 'khyos-replay-bundle');
  assert.strictEqual(m.steps.length, 2);
  assert.strictEqual(m.summary.total, 2);
  assert.strictEqual(m.summary.byTier.FILE, 1);
  assert.strictEqual(m.summary.byTier.NETWORK_AI, 1);
  assert.ok(m.contentManifest[sha]);
});

test('readBundle round-trips the manifest', () => {
  const sessionId = 'p3-read';
  seed(sessionId);
  const exp = replayBundle.exportBundle(sessionId);
  const read = replayBundle.readBundle(exp.bundleDir);
  assert.strictEqual(read.ok, true);
  assert.strictEqual(read.manifest.sessionId, sessionId);
});

test('verifyBundle is ok for a fresh export and counts skipped NETWORK_AI', () => {
  const sessionId = 'p3-verify';
  seed(sessionId);
  const exp = replayBundle.exportBundle(sessionId);
  const v = replayBundle.verifyBundle(exp.bundleDir);
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  assert.strictEqual(v.skipped, 1); // the web_search step
  assert.strictEqual(v.verifiedBlobs, 1); // the write_file blob
});

test('verifyBundle detects a tampered content blob', () => {
  const sessionId = 'p3-tamper-blob';
  seed(sessionId);
  const exp = replayBundle.exportBundle(sessionId);
  const sha = sha256Hex(Buffer.from('alpha', 'utf-8'));
  fs.writeFileSync(replayBundle.contentPath(exp.bundleDir, sha), 'CORRUPTED');
  const v = replayBundle.verifyBundle(exp.bundleDir);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /哈希不符/.test(e)));
});

test('verifyBundle detects a tampered ledger', () => {
  const sessionId = 'p3-tamper-ledger';
  seed(sessionId);
  const exp = replayBundle.exportBundle(sessionId);
  const ledgerPath = path.join(exp.bundleDir, 'ledger.jsonl');
  fs.appendFileSync(ledgerPath, '{"v":1,"seq":99,"name":"x","tier":"FILE"}\n');
  const v = replayBundle.verifyBundle(exp.bundleDir);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /账本被篡改/.test(e)));
});

test('verifyBundle detects a missing content blob', () => {
  const sessionId = 'p3-missing-blob';
  seed(sessionId);
  const exp = replayBundle.exportBundle(sessionId);
  const sha = sha256Hex(Buffer.from('alpha', 'utf-8'));
  fs.unlinkSync(replayBundle.contentPath(exp.bundleDir, sha));
  const v = replayBundle.verifyBundle(exp.bundleDir);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => /缺内容 blob/.test(e)));
});
