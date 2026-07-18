'use strict';

/**
 * agentFsDescribeAssets.test.js — locks the receipt-count dependency inversion.
 *
 * Receipts is an external asset. To break the agentFsService ⇄ receiptService
 * import cycle, describeAssets no longer reaches into receiptService; the caller
 * injects a counter via opts.countReceipts. These locks pin: (1) the injected
 * count surfaces verbatim, (2) absent/throwing injector degrades to 0, and
 * (3) the source no longer imports receiptService (the cycle-break invariant).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the agents root before requiring the service (dataHome caches
// KHY_DATA_HOME on first use).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-agentfs-'));
process.env.KHY_DATA_HOME = TMP;

const svc = require('../../src/services/agentFs/agentFsService');
svc.createAgent({ name: 'Tester', id: 'tester' });

function receiptsAsset(id, opts) {
  return svc.describeAssets(id, opts).find((a) => a.external === 'receipts');
}

test('injected counter surfaces verbatim in the receipts asset', () => {
  const a = receiptsAsset('tester', { countReceipts: () => 7 });
  assert.strictEqual(a.count, 7);
  assert.strictEqual(a.present, true);
  assert.strictEqual(a.summary, '7 条回执');
});

test('no injector → count 0, asset reads empty', () => {
  const a = receiptsAsset('tester');
  assert.strictEqual(a.count, 0);
  assert.strictEqual(a.present, false);
  assert.strictEqual(a.summary, '尚无回执');
});

test('throwing injector degrades to 0 (receipts optional)', () => {
  const a = receiptsAsset('tester', { countReceipts: () => { throw new Error('boom'); } });
  assert.strictEqual(a.count, 0);
  assert.strictEqual(a.present, false);
});

test('cycle-break invariant: agentFsService does not import receiptService', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/services/agentFs/agentFsService.js'),
    'utf8',
  );
  assert.ok(!/require\(\s*['"]\.\.\/receiptService['"]\s*\)/.test(src),
    'agentFsService must not require receiptService (would re-introduce the SCC)');
});
