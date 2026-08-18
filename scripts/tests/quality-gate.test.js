'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMode, selectStages } = require('../quality-gate/lib/qualityGateStages');
const { run } = require('../quality-gate/index');

describe('quality gate orchestration', () => {
  test('accepts exactly pr and release modes', () => {
    assert.equal(parseMode(['node', 'index.js', '--mode', 'pr']), 'pr');
    assert.equal(parseMode(['node', 'index.js', '--mode', 'release']), 'release');
    assert.throws(() => parseMode(['node', 'index.js']), /usage/);
    assert.throws(() => parseMode(['node', 'index.js', '--mode', 'other']), /invalid mode/);
  });

  test('release is a strict superset of PR stages', () => {
    const pr = selectStages('pr').map((stage) => stage.target);
    const release = selectStages('release').map((stage) => stage.target);
    assert.deepEqual(pr, ['agent-rules', 'provider-contract', 'workflow-regression', 'backend-coverage']);
    assert.deepEqual(release.slice(0, pr.length), pr);
    assert.deepEqual(release.slice(pr.length), ['version-sync', 'script-tests']);
  });

  test('returns failure and does not spawn stages after the first failure', () => {
    let calls = 0;
    const code = run(['node', 'index.js', '--mode', 'pr'], () => {
      calls += 1;
      return { status: calls === 2 ? 1 : 0 };
    });
    assert.equal(code, 1);
    assert.equal(calls, 2);
  });

  test('returns usage error without spawning', () => {
    const code = run(['node', 'index.js', '--mode', 'bad'], () => {
      throw new Error('must not spawn');
    });
    assert.equal(code, 2);
  });
});
