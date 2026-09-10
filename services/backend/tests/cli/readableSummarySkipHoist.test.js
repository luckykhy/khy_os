'use strict';
/**
 * readableSummarySkipHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of the SKIP key-set in
 * _readableObjectSummary(): the noisy-key exclusion Set is now built once at
 * module load instead of per tool-result render. Behavior byte-identical.
 */
const trs = require('../../src/cli/toolResultSummary');
const { _readableObjectSummary } = trs;

describe('Readable Summary Skip Hoist', () => {
  test('skips noisy/internal keys, keeps meaningful scalars', () => {
      const out = _readableObjectSummary({
        success: true,
        ok: true,
        output: 'lots of text',
        content: 'body',
        text: 'body',
        _internal: 'hidden',
        files: 3,
        label: 'done',
      });
      // Skipped keys must not appear; kept scalars must.
      expect(!out).toContain('success=');
      expect(!out).toContain('output=');
      expect(!out).toContain('content=');
      expect(!out).toContain('_internal=');
      expect(out).toContain('files=3');
      expect(out).toContain('label=done');
  });

});
