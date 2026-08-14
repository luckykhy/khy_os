'use strict';

/**
 * Test for _errorClassifiers.classifyAdapterError — GLM/智谱 code 1211「模型不存在」正名。
 *
 * 缺口:智谱把「模型不存在/账号未领取该免费模型」以 HTTP 400 + code 1211 + 中文消息返回,
 * 而分类器的 model_not_found 只认英文串 + code 404 → 1211 漏网降级成 bad_request,导致视觉
 * 降级链 / 冷却放行 / modelNotFoundRecovery 三处失灵(文本 glm-4.7-flash 与识图 glm-4.6v-flash
 * 撞的是同一个 1211)。修复:命中「模型不存在」或 `code…1211` → 语义等价的 model_not_found。
 * 门控 KHY_GLM_CN_MODEL_NOT_FOUND 默认开,关(0/false/off/no)→ 逐字节回退旧行为(→ bad_request)。
 *
 * 纯字符串分类,确定性,无 IO。
 */
const test = require('node:test');
const assert = require('node:assert');

const { classifyAdapterError } = require('../../src/services/gateway/adapters/_errorClassifiers');

function withGate(value, fn) {
  const prev = process.env.KHY_GLM_CN_MODEL_NOT_FOUND;
  if (value === undefined) delete process.env.KHY_GLM_CN_MODEL_NOT_FOUND;
  else process.env.KHY_GLM_CN_MODEL_NOT_FOUND = value;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_GLM_CN_MODEL_NOT_FOUND;
    else process.env.KHY_GLM_CN_MODEL_NOT_FOUND = prev;
  }
}

test('中文「模型不存在」(HTTP 400) 正名为 model_not_found(默认开)', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      classifyAdapterError('模型不存在，请检查模型代码', { statusCode: 400 }),
      'model_not_found',
    );
  });
});

test('code 1211 正名为 model_not_found(默认开)', () => {
  withGate(undefined, () => {
    assert.strictEqual(
      classifyAdapterError('relay upstream error code=1211', { statusCode: 400 }),
      'model_not_found',
    );
    // 真实 relay 诊断串形态
    assert.strictEqual(
      classifyAdapterError('[relay_api] HTTP 400 model=api:glm:glm-4.7-flash | code=1211 | 模型不存在',
        { statusCode: 400 }),
      'model_not_found',
    );
  });
});

test('门控关(off/0/false)→ 逐字节回退旧行为(→ bad_request)', () => {
  for (const off of ['0', 'false', 'off', 'no']) {
    withGate(off, () => {
      assert.strictEqual(
        classifyAdapterError('模型不存在', { statusCode: 400 }),
        'bad_request',
        `gate=${off} 应回退 bad_request`,
      );
      assert.strictEqual(
        classifyAdapterError('code=1211', { statusCode: 400 }),
        'bad_request',
        `gate=${off} 应回退 bad_request`,
      );
    });
  }
});

test('不误伤:含数字 1211 但非错误码(如 token 计数)不应命中', () => {
  withGate(undefined, () => {
    // 「1211 tokens」——数字前无 code 修饰 → 不该被当 1211 错误码
    const kind = classifyAdapterError('processed 1211 tokens successfully', { statusCode: 200 });
    assert.notStrictEqual(kind, 'model_not_found');
  });
});

test('回归:无关分类不受本分支影响(1b 命中前后行为一致)', () => {
  withGate(undefined, () => {
    // 无关 400 仍是 bad_request(未命中「模型不存在」/1211)
    assert.strictEqual(
      classifyAdapterError('invalid request payload', { statusCode: 400 }),
      'bad_request',
    );
    // 401 仍是 auth
    assert.strictEqual(
      classifyAdapterError('unauthorized', { statusCode: 401 }),
      'auth',
    );
  });
});
