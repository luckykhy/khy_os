'use strict';

/**
 * modelNotFoundRecovery.test.js — model_not_found(404)硬失败的可执行恢复指引(纯叶子)。
 *
 * 用户实测复现(/goal「驱动 khyos 解决这个错误」):auto::api、模型串
 * `api:agnes:agnes-2.0-flash`(自定义 provider,strict:true 路由 → userPinned)→ 上游返回
 * `- api [model_not_found]: Request failed with status code 404`。strict 硬失败路径把裸 404
 * 吐给用户,而 buildPreferredAdapterRecoveryHint 无 model_not_found 分支 → 只落最弱通用提示。
 * 本套件锁死叶子契约:
 *   - isModelNotFound:errorType==='model_not_found' 或消息文本命中 → true;瞬时/auth/垃圾 → false;
 *   - buildModelNotFoundRecoveryLines:命中 → 返回两行编号指引(含端点名、model_not_found、非临时故障、khy gateway model);
 *   - 门控 KHY_MODEL_NOT_FOUND_RECOVERY 默认开,off 值(0/false/off/no)→ 关(返回 null,逐字节回退);
 *   - 绝不抛。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isEnabled,
  isModelNotFound,
  classifyModelNameShape,
  buildModelNotFoundRecoveryLines,
  describeModelNotFoundRecovery,
} = require('../../../src/services/gateway/modelNotFoundRecovery');

test('gate default-on; CANON off values close it (byte-revert)', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_MODEL_NOT_FOUND_RECOVERY: '1' }), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(isEnabled({ KHY_MODEL_NOT_FOUND_RECOVERY: v }), false, v);
  }
});

test('isModelNotFound: errorType==="model_not_found" → true (the reliable signal)', () => {
  // 裸 `Request failed with status code 404` 消息不含类型词,靠 gateway 透传的 errorType 识别。
  assert.strictEqual(isModelNotFound('model_not_found', 'Request failed with status code 404'), true);
  assert.strictEqual(isModelNotFound('MODEL_NOT_FOUND', 'anything'), true);
});

test('isModelNotFound: message text signals → true', () => {
  for (const m of [
    'OpenAI: model_not_found',
    'no such model: agnes-2.0-flash',
    'the model `agnes-2.0-flash` does not exist',
    'model is unknown on this endpoint',
    'model unavailable',
  ]) {
    assert.strictEqual(isModelNotFound(undefined, m), true, m);
  }
});

test('isModelNotFound: transient / auth / junk → false (no false positives)', () => {
  assert.strictEqual(isModelNotFound('timeout', 'Request timed out'), false);
  assert.strictEqual(isModelNotFound('auth', 'unauthorized: invalid api key'), false);
  assert.strictEqual(isModelNotFound('network', 'ECONNRESET'), false);
  assert.strictEqual(isModelNotFound(undefined, 'Request failed with status code 404'), false); // 无类型词、无 errorType
  assert.strictEqual(isModelNotFound(undefined, ''), false);
});

test('isModelNotFound: never throws on odd inputs', () => {
  assert.doesNotThrow(() => isModelNotFound(null, null));
  assert.doesNotThrow(() => isModelNotFound({}, []));
  assert.strictEqual(isModelNotFound(42, {}), false);
});

test('buildModelNotFoundRecoveryLines: hit → actionable two-line hint', () => {
  const lines = buildModelNotFoundRecoveryLines({
    adapterDisplay: 'API',
    errorType: 'model_not_found',
    message: 'Request failed with status code 404',
    env: {},
  });
  assert.ok(Array.isArray(lines));
  assert.strictEqual(lines.length, 3);
  const joined = lines.join('\n');
  assert.match(joined, /model_not_found/);
  assert.match(joined, /API/);              // 端点显示名注入
  assert.match(joined, /khy gateway model/); // 确定性下一步
  assert.match(joined, /把新 key 直接发我/); // 第 5 行:配 key 邀请
  assert.match(lines[0], /^ {2}3\)/);        // 编号承接通用提示的 1)/2)
  assert.match(lines[1], /^ {2}4\)/);
  assert.match(lines[2], /^ {2}5\)/);        // 新增:缺 key/key 失效 → 发我写入更新
});

test('buildModelNotFoundRecoveryLines: missing adapterDisplay → safe fallback label', () => {
  const lines = buildModelNotFoundRecoveryLines({ errorType: 'model_not_found', message: '404', env: {} });
  assert.ok(Array.isArray(lines) && lines.length === 3);
  assert.match(lines[0], /「该」端点/);
});

test('buildModelNotFoundRecoveryLines: explicit model → names the exact model in both lines', () => {
  const lines = buildModelNotFoundRecoveryLines({
    adapterDisplay: 'API',
    errorType: 'model_not_found',
    message: 'Request failed with status code 404', // 裸 404 不含模型名 → 靠 explicit model 点名
    model: 'api:agnes:agnes-2.0-flash',
    env: {},
  });
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], /模型「api:agnes:agnes-2\.0-flash」/); // line 3 点名到底哪个模型找不到
  assert.match(lines[1], /替换「api:agnes:agnes-2\.0-flash」/); // line 4 解决方案引用该模型
  assert.match(lines[0], /model_not_found/);
  assert.match(lines[1], /khy gateway model/);
  assert.match(lines[2], /把新 key 直接发我/);                  // line 5 缺 key/key 失效 → 发我更新
});

test('buildModelNotFoundRecoveryLines: no explicit model → extract name from upstream message', () => {
  const lines = buildModelNotFoundRecoveryLines({
    adapterDisplay: 'API',
    errorType: undefined,
    message: 'The model `gpt-foo-9` does not exist or you do not have access to it.',
    env: {},
  });
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], /模型「gpt-foo-9」/);
  assert.match(lines[1], /替换「gpt-foo-9」/);
});

test('buildModelNotFoundRecoveryLines: no model name anywhere → generic byte-compatible lines', () => {
  const lines = buildModelNotFoundRecoveryLines({
    adapterDisplay: 'API',
    errorType: 'model_not_found',
    message: 'Request failed with status code 404',
    env: {},
  });
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], /该模型在「API」端点/); // 无名字 → 通用文案(不含具体模型名)
  assert.doesNotMatch(lines[0], /模型「/);
  assert.match(lines[2], /把新 key 直接发我/);   // 通用分支同样带配 key 邀请
});

test('buildModelNotFoundRecoveryLines: hasImage → vision-specific recovery (config GLM vision key / switch model)', () => {
  const lines = buildModelNotFoundRecoveryLines({
    adapterDisplay: 'API',
    errorType: 'model_not_found',
    message: 'recent model_not_found failure cached: Request failed with status code 404 (cooldown 30s)',
    hasImage: true,
    env: {},
  });
  assert.ok(Array.isArray(lines) && lines.length === 2);
  const joined = lines.join('\n');
  assert.match(joined, /包含图片/);        // 点明这是图片请求
  assert.match(joined, /视觉/);            // 视觉能力
  assert.match(joined, /GLM 视觉 key/);    // 视觉专属下一步
  assert.match(joined, /khy gateway model/);
  assert.match(lines[0], /^ {2}3\)/);
  assert.match(lines[1], /^ {2}4\)/);
});

test('buildModelNotFoundRecoveryLines: hasImage with explicit model → names it in the vision line', () => {
  const lines = buildModelNotFoundRecoveryLines({
    adapterDisplay: 'API',
    errorType: 'model_not_found',
    message: 'Request failed with status code 404',
    model: 'api:agnes:agnes-2.0-flash',
    hasImage: true,
    env: {},
  });
  assert.match(lines[0], /模型「api:agnes:agnes-2\.0-flash」/);
  assert.match(lines[0], /包含图片/);
});

test('buildModelNotFoundRecoveryLines: hasImage !== true → byte-identical to non-image path', () => {
  const base = {
    adapterDisplay: 'API', errorType: 'model_not_found',
    message: 'Request failed with status code 404', env: {},
  };
  const noFlag = buildModelNotFoundRecoveryLines(base);
  assert.deepStrictEqual(buildModelNotFoundRecoveryLines({ ...base, hasImage: false }), noFlag);
  assert.deepStrictEqual(buildModelNotFoundRecoveryLines({ ...base, hasImage: undefined }), noFlag);
  assert.deepStrictEqual(buildModelNotFoundRecoveryLines({ ...base, hasImage: 'yes' }), noFlag); // 仅严格 true 触发
});

test('buildModelNotFoundRecoveryLines: hasImage but gate off → null (byte-revert)', () => {
  assert.strictEqual(
    buildModelNotFoundRecoveryLines({
      adapterDisplay: 'API', errorType: 'model_not_found', message: '404',
      hasImage: true, env: { KHY_MODEL_NOT_FOUND_RECOVERY: 'off' },
    }),
    null
  );
});

test('buildModelNotFoundRecoveryLines: gate off → null (byte-revert)', () => {
  const off = buildModelNotFoundRecoveryLines({
    adapterDisplay: 'API',
    errorType: 'model_not_found',
    message: '404',
    env: { KHY_MODEL_NOT_FOUND_RECOVERY: 'off' },
  });
  assert.strictEqual(off, null);
});
test('buildModelNotFoundRecoveryLines: not model_not_found → null (leaves other branches intact)', () => {
  assert.strictEqual(
    buildModelNotFoundRecoveryLines({ adapterDisplay: 'API', errorType: 'timeout', message: 'timed out', env: {} }),
    null
  );
  assert.strictEqual(buildModelNotFoundRecoveryLines({ env: {} }), null);
});

test('buildModelNotFoundRecoveryLines: never throws on odd inputs', () => {
  assert.doesNotThrow(() => buildModelNotFoundRecoveryLines());
  assert.doesNotThrow(() => buildModelNotFoundRecoveryLines(null));
  assert.strictEqual(buildModelNotFoundRecoveryLines(null), null);
});

test('describeModelNotFoundRecovery: self-describing metadata', () => {
  const d = describeModelNotFoundRecovery();
  assert.strictEqual(d.gate, 'KHY_MODEL_NOT_FOUND_RECOVERY');
  assert.strictEqual(d.defaultOn, true);
  assert.match(d.summary, /model_not_found/i);
});

// ── classifyModelNameShape(送出模型串形状:送错字符串 vs 模型确实不存在)──────────

test('classifyModelNameShape: 三段式路由 id → composite', () => {
  assert.strictEqual(classifyModelNameShape('api:glm:glm-4.6v-flash'), 'composite');
  assert.strictEqual(classifyModelNameShape('api:agnes:agnes-2.0-flash'), 'composite');
  assert.strictEqual(classifyModelNameShape('api/glm/glm-4.7-flash'), 'composite'); // 斜杠变体
});

test('classifyModelNameShape: 单段前缀 → prefixed', () => {
  assert.strictEqual(classifyModelNameShape('glm:glm-4.7-flash'), 'prefixed');
  assert.strictEqual(classifyModelNameShape('openai/gpt-4'), 'prefixed');
});

test('classifyModelNameShape: 裸模型名 → bare', () => {
  assert.strictEqual(classifyModelNameShape('glm-4.6v-flash'), 'bare');
  assert.strictEqual(classifyModelNameShape('gpt-foo-9'), 'bare');
  assert.strictEqual(classifyModelNameShape('cogview-3-flash'), 'bare');
});

test('classifyModelNameShape: 空 / 坏输入 → empty,绝不抛', () => {
  assert.strictEqual(classifyModelNameShape(''), 'empty');
  assert.strictEqual(classifyModelNameShape('   '), 'empty');
  assert.strictEqual(classifyModelNameShape(null), 'empty');
  assert.strictEqual(classifyModelNameShape(undefined), 'empty');
  assert.doesNotThrow(() => classifyModelNameShape({}));
});

test('buildModelNotFoundRecoveryLines: composite 三段式 id → 点名行追加「送错字符串」诊断', () => {
  const lines = buildModelNotFoundRecoveryLines({
    adapterDisplay: 'API',
    errorType: 'model_not_found',
    message: 'Request failed with status code 404',
    model: 'api:glm:glm-4.6v-flash',
    env: {},
  });
  assert.match(lines[0], /模型「api:glm:glm-4\.6v-flash」/);
  assert.match(lines[0], /三段式路由 id/); // 新形状诊断:送错字符串
  assert.match(lines[0], /model_not_found/);  // 原有断言仍成立
});

test('buildModelNotFoundRecoveryLines: bare 裸名 → 点名行不追加形状诊断(维持既有文案)', () => {
  const lines = buildModelNotFoundRecoveryLines({
    adapterDisplay: 'API',
    errorType: 'model_not_found',
    message: 'Request failed with status code 404',
    model: 'glm-4.6v-flash',
    env: {},
  });
  assert.match(lines[0], /模型「glm-4\.6v-flash」/);
  assert.doesNotMatch(lines[0], /三段式路由 id/);
  assert.doesNotMatch(lines[0], /带前缀/);
});

