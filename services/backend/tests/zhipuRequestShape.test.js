'use strict';

/**
 * zhipuRequestShape.test.js — 纯叶子契约:multiFreeService.callZhipu 对齐智谱 GLM v4 调用约定。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退,两 flag 各自独立)、hasIdSecretShape、
 * resolveZhipuAuthMode(门开非 id.secret→raw / id.secret→jwt·门关恒 jwt 逐字节回退)、
 * normalizeReasoningEffort(合法枚举过滤)、pickReasoningEffort(门控 + 两种 opts 键名 + 缺失/非法)。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const leaf = require(path.join(__dirname, '../src/services/zhipuRequestShape'));

test('zhipuRawBearerEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.zhipuRawBearerEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.zhipuRawBearerEnabled({ KHY_ZHIPU_RAW_BEARER: off }), false, `off=${off}`);
  }
  assert.strictEqual(leaf.zhipuRawBearerEnabled({ KHY_ZHIPU_RAW_BEARER: 'disable' }), true); // 非 CANON → 开
});

test('zhipuReasoningEffortEnabled: default ON; CANON off-words disable; independent flag', () => {
  assert.strictEqual(leaf.zhipuReasoningEffortEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.zhipuReasoningEffortEnabled({ KHY_ZHIPU_REASONING_EFFORT: off }), false, `off=${off}`);
  }
  // 两 flag 互不影响:关 raw-bearer 不影响 reasoning-effort
  assert.strictEqual(leaf.zhipuReasoningEffortEnabled({ KHY_ZHIPU_RAW_BEARER: '0' }), true);
});

test('hasIdSecretShape: two non-empty dot segments only', () => {
  assert.strictEqual(leaf.hasIdSecretShape('id.secret'), true);
  assert.strictEqual(leaf.hasIdSecretShape('abc123.def456'), true);
  assert.strictEqual(leaf.hasIdSecretShape('singletoken'), false);
  assert.strictEqual(leaf.hasIdSecretShape('.secret'), false);
  assert.strictEqual(leaf.hasIdSecretShape('id.'), false);
  assert.strictEqual(leaf.hasIdSecretShape('a.b.c'), false); // 三段非 id.secret
  assert.strictEqual(leaf.hasIdSecretShape(''), false);
  assert.strictEqual(leaf.hasIdSecretShape(null), false);
  assert.strictEqual(leaf.hasIdSecretShape(42), false);
});

test('resolveZhipuAuthMode: gate ON → non-id.secret raw, id.secret jwt', () => {
  assert.strictEqual(leaf.resolveZhipuAuthMode('newkeytoken', {}), 'raw');
  assert.strictEqual(leaf.resolveZhipuAuthMode('id.secret', {}), 'jwt');
});

test('resolveZhipuAuthMode: gate OFF → always jwt (byte-revert)', () => {
  const OFF = { KHY_ZHIPU_RAW_BEARER: '0' };
  assert.strictEqual(leaf.resolveZhipuAuthMode('newkeytoken', OFF), 'jwt');
  assert.strictEqual(leaf.resolveZhipuAuthMode('id.secret', OFF), 'jwt');
});

test('isOfficialZhipuV4Endpoint: host + /api/paas/v4 only', () => {
  assert.strictEqual(leaf.isOfficialZhipuV4Endpoint('https://open.bigmodel.cn/api/paas/v4'), true);
  assert.strictEqual(leaf.isOfficialZhipuV4Endpoint('https://open.bigmodel.cn/api/paas/v4/chat/completions'), true);
  assert.strictEqual(leaf.isOfficialZhipuV4Endpoint('HTTPS://OPEN.BIGMODEL.CN/API/PAAS/V4/'), true); // 大小写不敏感
  assert.strictEqual(leaf.isOfficialZhipuV4Endpoint('https://my-relay.example.com/v1'), false); // 中转端点
  assert.strictEqual(leaf.isOfficialZhipuV4Endpoint('https://open.bigmodel.cn/api/paas/v3'), false); // legacy v3
  assert.strictEqual(leaf.isOfficialZhipuV4Endpoint(''), false);
  assert.strictEqual(leaf.isOfficialZhipuV4Endpoint(null), false);
});

test('zhipuV4RawBearerEnabled: default ON; CANON off-words disable', () => {
  assert.strictEqual(leaf.zhipuV4RawBearerEnabled({}), true);
  for (const off of ['0', 'false', 'off', 'no']) {
    assert.strictEqual(leaf.zhipuV4RawBearerEnabled({ KHY_ZHIPU_V4_RAW_BEARER: off }), false, `off=${off}`);
  }
});

test('resolveZhipuAuthMode: id.secret on official v4 endpoint → raw (the vision-404 fix)', () => {
  const V4 = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  // 核心修复:id.secret 形态 key 在官方 v4 端点上改走 raw Bearer,与 test-key 一致 → 救回视觉模型
  assert.strictEqual(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', {}, V4), 'raw');
  // 非 v4(中转/自定义)端点仍走 jwt(严格超集,不动今日靠 JWT 工作的端点)
  assert.strictEqual(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', {}, 'https://relay.example.com/v1/chat/completions'), 'jwt');
  // 缺省 endpoint → 不视为 v4 → jwt(向后兼容既有两参调用)
  assert.strictEqual(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', {}), 'jwt');
  // 子门关 → v4 端点也回退 jwt(逐字节回退)
  assert.strictEqual(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', { KHY_ZHIPU_V4_RAW_BEARER: '0' }, V4), 'jwt');
  // 主门关 → 恒 jwt(即便子门开、v4 端点)
  assert.strictEqual(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', { KHY_ZHIPU_RAW_BEARER: '0' }, V4), 'jwt');
  // 非 id.secret 形态在 v4 上仍 raw(不受影响)
  assert.strictEqual(leaf.resolveZhipuAuthMode('newkeytoken', {}, V4), 'raw');
});

test('normalizeReasoningEffort: valid enum passthrough, else null', () => {
  for (const v of ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']) {
    assert.strictEqual(leaf.normalizeReasoningEffort(v), v);
  }
  assert.strictEqual(leaf.normalizeReasoningEffort('HIGH'), 'high'); // 大小写归一
  assert.strictEqual(leaf.normalizeReasoningEffort('  low  '), 'low'); // trim
  assert.strictEqual(leaf.normalizeReasoningEffort('turbo'), null); // 非法
  assert.strictEqual(leaf.normalizeReasoningEffort(''), null);
  assert.strictEqual(leaf.normalizeReasoningEffort(null), null);
  assert.strictEqual(leaf.normalizeReasoningEffort(undefined), null);
});

test('pickReasoningEffort: gate ON reads reasoningEffort / reasoning_effort keys', () => {
  assert.strictEqual(leaf.pickReasoningEffort({ reasoningEffort: 'high' }, {}), 'high');
  assert.strictEqual(leaf.pickReasoningEffort({ reasoning_effort: 'max' }, {}), 'max');
  // camelCase 优先于 snake_case
  assert.strictEqual(leaf.pickReasoningEffort({ reasoningEffort: 'low', reasoning_effort: 'max' }, {}), 'low');
  // 缺失 / 非法 → null(不污染请求体)
  assert.strictEqual(leaf.pickReasoningEffort({}, {}), null);
  assert.strictEqual(leaf.pickReasoningEffort({ reasoningEffort: 'bogus' }, {}), null);
});

test('pickReasoningEffort: gate OFF → null (byte-revert, field not written)', () => {
  const OFF = { KHY_ZHIPU_REASONING_EFFORT: '0' };
  assert.strictEqual(leaf.pickReasoningEffort({ reasoningEffort: 'high' }, OFF), null);
  assert.strictEqual(leaf.pickReasoningEffort({ reasoning_effort: 'max' }, OFF), null);
});

test('fail-soft: never throws on bad input', () => {
  // gate default-on + non-id.secret(undefined)→ raw;不抛即达标
  assert.strictEqual(leaf.resolveZhipuAuthMode(undefined, undefined), 'raw');
  // 门关时 undefined key 仍逐字节回退 jwt
  assert.strictEqual(leaf.resolveZhipuAuthMode(undefined, { KHY_ZHIPU_RAW_BEARER: '0' }), 'jwt');
  assert.strictEqual(leaf.pickReasoningEffort(undefined, undefined), null);
  assert.strictEqual(leaf.normalizeReasoningEffort({}), null);
});
