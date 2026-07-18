'use strict';

// goalKickoff.test.js — 纯叶子「设定即开跑 kickoff 文案 + 页脚 elapsed 格式化」单一真源测试(node:test)。
//
// 背景(goal 2026-07-03「/goal 对齐 Claude Code」):CC 的 /goal <文本> 设定即执行,页脚常驻
// `◎ /goal active (Nm)`。本叶子决定 (a) 设定那刻要 aiForward 的 kickoff 文本,(b) 页脚已持续时长
// 标签。零 IO、确定性、绝不抛。
const { test } = require('node:test');
const assert = require('node:assert');
const kick = require('../../src/services/goalKickoff');

const GATE = 'KHY_GOAL_AUTODRIVE';
const PARENT = 'KHY_GOAL';

function withEnv(overrides, fn) {
  const prev = {};
  for (const k of Object.keys(overrides)) {
    prev[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(overrides)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// ── isAutoDriveEnabled 门控阶梯 ──────────────────────────────────────────────
test('默认(父/子门控均未设)→ autodrive 开', () => {
  withEnv({ [PARENT]: undefined, [GATE]: undefined }, () => {
    assert.equal(kick.isAutoDriveEnabled(process.env), true);
  });
});

test('子门控显式关(off/0/false/no)→ 关', () => {
  for (const v of ['off', '0', 'false', 'no', 'OFF', 'False']) {
    withEnv({ [PARENT]: undefined, [GATE]: v }, () => {
      assert.equal(kick.isAutoDriveEnabled(process.env), false);
    });
  }
});

test('父门控 KHY_GOAL 关 → 子门控也关(嵌套)', () => {
  withEnv({ [PARENT]: 'off', [GATE]: undefined }, () => {
    assert.equal(kick.isAutoDriveEnabled(process.env), false);
  });
  // 父关即便子显式开也关
  withEnv({ [PARENT]: '0', [GATE]: 'true' }, () => {
    assert.equal(kick.isAutoDriveEnabled(process.env), false);
  });
});

// ── buildGoalKickoffMessage ─────────────────────────────────────────────────
test('门控开 + 有目标文本 → kickoff 含目标 + 立即动手 + 有限交付物 + 完成即清除', () => {
  withEnv({ [PARENT]: undefined, [GATE]: undefined }, () => {
    const msg = kick.buildGoalKickoffMessage({ text: '把技巧制作完并确保可用' }, { env: process.env });
    assert.equal(typeof msg, 'string');
    assert.match(msg, /把技巧制作完并确保可用/);
    assert.match(msg, /立即/);
    assert.match(msg, /有限.*交付物|交付物/);
    assert.match(msg, /GoalTool\(action=clear\)|清除|完成报告/);
  });
});

test('门控关 → 返回 null(逐字节回退:设定但不自动跑)', () => {
  withEnv({ [GATE]: 'off' }, () => {
    assert.equal(kick.buildGoalKickoffMessage({ text: '任意目标' }, { env: process.env }), null);
  });
});

test('无目标文本(空/缺失)→ null,即使门控开', () => {
  withEnv({ [PARENT]: undefined, [GATE]: undefined }, () => {
    assert.equal(kick.buildGoalKickoffMessage({ text: '   ' }, { env: process.env }), null);
    assert.equal(kick.buildGoalKickoffMessage({}, { env: process.env }), null);
    assert.equal(kick.buildGoalKickoffMessage(null, { env: process.env }), null);
  });
});

// ── formatGoalElapsed ───────────────────────────────────────────────────────
test('分钟级:<1min → 0m;4min → 4m', () => {
  const base = Date.parse('2026-07-03T10:00:00.000Z');
  assert.equal(kick.formatGoalElapsed('2026-07-03T10:00:00.000Z', base + 30 * 1000), '0m');
  assert.equal(kick.formatGoalElapsed('2026-07-03T10:00:00.000Z', base + 4 * 60 * 1000), '4m');
  assert.equal(kick.formatGoalElapsed('2026-07-03T10:00:00.000Z', base + 59 * 60 * 1000), '59m');
});

test('跨小时:1h2m;跨天:2d3h', () => {
  const start = '2026-07-03T00:00:00.000Z';
  const base = Date.parse(start);
  assert.equal(kick.formatGoalElapsed(start, base + (62 * 60 * 1000)), '1h2m');
  assert.equal(kick.formatGoalElapsed(start, base + ((2 * 24 + 3) * 60 * 60 * 1000)), '2d3h');
});

test('非法 / 未来 / 缺失 createdAt → 0m,绝不抛', () => {
  const now = Date.parse('2026-07-03T10:00:00.000Z');
  assert.equal(kick.formatGoalElapsed('not-a-date', now), '0m');
  assert.equal(kick.formatGoalElapsed(undefined, now), '0m');
  assert.equal(kick.formatGoalElapsed(null, now), '0m');
  // 未来时间(createdAt 晚于 now)→ 负值钳成 0m
  assert.equal(kick.formatGoalElapsed('2026-07-03T11:00:00.000Z', now), '0m');
  // now 非法 → 0m
  assert.equal(kick.formatGoalElapsed('2026-07-03T10:00:00.000Z', NaN), '0m');
  assert.doesNotThrow(() => kick.formatGoalElapsed({}, {}));
});
