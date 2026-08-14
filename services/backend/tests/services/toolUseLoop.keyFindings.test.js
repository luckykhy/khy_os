'use strict';

/**
 * Key-findings reporter — loop-side wiring (关键节点主动汇报).
 *
 * The deterministic test-parsing and model-<finding> parse/strip/compose logic
 * is fully unit-tested in tests/cli/keyFindings.test.js. These tests pin the
 * INTEGRATION the loop is responsible for:
 *   1. the loop actually required the module and exported its prompt injector,
 *   2. _injectKeyFindingsPrompt prepends the <finding> instruction as a
 *      user-message preamble (mirroring _injectPlanningPrompt), and
 *   3. KHY_KEY_FINDINGS* env gates turn the injection into a no-op,
 *   4. _stripExecutionPlan also strips <finding> blocks (shared display seam).
 */

const loop = require('../../src/services/toolUseLoop');

describe('toolUseLoop key-findings wiring', () => {
  test('exports _injectKeyFindingsPrompt', () => {
    expect(typeof loop._injectKeyFindingsPrompt).toBe('function');
  });

  test('prepends the <finding> instruction as a preamble, preserving the message', () => {
    const out = loop._injectKeyFindingsPrompt('帮我修复这个 bug', {});
    expect(out).toContain('<finding type="root_cause">');
    expect(out).toContain('breakthrough');
    expect(out).toContain('blocked');
    // original message survives, at the end
    expect(out.endsWith('帮我修复这个 bug')).toBe(true);
  });

  test('KHY_KEY_FINDINGS=0 makes injection a no-op', () => {
    const msg = '帮我修复这个 bug';
    expect(loop._injectKeyFindingsPrompt(msg, { KHY_KEY_FINDINGS: '0' })).toBe(msg);
  });

  test('KHY_KEY_FINDINGS_MODEL=0 makes injection a no-op', () => {
    const msg = '帮我修复这个 bug';
    expect(loop._injectKeyFindingsPrompt(msg, { KHY_KEY_FINDINGS_MODEL: 'off' })).toBe(msg);
  });

  test('_stripExecutionPlan also removes <finding> blocks (shared display seam)', () => {
    const raw = [
      'before',
      '<execution_plan>1. do</execution_plan>',
      '<finding type="root_cause">未初始化的 config</finding>',
      'after',
    ].join('\n');
    const stripped = loop._stripExecutionPlan(raw);
    expect(stripped).not.toContain('<execution_plan>');
    expect(stripped).not.toContain('<finding');
    expect(stripped).not.toContain('未初始化');
    expect(stripped).toContain('before');
    expect(stripped).toContain('after');
  });
});
