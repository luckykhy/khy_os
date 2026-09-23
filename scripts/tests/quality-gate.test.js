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
    assert.deepEqual(pr, [
      'agent-rules',
      'code-standards',
      'security-headers',
      'auth-session',
      'api-contracts',
      'ai-gateway',
      'data-lifecycle',
      'ops-health',
      'upload-safety',
      'frontend-design-tokens',
      'provider-contract',
      'workflow-regression',
      'backend-coverage',
    ]);
    // release 必须**覆盖** pr 的每一个阶段且保持相对次序,并额外多跑 release-only 阶段。
    // (旧断言要求 pr 是 release 的**连续前缀**——那是 4 阶段时代的巧合;新增
    //  release-only 的 notify-webhook 被有意插在 ops 组内后,前缀性不再成立,
    //  但「严格超集」这一被断言的不变量依旧成立。)
    assert.deepEqual(release.filter((target) => pr.includes(target)), pr);
    assert.deepEqual(
      release.filter((target) => !pr.includes(target)),
      ['notify-webhook', 'version-sync', 'script-tests'],
    );
    assert.ok(release.length > pr.length);
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
