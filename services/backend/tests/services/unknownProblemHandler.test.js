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
const uph = require('../../src/services/unknownProblemHandler');
const FLAG = uph.ENV_FLAG;
afterEach(() => { delete process.env[FLAG]; });
describe('unknownProblemHandler.isEnabled (default-off switch)', () => {
});
describe('detectors match the prompt structure heads (single-source)', () => {
  const section = uph.buildStateMachineSection();
});
describe('isExecutionTruncated (active-retry trigger)', () => {
});
describe('defensive directive builders', () => {
});

describe('Unknown Problem Handler', () => {
  test('off by default and for falsy/garbage values', () => {
        delete process.env[FLAG];
        expect(uph.isEnabled()).toBe(false);
        for (const v of ['', '0', 'false', 'off', 'no', 'nope']) {
          process.env[FLAG] = v;
          expect(uph.isEnabled()).toBe(false);
        }
  });

  test('on for 1/true/on (case-insensitive)', () => {
        for (const v of ['1', 'true', 'TRUE', 'on', 'On']) {
          process.env[FLAG] = v;
          expect(uph.isEnabled()).toBe(true);
        }
  });

  test('every MARKER head literally appears in the generated prompt', () => {
        expect(section.includes(uph.MARKERS.INFO_UNKNOWN)).toBeTruthy();
        expect(section.includes(uph.MARKERS.INFO_CONFIRM)).toBeTruthy();
        expect(section.includes(uph.MARKERS.PROPOSE)).toBeTruthy();
        expect(section.includes(uph.MARKERS.EXEC_STEP)).toBeTruthy();
        expect(section.includes(uph.MARKERS.EXEC_CHECK)).toBeTruthy();
        expect(section.includes(uph.MARKERS.DEVIATION)).toBeTruthy();
        expect(section.includes(uph.MARKERS.TRUNCATION)).toBeTruthy();
  });

  test('prompt forbids [State: X] markers and the prohibition is explicit', () => {
        expect(section).toMatch(/严禁输出 `\[State: X\]`/);
        expect(section).not.toMatch(/\[State:\s*\w+\]\s*$/m);
  });

  test('isInfoRequest: true only when the 🔍 head is present', () => {
        expect(uph.isInfoRequest(`${uph.MARKERS.INFO_UNKNOWN}\n- 缺少目标`)).toBe(true);
        expect(uph.isInfoRequest('好的，我开始执行。')).toBe(false);
        expect(uph.isInfoRequest('')).toBe(false);
        expect(uph.isInfoRequest(null)).toBe(false);
  });

  test('isDeviationWarning: true only when the ⚠️ 偏离预警 head is present', () => {
        expect(uph.isDeviationWarning(`${uph.MARKERS.DEVIATION}：校验点2失败`)).toBe(true);
        // The truncation marker is a different ⚠️ head and must NOT be a deviation.
        expect(uph.isDeviationWarning(uph.MARKERS.TRUNCATION)).toBe(false);
        expect(uph.isDeviationWarning('一切正常')).toBe(false);
  });

  test('isExecutionStep: true only when the ⚙️ 执行步骤 head is present', () => {
        expect(uph.isExecutionStep(`${uph.MARKERS.EXEC_STEP} [1/3]**：建目录`)).toBe(true);
        expect(uph.isExecutionStep('我在思考方案')).toBe(false);
  });

  test('non-execution replies are never truncated', () => {
        expect(uph.isExecutionTruncated('普通文本')).toBe(false);
        expect(uph.isExecutionTruncated(`${uph.MARKERS.INFO_UNKNOWN} ...`)).toBe(false);
  });

  test('execution step WITHOUT a checkpoint is truncated', () => {
        expect(uph.isExecutionTruncated(`${uph.MARKERS.EXEC_STEP} [1/3]**：建目录然后`)).toBe(true);
  });

  test('execution step WITH a checkpoint is complete', () => {
        const complete = `${uph.MARKERS.EXEC_STEP} [1/3]**：建目录\n${uph.MARKERS.EXEC_CHECK}：目录存在=是`;
        expect(uph.isExecutionTruncated(complete)).toBe(false);
  });

  test('adapter length-stop forces truncated even with a checkpoint', () => {
        const complete = `${uph.MARKERS.EXEC_STEP} [1/3]**：x\n${uph.MARKERS.EXEC_CHECK}：ok`;
        expect(uph.isExecutionTruncated(complete, { stopReasonLength: true })).toBe(true);
  });

  test('buildSanitizationDirective is a [System: ...] reset that keeps intent + failure reason', () => {
        const d = uph.buildSanitizationDirective('网络超时');
        expect(d).toMatch(/^\[System:/);
        expect(d).toMatch(/上下文重置/);
        expect(d).toMatch(/网络超时/);
        expect(d).toMatch(/清除中间错误假设/);
  });

  test('buildSanitizationDirective has a safe default reason', () => {
        const d = uph.buildSanitizationDirective();
        expect(d).toMatch(/上一步执行校验失败/);
  });

  test('truncationRetryPrefix leads with the 生成中断预警 marker', () => {
        expect(uph.truncationRetryPrefix().toBeTruthy().startsWith(uph.MARKERS.TRUNCATION));
  });

});
