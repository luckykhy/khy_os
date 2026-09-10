'use strict';
const { submitGateBusy } = require('../../src/cli/tui/hooks/useQueryBridge');

describe('Submit Gate Busy', () => {
  test('submitGateBusy: idle and done are open only when no synchronous turn is in flight', () => {
      expect(submitGateBusy('idle', false)).toBe(false);
      expect(submitGateBusy('done', false)).toBe(false);
      expect(submitGateBusy('idle', true)).toBe(true);
      expect(submitGateBusy('done', true)).toBe(true);
  });

  test('submitGateBusy: active statuses stay busy', () => {
      for (const s of ['thinking', 'streaming', 'tool', 'compacting', 'local']) {
        expect(submitGateBusy(s, false)).toBe(true, `status ${s}`);
      }
  });

  test('submitGateBusy: missing or unknown status fails closed', () => {
      expect(submitGateBusy('', false)).toBe(true);
      expect(submitGateBusy(null, false)).toBe(true);
      expect(submitGateBusy('weird', false)).toBe(true);
  });

});
