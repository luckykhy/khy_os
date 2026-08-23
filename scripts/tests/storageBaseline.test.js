'use strict';

const assert = require('assert/strict');
const test = require('node:test');

const baseline = require('../lib/storageBaseline');
const backendFormatBytes = require('../../services/backend/src/utils/formatBytes');

test('the env gate is off only for an explicit falsy word', () => {
  // Default-on matters: a baseline that silently reports nothing looks exactly
  // like a tree with nothing in it, and "we saved 400 MB" becomes unfalsifiable.
  assert.equal(baseline.isEnabled({}), true);
  assert.equal(baseline.isEnabled({ KHY_STORAGE_BASELINE: '' }), true);
  assert.equal(baseline.isEnabled({ KHY_STORAGE_BASELINE: '1' }), true);
  assert.equal(baseline.isEnabled({ KHY_STORAGE_BASELINE: 'yes' }), true);
  for (const word of ['0', 'false', 'off', 'no', 'OFF', ' False ']) {
    assert.equal(baseline.isEnabled({ KHY_STORAGE_BASELINE: word }), false, word);
  }
  assert.deepEqual(
    baseline.summarize({ logs: { activeBytes: 1 } }, { KHY_STORAGE_BASELINE: '0' }),
    { disabled: true }
  );
  assert.match(baseline.render({ disabled: true }), /disabled/);
});

test('one bad probe cannot poison a total', () => {
  // Probes walk the filesystem and can come back with null / NaN / a negative
  // from a stat race. Those must land as 0, not NaN — a NaN total renders as
  // "NaN MB" and makes the whole report unreadable rather than partly wrong.
  const logs = baseline.summarizeLogs({
    activeBytes: 1024,
    archiveBytes: null,
    legacyBytes: 'not a number',
  });
  assert.equal(logs.activeBytes, 1024);
  assert.equal(logs.archiveBytes, 0);
  assert.equal(logs.legacyBytes, 0);
  assert.equal(logs.totalBytes, 1024);

  const ck = baseline.summarizeCheckpoints([
    { logicalBytes: 100, physicalBytes: 50 },
    null,
    42,
    { logicalBytes: -100, physicalBytes: NaN },
  ]);
  assert.equal(ck.logicalBytes, 100);
  assert.equal(ck.physicalBytes, 50);
  assert.equal(ck.savedBytes, 50);
});

test('formatBytes matches the backend renderer on integer byte counts', () => {
  // The storage report is read side by side with the backend's own size output;
  // two different roundings of the same number read as two measurements.
  for (const n of [0, 1, 512, 1023, 1024, 1536, 1048576, 274500000, 1099511627776]) {
    assert.equal(
      baseline.formatBytes(n),
      backendFormatBytes(n, { maxUnit: 'TB', sanitize: true }),
      String(n)
    );
  }
  // Divergence is confined to sub-1024 fractions (Math.round here vs the
  // backend's raw interpolation). Byte counts are integers, so no live call site
  // can reach it — pinned so a later reader does not mistake it for full parity.
  assert.equal(baseline.formatBytes(1023.6), '1024 B');
  assert.equal(backendFormatBytes(1023.6, { maxUnit: 'TB', sanitize: true }), '1023.6 B');
});

test('dedupRatio is null when physical is 0 — unknown must not render as 1x', () => {
  const empty = baseline.summarizeCheckpoints([]);
  assert.equal(empty.physicalBytes, 0);
  assert.equal(empty.dedupRatio, null, 'a ratio over 0 is not Infinity, it is unknown');
  assert.equal(empty.savedBytes, 0);

  const real = baseline.summarizeCheckpoints([
    { logicalBytes: 300, physicalBytes: 100, entries: 3, casEntries: 3, objects: 1 },
  ]);
  assert.equal(real.dedupRatio, 3);
  assert.equal(real.savedBytes, 200);

  // savedBytes never goes negative: physical > logical means the probe and the
  // manifests disagree, and a negative "saved" reads as a regression we caused.
  const skewed = baseline.summarizeCheckpoints([{ logicalBytes: 10, physicalBytes: 999 }]);
  assert.equal(skewed.savedBytes, 0);
});

test('CAS not yet enabled is said out loud, not shown as a 1x win', () => {
  // casEntries === 0 means dedup never ran. Rendering "0 B (1.0x)" would read as
  // "dedup ran and gained nothing" — the opposite of the decision this drives.
  const summary = baseline.summarize({
    checkpoints: [{ logicalBytes: 500, physicalBytes: 500, entries: 4, casEntries: 0 }],
  });
  assert.equal(summary.checkpoints.casEntries, 0);
  assert.match(baseline.render(summary), /CAS 未启用/);
});

test('reclaimable counts only proven dedup, not install trees or build outputs', () => {
  // Folding node_modules / build outputs into "reclaimable" would mix what is
  // already saved with what we intend to save — and those depend on decisions
  // (workspace migration, release acceptance) that live on another path.
  const summary = baseline.summarize({
    logs: { activeBytes: 1000, archiveBytes: 2000 },
    checkpoints: [{ logicalBytes: 900, physicalBytes: 300 }],
    dependencies: [{ path: 'node_modules', bytes: 400 }],
    buildOutputs: [{ path: 'android/app/build', bytes: 500 }],
  });
  assert.equal(summary.totals.reclaimableBytes, 600);
  assert.equal(summary.totals.trackedBytes, 3000 + 300 + 400 + 500);
});

test('dependency listings are sorted biggest-first and capped at 10', () => {
  const trees = Array.from({ length: 14 }, (_, i) => ({ path: 'tree-' + i, bytes: i + 1 }));
  const summary = baseline.summarizeDependencies(trees);
  assert.equal(summary.trees, 14);
  assert.equal(summary.totalBytes, 105);
  assert.equal(summary.largest.length, 10);
  assert.equal(summary.largest[0].path, 'tree-13');
  assert.ok(summary.largest.every((t, i, all) => i === 0 || all[i - 1].bytes >= t.bytes));
});

test('nested node_modules count is reported apart from the tree byte total', () => {
  // 144 dirs and 6 trees are both true of the same tree: bytes may only be
  // counted once per top-level tree, while "how many node_modules are there"
  // counts nested ones too. Folding them into one number is how a slimming
  // report ends up claiming savings it never made.
  const summary = baseline.summarizeDependencies({
    top: [
      { path: 'node_modules', bytes: 300, files: 40 },
      { path: 'apps/x/node_modules', bytes: 100, files: 10 },
    ],
    nested: 144,
  });
  assert.equal(summary.trees, 2);
  assert.equal(summary.dirs, 144);
  assert.equal(summary.totalBytes, 400);
  assert.equal(summary.totalFiles, 50);
});

test('a bare array of trees still summarizes, dirs falling back to tree count', () => {
  const summary = baseline.summarizeDependencies([{ path: 'node_modules', bytes: 7 }]);
  assert.equal(summary.trees, 1);
  assert.equal(summary.dirs, 1);
  assert.equal(summary.totalFiles, 0);
});

test('empty .gz archives are surfaced as their own count', () => {
  // A zero-byte .gz is the fingerprint of a compression run that died halfway.
  // The count is itself the alarm, so it must not be folded into archiveBytes.
  const logs = baseline.summarizeLogs({ archiveBytes: 0, emptyArchives: 3 });
  assert.equal(logs.emptyArchives, 3);
  assert.match(baseline.render(baseline.summarize({ logs: { emptyArchives: 3 } })), /empty \.gz/);
});

test('compressionRatio needs both sides measured', () => {
  assert.equal(baseline.summarizeLogs({ archiveBytes: 100 }).compressionRatio, null);
  assert.equal(baseline.summarizeLogs({ archiveRawBytes: 800 }).compressionRatio, null);
  assert.equal(
    baseline.summarizeLogs({ archiveBytes: 100, archiveRawBytes: 800 }).compressionRatio,
    8
  );
});

test('summarize survives a wholly absent facts object', () => {
  // The CLI degrades a failed probe to null rather than throwing; summarize must
  // still produce a printable report instead of taking the process down.
  for (const facts of [undefined, null, {}, 42, 'nope']) {
    const summary = baseline.summarize(facts);
    assert.equal(summary.totals.trackedBytes, 0);
    assert.equal(typeof baseline.render(summary), 'string');
  }
});

test('render keeps a gap between a long path and its size', () => {
  // padEnd does not pad past the field width, so a 30+ char path used to collide
  // with its own number: ".../mermaid-embed/node_modules127.7 MB".
  const long = 'tools/khyos-markdown/muya-embed/node_modules';
  const text = baseline.render(
    baseline.summarize({ dependencies: [{ path: long, bytes: 133900000 }] })
  );
  assert.match(text, new RegExp(long + ' +\\d'));
});
