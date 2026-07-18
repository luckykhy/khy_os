'use strict';

/**
 * unknownProblemHandler.test.js — Unknown-Problem Handler state machine
 * (DESIGN-ARCH-043) pure-module contract.
 *
 * Pins the SINGLE-SOURCE invariant: the structure heads the prompt tells the
 * model to emit are exactly the heads the detectors match back out, so the
 * prompt and the execution-chain gate can never drift. Also pins the
 * default-off switch and the defensive helpers.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const uph = require('../../src/services/unknownProblemHandler');

const FLAG = uph.ENV_FLAG;
afterEach(() => { delete process.env[FLAG]; });

describe('unknownProblemHandler.isEnabled (default-off switch)', () => {
  test('off by default and for falsy/garbage values', () => {
    delete process.env[FLAG];
    assert.equal(uph.isEnabled(), false);
    for (const v of ['', '0', 'false', 'off', 'no', 'nope']) {
      process.env[FLAG] = v;
      assert.equal(uph.isEnabled(), false, `"${v}" must be off`);
    }
  });
  test('on for 1/true/on (case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'on', 'On']) {
      process.env[FLAG] = v;
      assert.equal(uph.isEnabled(), true, `"${v}" must be on`);
    }
  });
});

describe('detectors match the prompt structure heads (single-source)', () => {
  const section = uph.buildStateMachineSection();

  test('every MARKER head literally appears in the generated prompt', () => {
    assert.ok(section.includes(uph.MARKERS.INFO_UNKNOWN), 'prompt must teach 🔍 head');
    assert.ok(section.includes(uph.MARKERS.INFO_CONFIRM), 'prompt must teach ❓ head');
    assert.ok(section.includes(uph.MARKERS.PROPOSE), 'prompt must teach 🧭 head');
    assert.ok(section.includes(uph.MARKERS.EXEC_STEP), 'prompt must teach ⚙️ head');
    assert.ok(section.includes(uph.MARKERS.EXEC_CHECK), 'prompt must teach ✅ head');
    assert.ok(section.includes(uph.MARKERS.DEVIATION), 'prompt must teach ⚠️ head');
    assert.ok(section.includes(uph.MARKERS.TRUNCATION), 'prompt must teach 生成中断预警 retry');
  });

  test('prompt forbids [State: X] markers and the prohibition is explicit', () => {
    assert.match(section, /严禁输出 `\[State: X\]`/);
    assert.doesNotMatch(section, /\[State:\s*\w+\]\s*$/m, 'must not itself use a [State:X] line marker');
  });

  test('isInfoRequest: true only when the 🔍 head is present', () => {
    assert.equal(uph.isInfoRequest(`${uph.MARKERS.INFO_UNKNOWN}\n- 缺少目标`), true);
    assert.equal(uph.isInfoRequest('好的，我开始执行。'), false);
    assert.equal(uph.isInfoRequest(''), false);
    assert.equal(uph.isInfoRequest(null), false);
  });

  test('isDeviationWarning: true only when the ⚠️ 偏离预警 head is present', () => {
    assert.equal(uph.isDeviationWarning(`${uph.MARKERS.DEVIATION}：校验点2失败`), true);
    // The truncation marker is a different ⚠️ head and must NOT be a deviation.
    assert.equal(uph.isDeviationWarning(uph.MARKERS.TRUNCATION), false);
    assert.equal(uph.isDeviationWarning('一切正常'), false);
  });

  test('isExecutionStep: true only when the ⚙️ 执行步骤 head is present', () => {
    assert.equal(uph.isExecutionStep(`${uph.MARKERS.EXEC_STEP} [1/3]**：建目录`), true);
    assert.equal(uph.isExecutionStep('我在思考方案'), false);
  });
});

describe('isExecutionTruncated (active-retry trigger)', () => {
  test('non-execution replies are never truncated', () => {
    assert.equal(uph.isExecutionTruncated('普通文本'), false);
    assert.equal(uph.isExecutionTruncated(`${uph.MARKERS.INFO_UNKNOWN} ...`), false);
  });
  test('execution step WITHOUT a checkpoint is truncated', () => {
    assert.equal(uph.isExecutionTruncated(`${uph.MARKERS.EXEC_STEP} [1/3]**：建目录然后`), true);
  });
  test('execution step WITH a checkpoint is complete', () => {
    const complete = `${uph.MARKERS.EXEC_STEP} [1/3]**：建目录\n${uph.MARKERS.EXEC_CHECK}：目录存在=是`;
    assert.equal(uph.isExecutionTruncated(complete), false);
  });
  test('adapter length-stop forces truncated even with a checkpoint', () => {
    const complete = `${uph.MARKERS.EXEC_STEP} [1/3]**：x\n${uph.MARKERS.EXEC_CHECK}：ok`;
    assert.equal(uph.isExecutionTruncated(complete, { stopReasonLength: true }), true);
  });
});

describe('defensive directive builders', () => {
  test('buildSanitizationDirective is a [System: ...] reset that keeps intent + failure reason', () => {
    const d = uph.buildSanitizationDirective('网络超时');
    assert.match(d, /^\[System:/);
    assert.match(d, /上下文重置/);
    assert.match(d, /网络超时/);
    assert.match(d, /清除中间错误假设/);
  });
  test('buildSanitizationDirective has a safe default reason', () => {
    const d = uph.buildSanitizationDirective();
    assert.match(d, /上一步执行校验失败/);
  });
  test('truncationRetryPrefix leads with the 生成中断预警 marker', () => {
    assert.ok(uph.truncationRetryPrefix().startsWith(uph.MARKERS.TRUNCATION));
  });
});
