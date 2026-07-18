'use strict';

/**
 * toolCallNudges.test.js — 锁 buildAppLaunchToolNudge SSOT 口径
 *   (R75 收敛:toolUseLoopHelpers._buildAppLaunchToolNudge 委托至此)。
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildAppLaunchToolNudge } = require('../src/services/toolCallNudges');

test('含 app-launch 意图头 + 原始用户请求 + 前一回复', () => {
  const out = buildAppLaunchToolNudge('打开记事本', '上一条回复');
  assert.ok(out.includes('app-launch intent detected'));
  assert.ok(out.includes('打开记事本'));
  assert.ok(out.includes('上一条回复'));
  assert.ok(out.includes('open_app'));
});

test('R75 委托等价:toolUseLoopHelpers._buildAppLaunchToolNudge === SSOT', () => {
  const tulh = require('../src/services/toolUseLoopHelpers');
  const a = tulh._buildAppLaunchToolNudge('launch chrome', 'prev');
  const b = buildAppLaunchToolNudge('launch chrome', 'prev');
  assert.strictEqual(a, b);
});
