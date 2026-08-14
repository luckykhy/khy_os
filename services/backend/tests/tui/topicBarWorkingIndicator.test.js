'use strict';

/**
 * topicBarWorkingIndicator.test.js — 纯叶子契约:话题标题左侧字符(空闲=静态太阳 ✱,
 * 工作中=左右弹跳的小点)。用户诉求「对话标题左边那个太阳工作时换为左右移动的小点」。
 *
 * 覆盖:门控(flagRegistry 优先 + 本地 CANON 回退)、titlePrefix 空闲/工作/门控关三态、
 * 帧确定性 + 归一(负/越界 tick)、弹跳序列形状、fail-soft、导出稳定。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../../src/cli/tui/runtime/topicBarWorkingIndicator'));

test('isEnabled: default ON; CANON off-words disable', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_TOPIC_BAR_WORKING_DOT: 'true' }), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.equal(leaf.isEnabled({ KHY_TOPIC_BAR_WORKING_DOT: off }), false, `off=${off}`);
  }
  // non-CANON word stays ON (superset-safe)
  assert.equal(leaf.isEnabled({ KHY_TOPIC_BAR_WORKING_DOT: 'disabled' }), true);
});

test('titlePrefix: gate OFF → always static ✱ (byte-revert)', () => {
  const off = { KHY_TOPIC_BAR_WORKING_DOT: '0' };
  assert.equal(leaf.titlePrefix({ working: true, tick: 0 }, off), '✱ ');
  assert.equal(leaf.titlePrefix({ working: true, tick: 3 }, off), '✱ ');
  assert.equal(leaf.titlePrefix({ working: false, tick: 0 }, off), '✱ ');
});

test('titlePrefix: gate ON + idle → static ✱', () => {
  assert.equal(leaf.titlePrefix({ working: false, tick: 0 }, {}), '✱ ');
  assert.equal(leaf.titlePrefix({ working: false, tick: 5 }, {}), '✱ ');
});

test('titlePrefix: gate ON + working → bouncing dot frame (not the static ✱)', () => {
  const p0 = leaf.titlePrefix({ working: true, tick: 0 }, {});
  assert.ok(!p0.startsWith('✱'), 'working prefix must not be the static sun');
  assert.ok(p0.endsWith(' '), 'prefix ends with a separator space');
  // each frame is one of the FRAMES + a trailing space
  for (let i = 0; i < leaf.FRAMES.length; i++) {
    assert.equal(leaf.titlePrefix({ working: true, tick: i }, {}), `${leaf.FRAMES[i]} `);
  }
});

test('titlePrefix: deterministic + tick normalized (wrap + negative safe)', () => {
  const n = leaf.frameCount();
  // wrap-around: tick n === tick 0
  assert.equal(leaf.titlePrefix({ working: true, tick: n }, {}), leaf.titlePrefix({ working: true, tick: 0 }, {}));
  assert.equal(leaf.titlePrefix({ working: true, tick: 2 * n + 1 }, {}), leaf.titlePrefix({ working: true, tick: 1 }, {}));
  // negative tick → still a valid frame (no throw, no empty)
  const neg = leaf.titlePrefix({ working: true, tick: -1 }, {});
  assert.ok(neg.endsWith(' '));
  // determinism: same input twice → same output
  assert.equal(leaf.titlePrefix({ working: true, tick: 2 }, {}), leaf.titlePrefix({ working: true, tick: 2 }, {}));
});

test('FRAMES: left-right bounce shape (dot travels then returns, single dot per frame)', () => {
  // Exactly one dot per frame; the dot index goes 0→1→2→1 (a bounce).
  const DOT = '·';
  const idxs = leaf.FRAMES.map((f) => Array.from(f).findIndex((ch) => ch === DOT));
  // one and only one dot per frame
  leaf.FRAMES.forEach((f) => {
    const count = Array.from(f).filter((ch) => ch === DOT).length;
    assert.equal(count, 1, `frame "${f}" must contain exactly one dot`);
  });
  assert.deepEqual(idxs, [0, 1, 2, 1], 'dot bounces left→right→left');
});

test('titlePrefix: fail-soft on bad opts → static ✱', () => {
  assert.equal(leaf.titlePrefix(undefined, {}), '✱ ');
  assert.equal(leaf.titlePrefix({}, {}), '✱ '); // working defaults false
  assert.equal(leaf.titlePrefix({ working: true, tick: NaN }, {}), `${leaf.FRAMES[0]} `);
});

test('stable exports: STATIC_GLYPH / STATIC_PREFIX / describe', () => {
  assert.equal(leaf.STATIC_GLYPH, '✱');
  assert.equal(leaf.STATIC_PREFIX, '✱ ');
  const d = leaf.describeTopicBarWorkingIndicator();
  assert.equal(d.gate, 'KHY_TOPIC_BAR_WORKING_DOT');
  assert.equal(d.defaultOn, true);
  assert.equal(d.staticGlyph, '✱');
  assert.equal(d.frames, leaf.FRAMES.length);
});
