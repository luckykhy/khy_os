'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TEST_SCOPES,
  readConfig,
  parseThreshold,
  parseScope,
  buildInvocation,
  run,
} = require('../quality-gate/coverage');

describe('coverage gate', () => {
  test('stores the all-source threshold and scope in config', () => {
    const config = readConfig();
    assert.equal(config.all, true);
    for (const metric of ['lines', 'functions', 'branches', 'statements']) {
      assert.equal(config[metric], 60);
    }
    assert.deepEqual(config.include, ['services/backend/src/**/*.js']);
  });

  test('validates environment threshold', () => {
    assert.equal(parseThreshold({}), null);
    assert.equal(parseThreshold({ KHY_COVERAGE_THRESHOLD: '55.5' }), 55.5);
    for (const value of ['', '-1', '101', 'nope', 'Infinity']) {
      assert.throws(() => parseThreshold({ KHY_COVERAGE_THRESHOLD: value }), /0 to 100/);
    }
  });

  test('exposes unit and integration scopes', () => {
    assert.ok(TEST_SCOPES.unit.length > 0);
    assert.deepEqual(TEST_SCOPES.integration, ['tests/**/*.integration.test.js']);
    assert.equal(parseScope(['node', 'coverage.js', '--scope=integration']), 'integration');
    assert.throws(() => parseScope(['node', 'coverage.js', '--scope=bad']), /expected unit or integration/);
  });

  test('uses the selected scope in the invocation', () => {
    const invocation = buildInvocation({ KHY_COVERAGE_THRESHOLD: '70' }, [
      'node', 'coverage.js', '--scope=integration',
    ]);
    assert.equal(invocation.scope, 'integration');
    assert.ok(invocation.args.includes('tests/**/*.integration.test.js'));
  });

  test('applies environment threshold to every coverage metric', () => {
    const invocation = buildInvocation({ KHY_COVERAGE_THRESHOLD: '57' });
    for (const metric of ['lines', 'functions', 'branches', 'statements']) {
      const index = invocation.args.indexOf(`--${metric}`);
      assert.notEqual(index, -1);
      assert.equal(invocation.args[index + 1], '57');
    }
  });

  test('propagates c8 exit status', () => {
    assert.equal(run({}, () => ({ status: 0 })), 0);
    assert.equal(run({}, () => ({ status: 9 })), 9);
  });
});
