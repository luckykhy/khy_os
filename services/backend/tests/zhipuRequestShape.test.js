'use strict';

'use strict';
/**
 * zhipuRequestShape.test.js — 纯叶子契约:multiFreeService.callZhipu 对齐智谱 GLM v4 调用约定。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退,两 flag 各自独立)、hasIdSecretShape、
 * resolveZhipuAuthMode(门开非 id.secret→raw / id.secret→jwt·门关恒 jwt 逐字节回退)、
 * normalizeReasoningEffort(合法枚举过滤)、pickReasoningEffort(门控 + 两种 opts 键名 + 缺失/非法)。
 */
const path = require('node:path');
const leaf = require(path.join(__dirname, '../src/services/zhipuRequestShape'));

describe('Zhipu Request Shape', () => {
  test('zhipuRawBearerEnabled: default ON; CANON off-words disable', () => {
      expect(leaf.zhipuRawBearerEnabled({})).toBe(true);
      for (const off of ['0', 'false', 'off', 'no']) {
        expect(leaf.zhipuRawBearerEnabled({ KHY_ZHIPU_RAW_BEARER: off })).toBe(false, `off=${off}`);
      }
      expect(leaf.zhipuRawBearerEnabled({ KHY_ZHIPU_RAW_BEARER: 'disable' })).toBe(true); // 非 CANON → 开
  });

  test('zhipuReasoningEffortEnabled: default ON; CANON off-words disable; independent flag', () => {
      expect(leaf.zhipuReasoningEffortEnabled({})).toBe(true);
      for (const off of ['0', 'false', 'off', 'no']) {
        expect(leaf.zhipuReasoningEffortEnabled({ KHY_ZHIPU_REASONING_EFFORT: off })).toBe(false, `off=${off}`);
      }
      // 两 flag 互不影响:关 raw-bearer 不影响 reasoning-effort
      expect(leaf.zhipuReasoningEffortEnabled({ KHY_ZHIPU_RAW_BEARER: '0' })).toBe(true);
  });

  test('hasIdSecretShape: two non-empty dot segments only', () => {
      expect(leaf.hasIdSecretShape('id.secret')).toBe(true);
      expect(leaf.hasIdSecretShape('abc123.def456')).toBe(true);
      expect(leaf.hasIdSecretShape('singletoken')).toBe(false);
      expect(leaf.hasIdSecretShape('.secret')).toBe(false);
      expect(leaf.hasIdSecretShape('id.')).toBe(false);
      expect(leaf.hasIdSecretShape('a.b.c')).toBe(false); // 三段非 id.secret
      expect(leaf.hasIdSecretShape('')).toBe(false);
      expect(leaf.hasIdSecretShape(null)).toBe(false);
      expect(leaf.hasIdSecretShape(42)).toBe(false);
  });

  test('resolveZhipuAuthMode: gate ON → non-id.secret raw, id.secret jwt', () => {
      expect(leaf.resolveZhipuAuthMode('newkeytoken', {})).toBe('raw');
      expect(leaf.resolveZhipuAuthMode('id.secret', {})).toBe('jwt');
  });

  test('resolveZhipuAuthMode: gate OFF → always jwt (byte-revert)', () => {
      const OFF = { KHY_ZHIPU_RAW_BEARER: '0' };
      expect(leaf.resolveZhipuAuthMode('newkeytoken', OFF)).toBe('jwt');
      expect(leaf.resolveZhipuAuthMode('id.secret', OFF)).toBe('jwt');
  });

  test('isOfficialZhipuV4Endpoint: host + /api/paas/v4 only', () => {
      expect(leaf.isOfficialZhipuV4Endpoint('https://open.bigmodel.cn/api/paas/v4')).toBe(true);
      expect(leaf.isOfficialZhipuV4Endpoint('https://open.bigmodel.cn/api/paas/v4/chat/completions')).toBe(true);
      expect(leaf.isOfficialZhipuV4Endpoint('HTTPS://OPEN.BIGMODEL.CN/API/PAAS/V4/')).toBe(true); // 大小写不敏感
      expect(leaf.isOfficialZhipuV4Endpoint('https://my-relay.example.com/v1')).toBe(false); // 中转端点
      expect(leaf.isOfficialZhipuV4Endpoint('https://open.bigmodel.cn/api/paas/v3')).toBe(false); // legacy v3
      expect(leaf.isOfficialZhipuV4Endpoint('')).toBe(false);
      expect(leaf.isOfficialZhipuV4Endpoint(null)).toBe(false);
  });

  test('zhipuV4RawBearerEnabled: default ON; CANON off-words disable', () => {
      expect(leaf.zhipuV4RawBearerEnabled({})).toBe(true);
      for (const off of ['0', 'false', 'off', 'no']) {
        expect(leaf.zhipuV4RawBearerEnabled({ KHY_ZHIPU_V4_RAW_BEARER: off })).toBe(false, `off=${off}`);
      }
  });

  test('resolveZhipuAuthMode: id.secret on official v4 endpoint → raw (the vision-404 fix)', () => {
      const V4 = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
      // 核心修复:id.secret 形态 key 在官方 v4 端点上改走 raw Bearer,与 test-key 一致 → 救回视觉模型
      expect(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', {}, V4)).toBe('raw');
      // 非 v4(中转/自定义)端点仍走 jwt(严格超集,不动今日靠 JWT 工作的端点)
      expect(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', {}, 'https://relay.example.com/v1/chat/completions')).toBe('jwt');
      // 缺省 endpoint → 不视为 v4 → jwt(向后兼容既有两参调用)
      expect(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', {})).toBe('jwt');
      // 子门关 → v4 端点也回退 jwt(逐字节回退)
      expect(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', { KHY_ZHIPU_V4_RAW_BEARER: '0' }, V4)).toBe('jwt');
      // 主门关 → 恒 jwt(即便子门开、v4 端点)
      expect(leaf.resolveZhipuAuthMode('1aecbd.n9fnhFs1', { KHY_ZHIPU_RAW_BEARER: '0' }, V4)).toBe('jwt');
      // 非 id.secret 形态在 v4 上仍 raw(不受影响)
      expect(leaf.resolveZhipuAuthMode('newkeytoken', {}, V4)).toBe('raw');
  });

  test('normalizeReasoningEffort: valid enum passthrough, else null', () => {
      for (const v of ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']) {
        expect(leaf.normalizeReasoningEffort(v)).toBe(v);
      }
      expect(leaf.normalizeReasoningEffort('HIGH')).toBe('high'); // 大小写归一
      expect(leaf.normalizeReasoningEffort('  low  ')).toBe('low'); // trim
      expect(leaf.normalizeReasoningEffort('turbo')).toBe(null); // 非法
      expect(leaf.normalizeReasoningEffort('')).toBe(null);
      expect(leaf.normalizeReasoningEffort(null)).toBe(null);
      expect(leaf.normalizeReasoningEffort(undefined)).toBe(null);
  });

  test('pickReasoningEffort: gate ON reads reasoningEffort / reasoning_effort keys', () => {
      expect(leaf.pickReasoningEffort({ reasoningEffort: 'high' }, {})).toBe('high');
      expect(leaf.pickReasoningEffort({ reasoning_effort: 'max' }, {})).toBe('max');
      // camelCase 优先于 snake_case
      expect(leaf.pickReasoningEffort({ reasoningEffort: 'low', reasoning_effort: 'max' }, {})).toBe('low');
      // 缺失 / 非法 → null(不污染请求体)
      expect(leaf.pickReasoningEffort({}, {})).toBe(null);
      expect(leaf.pickReasoningEffort({ reasoningEffort: 'bogus' }, {})).toBe(null);
  });

  test('pickReasoningEffort: gate OFF → null (byte-revert, field not written)', () => {
      const OFF = { KHY_ZHIPU_REASONING_EFFORT: '0' };
      expect(leaf.pickReasoningEffort({ reasoningEffort: 'high' }, OFF)).toBe(null);
      expect(leaf.pickReasoningEffort({ reasoning_effort: 'max' }, OFF)).toBe(null);
  });

  test('fail-soft: never throws on bad input', () => {
      // gate default-on + non-id.secret(undefined)→ raw;不抛即达标
      expect(leaf.resolveZhipuAuthMode(undefined, undefined)).toBe('raw');
      // 门关时 undefined key 仍逐字节回退 jwt
      expect(leaf.resolveZhipuAuthMode(undefined, { KHY_ZHIPU_RAW_BEARER: '0' })).toBe('jwt');
      expect(leaf.pickReasoningEffort(undefined, undefined)).toBe(null);
      expect(leaf.normalizeReasoningEffort({})).toBe(null);
  });

});
