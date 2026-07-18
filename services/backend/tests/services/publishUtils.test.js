'use strict';

/**
 * publishUtils.test.js — pins the generic helpers extracted from the
 * cli/handlers/publish.js god-file (B1 split, second seam).
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const u = require('../../src/services/publish/publishUtils');

describe('publish/publishUtils', () => {
  test('_toInt coerces, clamps to min, and falls back', () => {
    assert.equal(u._toInt('5', 1), 5);
    assert.equal(u._toInt('abc', 7), 7);
    assert.equal(u._toInt('0', 3, 1), 3); // below min → fallback
    assert.equal(u._toInt(undefined, 9), 9);
  });

  test('_formatDuration renders m/s shapes', () => {
    assert.equal(u._formatDuration(5000), '5s');
    assert.equal(u._formatDuration(60000), '1m');
    assert.equal(u._formatDuration(65000), '1m 5s');
    assert.equal(u._formatDuration(0), '1s'); // floored to at least 1s
  });

  test('_isTruthyFlag accepts the truthy vocabulary', () => {
    for (const v of [true, '1', 'true', 'yes', 'on', 'YES']) {
      assert.equal(u._isTruthyFlag(v), true, `${v} should be truthy`);
    }
    for (const v of [false, '0', 'no', 'off', '', undefined]) {
      assert.equal(u._isTruthyFlag(v), false, `${v} should be falsy`);
    }
  });

  test('_pickFirstNonEmpty returns the first trimmed non-empty value', () => {
    assert.equal(u._pickFirstNonEmpty(['', '  ', 'x', 'y']), 'x');
    assert.equal(u._pickFirstNonEmpty([null, undefined, '  z  ']), 'z');
    assert.equal(u._pickFirstNonEmpty([]), '');
  });

  describe('_markFailure', () => {
    let prev;
    afterEach(() => { process.exitCode = prev; });

    test('sets exitCode to 1 only when unset/zero', () => {
      prev = process.exitCode;
      process.exitCode = 0;
      u._markFailure();
      assert.equal(process.exitCode, 1);
      process.exitCode = 42; // a prior non-zero code must be preserved
      u._markFailure();
      assert.equal(process.exitCode, 42);
    });
  });
});
