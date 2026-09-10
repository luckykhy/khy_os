'use strict';
/**
 * publishUtils.test.js �?pins the generic helpers extracted from the
 * cli/handlers/publish.js god-file (B1 split, second seam).
 */
const u = require('../../src/services/domain/deploy/publish/publishUtils.js');
describe('publish/publishUtils', () => {
  // �?2 公理化收敛：_isTruthyFlag 委托 utils/parseBoolean(base tier) 后，逐字节复�?
  // 原内�?`value === true || ['1','true','yes','on'].includes(String(value||'').trim().toLowerCase())`
  // 的采样域。期望值全部按原实现手算写死�?
  describe('_markFailure', () => {
    let prev;
    afterEach(() => { process.exitCode = prev; });
  });
});

describe('Publish Utils', () => {
  test('_toInt coerces, clamps to min, and falls back', () => {
        expect(u._toInt('5', 1)).toBe(5);
        expect(u._toInt('abc', 7)).toBe(7);
        expect(u._toInt('0', 3, 1)).toBe(3); // below min �?fallback
        expect(u._toInt(undefined, 9)).toBe(9);
  });

  test('_formatDuration renders m/s shapes', () => {
        expect(u._formatDuration(5000)).toBe('5s');
        expect(u._formatDuration(60000)).toBe('1m');
        expect(u._formatDuration(65000)).toBe('1m 5s');
        expect(u._formatDuration(0)).toBe('1s'); // floored to at least 1s
  });

  test('_isTruthyFlag accepts the truthy vocabulary', () => {
        for (const v of [true, '1', 'true', 'yes', 'on', 'YES']) {
          expect(u._isTruthyFlag(v)).toBe(true);
        }
        for (const v of [false, '0', 'no', 'off', '', undefined]) {
          expect(u._isTruthyFlag(v)).toBe(false);
        }
  });

  test('_isTruthyFlag delegation preserves the pre-refactor byte semantics', () => {
        const samples = [
          [true, true],          // boolean passthrough
          [false, false],
          ['1', true], ['true', true], ['yes', true], ['on', true],
          [' ON ', true],        // trim + lowercase
          ['TrUe', true],
          [1, true],             // String(1) �?'1'
          [0, false],            // 0 �?String(0||'') �?'' �?not in list
          ['0', false], ['false', false], ['no', false], ['off', false],
          ['y', false],          // base tier rejects the y/n shorthand
          ['n', false],
          ['maybe', false],      // unknown token �?false
          ['', false], ['   ', false],
          [null, false], [undefined, false],
          [2, false],            // '2' not in truthy list
          [NaN, false],          // String(NaN||'') �?''
        ];
        for (const [input, expected] of samples) {
          expect(u._isTruthyFlag(input)).toBe(expected);
        }
  });

  test('_pickFirstNonEmpty returns the first trimmed non-empty value', () => {
        expect(u._pickFirstNonEmpty(['', '  ', 'x', 'y'])).toBe('x');
        expect(u._pickFirstNonEmpty([null, undefined, '  z  '])).toBe('z');
        expect(u._pickFirstNonEmpty([])).toBe('');
  });

  test('sets exitCode to 1 only when unset/zero', () => {
          prev = process.exitCode;
          process.exitCode = 0;
          u._markFailure();
          expect(process.exitCode).toBe(1);
          process.exitCode = 42; // a prior non-zero code must be preserved
          u._markFailure();
          expect(process.exitCode).toBe(42);
  });

});

