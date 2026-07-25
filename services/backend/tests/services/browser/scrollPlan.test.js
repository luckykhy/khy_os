'use strict';

/**
 * scrollPlan.test.js — 纯叶子 scrollPlan 的确定性单测 (node:test)。
 *
 * 覆盖 Playwright「强力爬虫」的全部判断核心：配置夹取 / 门控 / 停止启发式 /
 * 虚拟滚动去重 / 跳转目标归一。这些都是确定性纯逻辑（零 IO），IO 层 session.js
 * 只执行它们裁决出的动作。
 *
 * jest 自动忽略 node:test 文件（jest.config.js 扫 require('node:test')），故本套只由
 * `npm run test:node` 跑。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const plan = require('../../../src/services/browser/scrollPlan');

describe('scrollPlan.isEnabled (gate)', () => {
  test('default on', () => {
    assert.equal(plan.isEnabled({}), true);
    assert.equal(plan.isEnabled({ KHY_BROWSER_AUTOSCROLL: '' }), true);
    assert.equal(plan.isEnabled({ KHY_BROWSER_AUTOSCROLL: '1' }), true);
  });
  test('off via {0,false,off,no} (case-insensitive)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(plan.isEnabled({ KHY_BROWSER_AUTOSCROLL: v }), false, `${JSON.stringify(v)} should disable`);
    }
  });
});

describe('scrollPlan.normalizeScrollConfig — defaults, env, clamping', () => {
  test('empty opts/env → DEFAULTS', () => {
    const c = plan.normalizeScrollConfig({}, {});
    assert.equal(c.maxPasses, plan.DEFAULTS.maxPasses);
    assert.equal(c.settleMs, plan.DEFAULTS.settleMs);
    assert.equal(c.stableRounds, plan.DEFAULTS.stableRounds);
    assert.equal(c.maxChars, plan.DEFAULTS.maxChars);
    assert.equal(c.stepRatio, plan.DEFAULTS.stepRatio);
    assert.equal(c.harvest, false);
    assert.equal(c.harvestSelector, null);
    assert.equal(c.toSelector, null);
  });

  test('opts override and are clamped to bounds', () => {
    const c = plan.normalizeScrollConfig(
      { maxPasses: 99999, settleMs: -10, maxChars: 1, stepRatio: 5, stableRounds: 0 }, {},
    );
    assert.equal(c.maxPasses, 1000);   // capped
    assert.equal(c.settleMs, 0);       // floored
    assert.equal(c.maxChars, 1000);    // floored
    assert.equal(c.stepRatio, 1);      // capped
    assert.equal(c.stableRounds, 1);   // floored
  });

  test('env supplies defaults when opts omit them', () => {
    const c = plan.normalizeScrollConfig({}, {
      KHY_BROWSER_SCROLL_MAX_PASSES: '5',
      KHY_BROWSER_SCROLL_SETTLE_MS: '50',
      KHY_BROWSER_SCROLL_MAX_CHARS: '12345',
    });
    assert.equal(c.maxPasses, 5);
    assert.equal(c.settleMs, 50);
    assert.equal(c.maxChars, 12345);
  });

  test('opts win over env', () => {
    const c = plan.normalizeScrollConfig({ maxPasses: 7 }, { KHY_BROWSER_SCROLL_MAX_PASSES: '5' });
    assert.equal(c.maxPasses, 7);
  });

  test('harvest flags / selectors normalized', () => {
    const c = plan.normalizeScrollConfig({ harvest: true, harvestSelector: '  .list  ', toSelector: '#end' }, {});
    assert.equal(c.harvest, true);
    assert.equal(c.harvestSelector, '.list');
    assert.equal(c.toSelector, '#end');
  });

  test('non-object opts/env are fail-soft', () => {
    const c = plan.normalizeScrollConfig(null, null);
    assert.equal(c.maxPasses, plan.DEFAULTS.maxPasses);
  });
});

describe('scrollPlan.nextStagnant', () => {
  test('first round (no prevHeight) is never stagnant', () => {
    assert.equal(plan.nextStagnant(0, NaN, 1000), 0);
  });
  test('height grows → reset to 0', () => {
    assert.equal(plan.nextStagnant(3, 1000, 1500), 0);
  });
  test('height unchanged → increment', () => {
    assert.equal(plan.nextStagnant(2, 1000, 1000), 3);
  });
  test('height shrinks (still no growth) → increment', () => {
    assert.equal(plan.nextStagnant(1, 1000, 900), 2);
  });
  test('unreadable height → keep streak unchanged', () => {
    assert.equal(plan.nextStagnant(2, 1000, NaN), 2);
  });
});

describe('scrollPlan.decideContinue', () => {
  test('continues by default', () => {
    const d = plan.decideContinue({ pass: 1, maxPasses: 60, stagnantStreak: 0, stableRounds: 3 });
    assert.equal(d.cont, true);
  });
  test('stops at max-passes', () => {
    const d = plan.decideContinue({ pass: 60, maxPasses: 60, stagnantStreak: 0, stableRounds: 3 });
    assert.equal(d.cont, false);
    assert.equal(d.reason, 'max-passes');
  });
  test('stops at char-cap', () => {
    const d = plan.decideContinue({ pass: 2, maxPasses: 60, stagnantStreak: 0, stableRounds: 3, harvestedChars: 5000, maxChars: 5000 });
    assert.equal(d.cont, false);
    assert.equal(d.reason, 'char-cap');
  });
  test('stops when stable (height not growing)', () => {
    const d = plan.decideContinue({ pass: 5, maxPasses: 60, stagnantStreak: 3, stableRounds: 3 });
    assert.equal(d.cont, false);
    assert.equal(d.reason, 'stable');
  });
  test('max-passes takes priority over stable', () => {
    const d = plan.decideContinue({ pass: 60, maxPasses: 60, stagnantStreak: 0, stableRounds: 3 });
    assert.equal(d.reason, 'max-passes');
  });
});

describe('scrollPlan.mergeHarvest — virtual-scroll dedup', () => {
  test('appends new lines, dedupes repeats', () => {
    let s = plan.newHarvestState();
    s = plan.mergeHarvest(s, 'a\nb\nc', 1_000_000);
    assert.equal(s.lines, 3);
    // Virtual list recycles: b, c reappear with a new d.
    s = plan.mergeHarvest(s, 'b\nc\nd', 1_000_000);
    assert.equal(s.lines, 4); // only d is new
    assert.equal(s.text, 'a\nb\nc\nd');
  });

  test('blank lines skipped and lines trimmed', () => {
    let s = plan.newHarvestState();
    s = plan.mergeHarvest(s, '  x  \n\n   \n y ', 1_000_000);
    assert.equal(s.text, 'x\ny');
    assert.equal(s.lines, 2);
  });

  test('respects maxChars and sets truncated', () => {
    let s = plan.newHarvestState();
    s = plan.mergeHarvest(s, 'aaaa\nbbbb\ncccc', 6); // 'aaaa'(4) ok, '\nbbbb' would exceed
    assert.equal(s.truncated, true);
    assert.ok(s.chars <= 6);
  });

  test('does not mutate the input state (pure)', () => {
    const s0 = plan.newHarvestState();
    const s1 = plan.mergeHarvest(s0, 'a\nb', 1_000_000);
    assert.equal(s0.lines, 0);
    assert.equal(s0.text, '');
    assert.equal(s1.lines, 2);
  });

  test('once truncated, further chunks are ignored', () => {
    let s = plan.newHarvestState();
    s = plan.mergeHarvest(s, 'aaaa\nbbbb', 6);
    assert.equal(s.truncated, true);
    const before = s.text;
    s = plan.mergeHarvest(s, 'zzzz', 6);
    assert.equal(s.text, before);
  });
});

describe('scrollPlan.resolveIndexTarget', () => {
  test('anchor / hash strips leading #', () => {
    assert.deepEqual(plan.resolveIndexTarget({ hash: '#section-2' }), { mode: 'anchor', value: 'section-2' });
    assert.deepEqual(plan.resolveIndexTarget({ anchor: 'top' }), { mode: 'anchor', value: 'top' });
  });

  test('index with itemSelector', () => {
    const t = plan.resolveIndexTarget({ index: 50, itemSelector: '.item' });
    assert.equal(t.mode, 'index');
    assert.equal(t.index, 50);
    assert.equal(t.itemSelector, '.item');
  });

  test('index without itemSelector falls back to selector then "*"', () => {
    assert.equal(plan.resolveIndexTarget({ index: 3, selector: 'li' }).itemSelector, 'li');
    assert.equal(plan.resolveIndexTarget({ index: 3 }).itemSelector, '*');
  });

  test('index is clamped to an integer >= 0', () => {
    assert.equal(plan.resolveIndexTarget({ index: -5 }).index, 0);
    assert.equal(plan.resolveIndexTarget({ index: 2.7 }).index, 3);
  });

  test('text mode (optionally scoped by selector)', () => {
    assert.deepEqual(plan.resolveIndexTarget({ text: 'Chapter 5' }), { mode: 'text', text: 'Chapter 5', selector: null });
    const t = plan.resolveIndexTarget({ text: 'X', selector: 'h2' });
    assert.equal(t.selector, 'h2');
  });

  test('plain selector mode', () => {
    assert.deepEqual(plan.resolveIndexTarget({ selector: '#footer' }), { mode: 'selector', selector: '#footer' });
  });

  test('priority: anchor > index > text > selector', () => {
    const t = plan.resolveIndexTarget({ hash: '#a', index: 1, text: 'x', selector: '#s' });
    assert.equal(t.mode, 'anchor');
  });

  test('no target → mode none (fail-soft)', () => {
    assert.equal(plan.resolveIndexTarget({}).mode, 'none');
    assert.equal(plan.resolveIndexTarget(null).mode, 'none');
    assert.equal(plan.resolveIndexTarget({ index: 'abc' }).mode, 'none');
  });
});
