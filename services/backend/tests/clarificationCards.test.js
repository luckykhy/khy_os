'use strict';

/**
 * clarificationCards — trigger + directive unit tests.
 *
 * Validates the "体察人的惰性" leaf: it fires a clarification-cards directive
 * ONLY when the prompt is genuinely unclear AND no intent mode is active, reusing
 * multimodalIntentRouter.assessPromptClarity (zero-false-positive). Disabled →
 * no directive (system prompt byte-identical).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  assessClarificationNeed,
  buildClarificationDirective,
  routeClarification,
} = require('../src/services/clarificationCards');

describe('assessClarificationNeed — when to raise cards', () => {
  test('vague verb ("看看") → need=true', () => {
    const r = assessClarificationNeed({ text: '帮我看看这个' });
    assert.equal(r.need, true);
    assert.equal(r.clarity.clear, false);
  });

  test('reference-only ("用 khyos") → need=true', () => {
    const r = assessClarificationNeed({ text: 'khyos' });
    assert.equal(r.need, true);
    assert.equal(r.clarity.reason, 'reference-only-no-instruction');
  });

  test('empty prompt WITH media → need=true', () => {
    const r = assessClarificationNeed({ text: '', hasMedia: true });
    assert.equal(r.need, true);
  });

  test('empty prompt WITHOUT media → need=false (no false positive on bare empty)', () => {
    const r = assessClarificationNeed({ text: '', hasMedia: false });
    assert.equal(r.need, false);
  });

  test('concrete instruction ("把这段代码重构成…") → need=false', () => {
    const r = assessClarificationNeed({ text: '把这段代码重构成更清晰的结构' });
    assert.equal(r.need, false);
    assert.equal(r.clarity.clear, true);
  });

  test('specific-enough English prompt → need=false', () => {
    const r = assessClarificationNeed({ text: 'Add a retry with exponential backoff to the fetch helper' });
    assert.equal(r.need, false);
  });

  test('intent mode active (goal) suppresses cards even when vague', () => {
    const r = assessClarificationNeed({ text: '搞一下', modes: ['goal'] });
    assert.equal(r.modeActive, true);
    assert.equal(r.need, false);
    assert.equal(r.reason, 'mode-active');
  });

  test('coding mode also suppresses', () => {
    const r = assessClarificationNeed({ text: '弄一下', modes: ['coding'] });
    assert.equal(r.need, false);
  });

  test('unrelated mode does NOT suppress', () => {
    const r = assessClarificationNeed({ text: '你看着办', modes: ['unknown_mode'] });
    assert.equal(r.modeActive, false);
    assert.equal(r.need, true);
  });
});

describe('gating — KHY_CLARIFICATION_CARDS', () => {
  test('options.clarificationCards=false → disabled, need=false', () => {
    const r = assessClarificationNeed({ text: '看看', options: { clarificationCards: false } });
    assert.equal(r.enabled, false);
    assert.equal(r.need, false);
    assert.equal(r.reason, 'disabled');
  });

  test('options off-string variants disable', () => {
    for (const v of ['0', 'off', 'no', 'false']) {
      const r = assessClarificationNeed({ text: '搞定', options: { clarificationCards: v } });
      assert.equal(r.enabled, false, `value ${v} should disable`);
    }
  });

  test('default (no option) is enabled', () => {
    const r = assessClarificationNeed({ text: '看看' });
    assert.equal(r.enabled, true);
  });
});

describe('buildClarificationDirective — content contract', () => {
  test('is a non-empty Chinese directive mentioning cards/multiSelect/可讨论', () => {
    const d = buildClarificationDirective();
    assert.ok(d.length > 0);
    assert.match(d, /选项卡/);
    assert.match(d, /左右切换/);
    assert.match(d, /multiSelect/);
    assert.match(d, /可讨论/);
    assert.match(d, /AskUserQuestion/);
    // Tells the model NOT to add 可讨论/自由输入 itself (system auto-appends).
    assert.match(d, /无需/);
  });
});

describe('routeClarification — directive presence mirrors need', () => {
  test('vague → directive present', () => {
    const r = routeClarification({ text: '处理一下' });
    assert.equal(r.need, true);
    assert.equal(typeof r.directive, 'string');
    assert.ok(r.directive.length > 0);
  });

  test('clear → directive null (no injection)', () => {
    const r = routeClarification({ text: '生成一个登录页面的 HTML' });
    assert.equal(r.need, false);
    assert.equal(r.directive, null);
  });

  test('disabled → directive null', () => {
    const r = routeClarification({ text: '看看', options: { clarificationCards: '0' } });
    assert.equal(r.directive, null);
  });
});
