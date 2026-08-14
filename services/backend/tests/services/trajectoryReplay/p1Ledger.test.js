'use strict';

/**
 * p1Ledger.test.js — DESIGN-ARCH-048 PHASE 1 (full-fidelity replay ledger).
 *
 * Covers the recording-side SSOT: tier classification, artifact hashing, and the
 * best-effort ledger writer. Validates hot-path safety (bad input never throws),
 * well-formed entries, monotonic seq, and content-store reproduction of bytes.
 *
 * IMPORTANT: KHY_PROJECT_DATA_HOME must be set BEFORE any persistence module is
 * required — dataHome caches its root on first resolve.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-p1-ledger-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;

const tierRegistry = require('../../../src/services/trajectoryReplay/tierRegistry');
const artifactHash = require('../../../src/services/trajectoryReplay/artifactHash');
const replayLedger = require('../../../src/services/trajectoryReplay/replayLedger');
const { sha256Hex } = require('../../../src/services/sourceSnapshotCrypto');

test('tierRegistry classifies the three tiers and collapses unknown to SHELL', () => {
  assert.strictEqual(tierRegistry.classify('write_file'), 'FILE');
  assert.strictEqual(tierRegistry.classify('multiEdit'), 'FILE');
  assert.strictEqual(tierRegistry.classify('shell_command'), 'SHELL');
  assert.strictEqual(tierRegistry.classify('bash'), 'SHELL');
  assert.strictEqual(tierRegistry.classify('web_search'), 'NETWORK_AI');
  assert.strictEqual(tierRegistry.classify('agent'), 'NETWORK_AI');

  // Unknown classifies as UNKNOWN but the *effective* tier is the conservative
  // SHELL — never silently auto-FILE.
  assert.strictEqual(tierRegistry.classify('totally_made_up_tool'), 'UNKNOWN');
  assert.strictEqual(tierRegistry.effectiveTier('totally_made_up_tool'), 'SHELL');
  assert.strictEqual(tierRegistry.effectiveTier('write_file'), 'FILE');
});

test('tierRegistry.normalize lowercases and strips separators', () => {
  assert.strictEqual(tierRegistry.normalize('Write_File'), 'writefile');
  assert.strictEqual(tierRegistry.normalize('multi-edit tool'), 'multiedittool');
  assert.strictEqual(tierRegistry.normalize(null), '');
});

test('artifactHash.hashString equals sha256Hex of the UTF-8 bytes', () => {
  assert.strictEqual(artifactHash.hashString('hello'), sha256Hex(Buffer.from('hello', 'utf-8')));
  // Non-ASCII must hash identically whether via hashString or raw bytes.
  const emoji = '你好🌍';
  assert.strictEqual(artifactHash.hashString(emoji), sha256Hex(Buffer.from(emoji, 'utf-8')));
});

test('artifactHash.hashFile equals sha256Hex of the raw file bytes', () => {
  const f = path.join(TMP_HOME, 'sample.txt');
  fs.writeFileSync(f, 'reproducible-bytes');
  assert.strictEqual(artifactHash.hashFile(f), sha256Hex(fs.readFileSync(f)));
  assert.strictEqual(artifactHash.hashFile(path.join(TMP_HOME, 'missing.txt')), null);
});

test('recordToolTurn writes a well-formed FILE entry with monotonic seq', () => {
  const sessionId = 'p1-sess-file';
  replayLedger._resetSeq(sessionId);

  const r0 = replayLedger.recordToolTurn({
    sessionId,
    name: 'write_file',
    params: { path: '/abs/foo.txt', content: 'hello' },
    result: { success: true },
    writeDiff: { filePath: '/abs/foo.txt', beforeContent: '', afterContent: 'hello' },
  });
  assert.strictEqual(r0.ok, true);
  assert.strictEqual(r0.seq, 0);

  const r1 = replayLedger.recordToolTurn({
    sessionId,
    name: 'edit_file',
    params: { path: '/abs/foo.txt', old: 'hello', new: 'world' },
    result: { success: true },
    writeDiff: { filePath: '/abs/foo.txt', beforeContent: 'hello', afterContent: 'world' },
  });
  assert.strictEqual(r1.seq, 1);

  const ledgerPath = replayLedger.ledgerPathFor(
    require('../../../src/services/sessionPersistence').jsonlPathFor(sessionId),
  );
  const entries = replayLedger.read(ledgerPath);
  assert.strictEqual(entries.length, 2);

  const e0 = entries[0];
  assert.strictEqual(e0.v, replayLedger.LEDGER_VERSION);
  assert.strictEqual(e0.seq, 0);
  assert.strictEqual(e0.name, 'write_file');
  assert.strictEqual(e0.normName, 'writefile');
  assert.strictEqual(e0.tier, 'FILE');
  // params recorded COMPLETE and untruncated.
  assert.strictEqual(e0.params.content, 'hello');
  assert.strictEqual(e0.paramsHash, artifactHash.hashCanonical(e0.params));
  // create op: no beforeHash, afterHash == sha256('hello').
  assert.strictEqual(e0.writeDiff.beforeHash, null);
  assert.strictEqual(e0.writeDiff.afterHash, sha256Hex(Buffer.from('hello', 'utf-8')));
  assert.strictEqual(e0.artifacts.length, 1);
  assert.strictEqual(e0.artifacts[0].op, 'create');
  assert.strictEqual(e0.artifacts[0].sha256, sha256Hex(Buffer.from('hello', 'utf-8')));

  // modify op for the second turn.
  assert.strictEqual(entries[1].artifacts[0].op, 'modify');

  // verifyLedger sees a contiguous, well-formed ledger.
  const v = replayLedger.verifyLedger(ledgerPath);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.length, 2);
});

test('recordToolTurn stores after-bytes in the content store for reproduction', () => {
  const sessionId = 'p1-sess-content';
  replayLedger._resetSeq(sessionId);
  const content = 'bytes-needed-after-delete';
  replayLedger.recordToolTurn({
    sessionId,
    name: 'write_file',
    params: { path: '/abs/keep.txt', content },
    result: { success: true },
    writeDiff: { filePath: '/abs/keep.txt', beforeContent: '', afterContent: content },
  });
  const sha = sha256Hex(Buffer.from(content, 'utf-8'));
  const blob = path.join(replayLedger._contentStoreDir(sessionId), sha);
  assert.ok(fs.existsSync(blob), 'content blob should exist');
  assert.strictEqual(fs.readFileSync(blob, 'utf-8'), content);
});

test('recordToolTurn records a delete op when afterContent is empty', () => {
  const sessionId = 'p1-sess-delete';
  replayLedger._resetSeq(sessionId);
  replayLedger.recordToolTurn({
    sessionId,
    name: 'file_op',
    params: { op: 'delete', path: '/abs/gone.txt' },
    result: { success: true },
    writeDiff: { filePath: '/abs/gone.txt', beforeContent: 'was-here', afterContent: '' },
  });
  const ledgerPath = replayLedger.ledgerPathFor(
    require('../../../src/services/sessionPersistence').jsonlPathFor(sessionId),
  );
  const entries = replayLedger.read(ledgerPath);
  assert.strictEqual(entries[0].artifacts[0].op, 'delete');
  assert.strictEqual(entries[0].artifacts[0].sha256, null);
});

test('recordToolTurn is hot-path safe: bad input never throws', () => {
  // Missing required fields → {ok:false}, no throw.
  assert.strictEqual(replayLedger.recordToolTurn({}).ok, false);
  assert.strictEqual(replayLedger.recordToolTurn({ sessionId: 'x' }).ok, false);
  assert.strictEqual(replayLedger.recordToolTurn({ name: 'y' }).ok, false);
  // Garbage params/result/writeDiff must not throw.
  assert.doesNotThrow(() => replayLedger.recordToolTurn({
    sessionId: 'p1-sess-garbage',
    name: 'write_file',
    params: undefined,
    result: 'not-an-object',
    writeDiff: { filePath: 42 },
  }));
});

test('verifyLedger flags a non-contiguous ledger', () => {
  const bad = path.join(TMP_HOME, 'bad.replay-ledger.jsonl');
  fs.writeFileSync(bad,
    JSON.stringify({ v: 1, seq: 0, name: 'write_file', tier: 'FILE' }) + '\n' +
    JSON.stringify({ v: 1, seq: 5, name: 'write_file', tier: 'FILE' }) + '\n');
  const v = replayLedger.verifyLedger(bad);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.badAt, 1);
});
