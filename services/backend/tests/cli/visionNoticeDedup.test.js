'use strict';

/**
 * visionNoticeDedup — 回合内「用户可见中间消息」逐字节去重叶(KHY_VISION_NOTICE_DEDUP)。
 *
 * /goal「同时减少显示的心灵噪音」:视觉描述级联在 agentic 工具循环里被多次迭代重入,同一句
 * `正在调用 <模型> 请稍候...` / 同一失败总结块在一个回合里被刷屏三遍。本叶在回合作用域按逐字节签名
 * 去重:首次「明显告知」照常渲染,后续逐字节重复的压制;不同模型名 / 不同失败真因 → 签名不同 → 全渲染。
 *
 * 验证:首见渲染并记签名、重复压制、不同消息各自保留、门关逐字节回退(恒渲染)、fail-open 绝不吞合法消息。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const dedup = require('../../src/cli/visionNoticeDedup');

function on(env) { return { ...env, KHY_VISION_NOTICE_DEDUP: undefined }; } // 门默认开

test('首见 → 渲染(true)并记入 seenSet;同回合逐字节重复 → 压制(false)', () => {
  const seen = new Set();
  const msg = '我无法直接识别图片内容。正在调用 glm-4v-flash 进行识别，请稍候...';
  assert.equal(dedup.shouldRender(seen, msg, on({})), true, '首见应渲染');
  assert.equal(seen.size, 1, '首见应记签名');
  assert.equal(dedup.shouldRender(seen, msg, on({})), false, '同回合逐字节重复应压制');
  assert.equal(dedup.shouldRender(seen, msg, on({})), false, '第三次仍压制');
});

test('视觉进度按阶段折叠，不同模型名或失败真因不重复刷屏', () => {
  const seen = new Set();
  const a = '正在调用 glm/glm-4.6v-flash 进行识别，请稍候...';
  const b = '正在调用 glm-4v-flash 进行识别，请稍候...';
  const c = '图像识别失败:目标视觉模型返回「未找到 / 404」。';
  const d = '图像识别失败:无法连接到图像识别模型服务(网络/代理/端点问题)。';
  assert.equal(dedup.shouldRender(seen, a, on({})), true);
  assert.equal(dedup.shouldRender(seen, b, on({})), false, '同一开始阶段只渲染一次');
  assert.equal(dedup.shouldRender(seen, c, on({})), true);
  assert.equal(dedup.shouldRender(seen, d, on({})), false, '同一失败阶段只渲染一次');
  assert.equal(seen.size, 2, '只记录开始与失败两个阶段');
});

test('复刻实测:一回合 6×正在调用 + 3×失败块 → 仅一条开始 + 一条失败', () => {
  const seen = new Set();
  const callA = '正在调用 glm/glm-4.6v-flash 进行识别，请稍候...';
  const callB = '正在调用 glm-4v-flash 进行识别，请稍候...';
  const fail404 = '图像识别失败:目标视觉模型返回「未找到 / 404」(model_not_found)。本次尝试的视觉模型:glm/glm-4.6v-flash。';
  const failNet = '图像识别失败:无法连接到图像识别模型服务(网络/代理/端点问题)。';
  const stream = [callA, callB, fail404, callA, callB, failNet, callA, callB, fail404];
  const rendered = stream.filter((m) => dedup.shouldRender(seen, m, on({})));
  assert.deepEqual(rendered, [callA, fail404]);
  assert.equal(rendered.length, 2, '9 条刷屏 → 2 条阶段告知');
});

test('普通助手消息不做语义折叠，最终回答不会被误删', () => {
  const seen = new Set();
  assert.equal(dedup.shouldRender(seen, '图片中是一张登录页。', on({})), true);
  assert.equal(dedup.shouldRender(seen, '图片中是一张注册页。', on({})), true);
  assert.equal(dedup.shouldRender(seen, '图片中是一张登录页。', on({})), false);
});

test('门关(KHY_VISION_NOTICE_DEDUP=off / 0 / false / no)→ 逐字节回退:恒渲染,不触碰 seenSet', () => {
  for (const w of ['off', '0', 'false', 'no']) {
    const seen = new Set();
    const msg = '正在调用 glm-4v-flash 进行识别，请稍候...';
    assert.equal(dedup.shouldRender(seen, msg, { KHY_VISION_NOTICE_DEDUP: w }), true, `off-word ${w} 首次渲染`);
    assert.equal(dedup.shouldRender(seen, msg, { KHY_VISION_NOTICE_DEDUP: w }), true, `off-word ${w} 重复仍渲染(回退)`);
    assert.equal(seen.size, 0, `门关不记签名(${w})`);
  }
});

test('fail-open:非法入参绝不吞合法消息', () => {
  // seenSet 非 Set → 恒真(交回调用方 msgText 守卫)。
  assert.equal(dedup.shouldRender(null, '一条消息', on({})), true, 'seenSet=null → 渲染');
  assert.equal(dedup.shouldRender(undefined, '一条消息', on({})), true, 'seenSet=undefined → 渲染');
  // msgText 空 / 非串 → 恒真(交回调用方既有 if(msgText) 守卫)。
  const seen = new Set();
  assert.equal(dedup.shouldRender(seen, '', on({})), true, '空串 → 渲染(交回调用方)');
  assert.equal(dedup.shouldRender(seen, null, on({})), true, 'null → 渲染');
  assert.equal(dedup.shouldRender(seen, 123, on({})), true, '非串 → 渲染');
});

test('signatureOf:去首尾空白后逐字节;空 / 非串 → null', () => {
  assert.equal(dedup.signatureOf('  正在调用 X  '), '正在调用 X');
  assert.equal(dedup.signatureOf('   '), null, '纯空白 → null');
  assert.equal(dedup.signatureOf(''), null);
  assert.equal(dedup.signatureOf(null), null);
  assert.equal(dedup.signatureOf(42), null, '非串 → null');
});

test('signatureOf 区分普通消息的内部空白差异', () => {
  const seen = new Set();
  assert.equal(dedup.shouldRender(seen, '普通进度 A', on({})), true);
  assert.equal(dedup.shouldRender(seen, '  普通进度 A  ', on({})), false, '仅首尾空白差异 → 同签名压制');
  assert.equal(dedup.shouldRender(seen, '普通进度  A', on({})), true, '内部空白差异 → 不同签名');
});
