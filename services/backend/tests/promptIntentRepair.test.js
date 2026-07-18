'use strict';

/**
 * promptIntentRepair — 「奔赴真实意图」leaf unit tests.
 *
 * Validates that khyos first tries to understand a messy prompt itself (typos /
 * dropped chars / garbled characters, using context) before falling back to
 * clarification cards. The trigger is zero-false-positive: structural garble
 * (replacement / zero-width / control chars) fires regardless of clarity; an
 * otherwise-unclear prompt fires the "interpret-with-context" nudge; a clean,
 * clear prompt does NOT fire (system prompt byte-identical). Disabled → no
 * directive.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectGarbleSignals,
  lightNormalize,
  assessRepairNeed,
  buildRepairDirective,
  routeIntentRepair,
} = require('../src/services/promptIntentRepair');

const ZW = '\u200B';   // zero-width space
const CTL = '\u0007';  // bell (control)
const FFFD = '\uFFFD'; // replacement char

describe('detectGarbleSignals — strong structural garble (zero false positive)', () => {
  test('zero-width char → strong', () => {
    assert.deepEqual(detectGarbleSignals('帮我' + ZW + '写报告').strong, ['零宽字符']);
  });
  test('control char → strong', () => {
    assert.deepEqual(detectGarbleSignals('帮我' + CTL + '写报告').strong, ['控制字符']);
  });
  test('replacement char → strong', () => {
    assert.deepEqual(detectGarbleSignals('帮我' + FFFD + '写报告').strong, ['乱码字符(U+FFFD)']);
  });
  test('clean prompt → no signals at all', () => {
    const g = detectGarbleSignals('帮我写一个登录页面');
    assert.deepEqual(g.strong, []);
    assert.deepEqual(g.medium, []);
    assert.deepEqual(g.signals, []);
  });
});

describe('detectGarbleSignals — medium signals never fire on intentional repeats', () => {
  test('哈哈哈 (onomatopoeia) is NOT flagged', () => {
    assert.deepEqual(detectGarbleSignals('哈哈哈这个不错').medium, []);
  });
  test('谢谢谢 (thanks) is NOT flagged', () => {
    assert.deepEqual(detectGarbleSignals('谢谢谢你').medium, []);
  });
  test('digits repeating are NOT flagged', () => {
    assert.deepEqual(detectGarbleSignals('版本 2000 发布').medium, []);
  });
  test('abnormal char run (帮帮帮) → medium', () => {
    assert.ok(detectGarbleSignals('帮帮帮我看看').medium.includes('字符异常重复'));
  });
  test('>=3 inline spaces → 多余空白 medium', () => {
    assert.ok(detectGarbleSignals('帮我   写报告').medium.includes('多余空白'));
  });
  test('medium-only never appears in strong', () => {
    assert.deepEqual(detectGarbleSignals('帮帮帮我').strong, []);
  });
});

describe('lightNormalize — meaning-preserving structural cleanup only', () => {
  test('strips zero-width + collapses inline whitespace', () => {
    const r = lightNormalize('帮我' + ZW + '写   报告 ');
    assert.equal(r.changed, true);
    assert.equal(r.text, '帮我写 报告');
  });
  test('clean text is unchanged', () => {
    const r = lightNormalize('帮我写一个报告');
    assert.equal(r.changed, false);
    assert.equal(r.text, '帮我写一个报告');
  });
  test('code (backticks / fences) is left untouched', () => {
    const r = lightNormalize('跑 `npm   test`');
    assert.equal(r.changed, false);
    assert.equal(r.text, '跑 `npm   test`');
  });
  test('empty → unchanged empty', () => {
    assert.deepEqual(lightNormalize(''), { text: '', changed: false });
  });
});

describe('assessRepairNeed — when to nudge self-understanding', () => {
  test('clear + clean → need=false (no false positive, sp byte-identical)', () => {
    const r = assessRepairNeed({ text: '把这段代码重构成更清晰的结构' });
    assert.equal(r.need, false);
    assert.equal(r.reason, 'prompt-clear');
  });
  test('vague verb → need=true via unclear branch', () => {
    const r = assessRepairNeed({ text: '帮我看看这个' });
    assert.equal(r.need, true);
    assert.equal(r.reason, 'vague-verb');
  });
  test('clear-but-garbled → need=true via garble branch', () => {
    const r = assessRepairNeed({ text: '生成一个登录页面' + ZW + '的HTML' });
    assert.equal(r.need, true);
    assert.equal(r.reason, 'garble');
  });
  test('intent mode (goal) suppresses the unclear branch', () => {
    const r = assessRepairNeed({ text: '搞一下', modes: ['goal'] });
    assert.equal(r.need, false);
    assert.equal(r.reason, 'mode-active');
  });
  test('intent mode does NOT suppress structural garble', () => {
    const r = assessRepairNeed({ text: '搞一下' + FFFD, modes: ['goal'] });
    assert.equal(r.need, true);
    assert.equal(r.reason, 'garble');
  });
  test('empty prompt with media → unclear → need=true', () => {
    const r = assessRepairNeed({ text: '', hasMedia: true });
    assert.equal(r.need, true);
  });
  test('empty prompt no media → clear → need=false', () => {
    const r = assessRepairNeed({ text: '', hasMedia: false });
    assert.equal(r.need, false);
  });
});

describe('gating — KHY_PROMPT_INTENT_REPAIR', () => {
  test('options off-string variants disable', () => {
    for (const v of ['0', 'off', 'no', 'false']) {
      const r = assessRepairNeed({ text: '看看', options: { promptIntentRepair: v } });
      assert.equal(r.enabled, false, `value ${v} should disable`);
      assert.equal(r.need, false);
    }
  });
  test('default (no option) is enabled', () => {
    assert.equal(assessRepairNeed({ text: '看看' }).enabled, true);
  });
});

describe('buildRepairDirective — content contract', () => {
  test('mentions context-repair, 奔赴真实意图, and cards-as-last-resort', () => {
    const d = buildRepairDirective();
    assert.ok(d.length > 0);
    assert.match(d, /错别字/);
    assert.match(d, /漏字/);
    assert.match(d, /前后文语境/);
    assert.match(d, /奔赴真实意图/);
    assert.match(d, /选项卡/); // cards only as a last resort
  });
  test('lists detected signals when provided', () => {
    const d = buildRepairDirective({ signals: ['零宽字符', '多余空白'] });
    assert.match(d, /干扰信号/);
    assert.match(d, /零宽字符/);
  });
  test('includes cleaned hint when provided', () => {
    const d = buildRepairDirective({ cleanedHint: '帮我写报告' });
    assert.match(d, /参考版本/);
    assert.match(d, /帮我写报告/);
  });
  test('no signals/hint → no parenthetical reference lines', () => {
    const d = buildRepairDirective();
    assert.doesNotMatch(d, /干扰信号/);
    assert.doesNotMatch(d, /参考版本/);
  });
});

describe('routeIntentRepair — directive presence mirrors need', () => {
  test('garbled → directive present, carries cleaned hint + signals', () => {
    const r = routeIntentRepair({ text: '生成一个登录页面' + ZW + '的HTML' });
    assert.equal(r.need, true);
    assert.equal(typeof r.directive, 'string');
    assert.match(r.directive, /参考版本/);
    assert.match(r.directive, /干扰信号/);
  });
  test('clear+clean → directive null (no injection)', () => {
    const r = routeIntentRepair({ text: '生成一个登录页面的 HTML' });
    assert.equal(r.need, false);
    assert.equal(r.directive, null);
  });
  test('disabled → directive null', () => {
    const r = routeIntentRepair({ text: '看看', options: { promptIntentRepair: '0' } });
    assert.equal(r.directive, null);
  });
});
