'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { submitGateBusy } = require('../../src/cli/tui/hooks/useQueryBridge');

test('submitGateBusy: idle and done are open only when no synchronous turn is in flight', () => {
  assert.equal(submitGateBusy('idle', false), false);
  assert.equal(submitGateBusy('done', false), false);
  assert.equal(submitGateBusy('idle', true), true);
  assert.equal(submitGateBusy('done', true), true);
});

test('submitGateBusy: active statuses stay busy', () => {
  for (const s of ['thinking', 'streaming', 'tool', 'compacting', 'local']) {
    assert.equal(submitGateBusy(s, false), true, `status ${s}`);
  }
});

test('submitGateBusy: missing or unknown status fails closed', () => {
  assert.equal(submitGateBusy('', false), true);
  assert.equal(submitGateBusy(null, false), true);
  assert.equal(submitGateBusy('weird', false), true);
});
