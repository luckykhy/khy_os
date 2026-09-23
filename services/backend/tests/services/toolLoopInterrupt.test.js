'use strict';

/**
 * toolLoopInterrupt.test.js — locks the C3-P10 extraction of the tool-loop
 * interrupt-behavior family out of toolUseLoopCore.js into
 * services/backend/src/services/tool/loop/interrupt.js.
 *
 * The pre-existing integration suite (toolUseLoop.interruptBehavior.test.js) uses
 * jest globals + jest.fn/spyOn and cannot run under this rtk toolchain (jest is a
 * broken install), so this node:test suite covers the leaf's DETERMINISTIC pure
 * surface directly — the notice formatter (incl. its fallback-const path), the
 * fail-closed behavior resolver, the no-parent-signal passthrough, and the
 * result annotator. Behavior-preserving contract: byte-identical CN notice,
 * 'cancel' fail-closed, plan.maxMs===0 passthrough, notice only appended to
 * failed results.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  _resolveInterruptBehavior,
  _formatInterruptTimeoutNotice,
  _buildToolInterruptPlan,
  _annotateInterruptTimeout,
} = require('../../src/services/tool/loop/interrupt');

describe('loop/interrupt.js (C3-P10 leaf)', () => {
  test('format notice: round-second label (10000ms → 10s)', () => {
    assert.equal(
      _formatInterruptTimeoutNotice('readFile', 10000),
      '等待工具 readFile 完成超时(10s)，已强制中止'
    );
  });

  test('format notice: non-round-ms label (1500ms → 1500ms)', () => {
    assert.equal(
      _formatInterruptTimeoutNotice('x', 1500),
      '等待工具 x 完成超时(1500ms)，已强制中止'
    );
  });

  test('format notice: maxMs 0/invalid falls back to the 10s const', () => {
    // both non-finite and <=0 hit the fallback (INTERRUPT_BLOCK_MAX_MS_FALLBACK=10000)
    assert.match(_formatInterruptTimeoutNotice('y', 0), /超时\(10s\)/);
    assert.match(_formatInterruptTimeoutNotice('y', undefined), /超时\(10s\)/);
  });

  test('resolve behavior: unknown tool / registry issue fails CLOSED to cancel', () => {
    assert.equal(_resolveInterruptBehavior('__no_such_tool__'), 'cancel');
  });

  test('plan: no parent signal → passthrough (maxMs 0, signal null, never timedOut)', () => {
    const plan = _buildToolInterruptPlan('readFile', null, {}, () => 'block');
    assert.equal(plan.signal, null);
    assert.equal(plan.maxMs, 0);
    assert.equal(plan.timedOut(), false);
    assert.doesNotThrow(() => plan.cleanup());
  });

  test('plan: cancel-declared tool → passthrough even with a parent signal', () => {
    const ac = new AbortController();
    const plan = _buildToolInterruptPlan('readFile', ac.signal, {}, () => 'cancel');
    assert.equal(plan.signal, ac.signal, 'raw parent passes through verbatim');
    assert.equal(plan.maxMs, 0);
    plan.cleanup();
  });

  test('annotate: failed result gets notice in error + _interruptTimeoutNotice', () => {
    const out = _annotateInterruptTimeout({ success: false, error: 'boom' }, 'readFile', 10000);
    assert.match(out.error, /boom/);
    assert.match(out.error, /已强制中止/);
    assert.match(out._interruptTimeoutNotice, /等待工具 readFile 完成超时\(10s\)/);
  });

  test('annotate: successful result keeps honest success shape (notice only in metadata)', () => {
    const out = _annotateInterruptTimeout({ success: true }, 'readFile', 10000);
    assert.equal(out.success, true);
    assert.equal(out.error, undefined, 'success path must NOT fabricate an error');
    assert.ok(out._interruptTimeoutNotice);
  });

  test('annotate: non-object result returned untouched', () => {
    assert.equal(_annotateInterruptTimeout('plain-string', 'readFile', 10000), 'plain-string');
  });
});
