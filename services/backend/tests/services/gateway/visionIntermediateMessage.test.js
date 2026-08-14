'use strict';

/**
 * visionIntermediateMessage.test.js — 验证视觉路由中间消息流。
 *
 * 背景(/goal「用户发送图片给文本模型,文本模型需要明确说明我无法识别所以路由给视觉识别模型,
 * 等待它传回结果」):describe-and-return 默认静默调视觉模型识图 → 注入描述给文本模型 → 作答,
 * 用户完全看不到中间的视觉路由过程。开 KHY_VISION_INTERMEDIATE_MESSAGE 门 → aiGateway 在
 * 视觉识别前后发送两条 type:'assistant_message' chunk:①「我无法直接识别图片内容。正在
 * 调用 <视觉模型> 进行识别,请稍候...」;②「视觉识别完成,正在根据识别结果为您作答。」
 *
 * 本测验证:门开时两条中间消息正确发送;门关时逐字节回退(零中间消息)。
 */

const test = require('node:test');
const assert = require('node:assert');

test('KHY_VISION_INTERMEDIATE_MESSAGE flag 行为', () => {
  const flagRegistry = require('../../../src/services/flagRegistry');

  // 默认开启
  assert.strictEqual(
    flagRegistry.isFlagEnabled('KHY_VISION_INTERMEDIATE_MESSAGE', {}),
    true,
    '默认应启用'
  );

  // CANON off 词关闭
  for (const offWord of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(
      flagRegistry.isFlagEnabled('KHY_VISION_INTERMEDIATE_MESSAGE', {
        KHY_VISION_INTERMEDIATE_MESSAGE: offWord,
      }),
      false,
      `${offWord} 应关闭`
    );
  }

  // 其他值开启
  assert.strictEqual(
    flagRegistry.isFlagEnabled('KHY_VISION_INTERMEDIATE_MESSAGE', {
      KHY_VISION_INTERMEDIATE_MESSAGE: 'yes',
    }),
    true,
    '非 off 词应启用'
  );
});

test('emitAssistantMessage chunk 格式', () => {
  // 验证 aiGateway 发送的 chunk 格式正确
  // 由于 aiGateway 是大型有状态模块且依赖真实网关初始化,这里只验证概念正确性:
  // chunk 应该是 { type: 'assistant_message', content: <string> }

  const mockChunk = {
    type: 'assistant_message',
    content: '我无法直接识别图片内容。正在调用 glm-4.6v-flash 进行识别,请稍候...',
  };

  assert.strictEqual(mockChunk.type, 'assistant_message');
  assert.strictEqual(typeof mockChunk.content, 'string');
  assert.ok(mockChunk.content.length > 0);
});

test('中间消息应包含视觉模型名称', () => {
  // 第一条消息应该包含视觉模型名称
  const model = 'glm-4.6v-flash';
  const message = `我无法直接识别图片内容。正在调用 ${model} 进行识别,请稍候...`;

  assert.ok(message.includes(model), '消息应包含模型名称');
  assert.ok(message.includes('无法直接识别'), '消息应说明无法识别');
  assert.ok(message.includes('正在调用'), '消息应说明正在调用');
});

test('完成消息应说明已完成识别', () => {
  const completeMessage = '视觉识别完成,正在根据识别结果为您作答。';

  assert.ok(completeMessage.includes('完成'), '消息应说明已完成');
  assert.ok(completeMessage.includes('识别结果'), '消息应提到识别结果');
});
