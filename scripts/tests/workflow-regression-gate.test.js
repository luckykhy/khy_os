'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { WORKFLOW_TESTS, resolveTests } = require('../quality-gate/workflow-regression');

describe('workflow regression manifest', () => {
  test('has a stable nonempty manifest with existing files', () => {
    assert.ok(WORKFLOW_TESTS.length > 0);
    assert.equal(resolveTests().length, WORKFLOW_TESTS.length);
  });
});
