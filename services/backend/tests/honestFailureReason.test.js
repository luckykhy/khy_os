'use strict';

/**
 * honestFailureReason — 诚实失败原因单元测试。
 *
 * 验证用户原诉求:「出错原因要具体真实,不要用网络不好之类的理由掩盖真相」。
 *  - 有真因 → 以真因为主体(类别前缀 + 具体原因);门控关 → 逐字节回退到 legacyFriendly。
 *  - 无真因 → 诚实回退到 legacyFriendly,绝不编造。
 *  - 脱敏:剥离 token/凭证,但保留 ECONNREFUSED / HTTP 5xx / host:port 等可操作真因。
 *  - extractToolFailureReason:从 toolCallLog 条目挖出 result.data.outputTail,
 *    不再塌缩成「未知错误」;无文字真因但有非零退出码也比「未知」具体。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveFriendlyFailureMessage,
  extractToolFailureReason,
  buildKeyConfigInvite,
  sanitizeCause,
  isHonestFailureEnabled,
} = require('../src/services/honestFailureReason');

const ON = { env: { KHY_HONEST_FAILURE: '1' } };
const OFF = { env: { KHY_HONEST_FAILURE: 'off' } };

describe('resolveFriendlyFailureMessage — 真因优先,门控可回退', () => {
  test('门控开 + 有真因 → 类别前缀 + 具体真因(不再是「网络不好」)', () => {
    const s = resolveFriendlyFailureMessage({
      errorType: 'network',
      cause: 'connect ECONNREFUSED 127.0.0.1:7890',
      legacyFriendly: '抱歉，网络连接出现问题，无法完成请求。请检查网络连接后重试。',
      options: ON,
    });
    assert.ok(s.includes('ECONNREFUSED'), `应给出具体真因: ${s}`);
    assert.ok(s.includes('7890'), s);
    assert.ok(!s.includes('网络连接出现问题'), `不再用笼统借口: ${s}`);
  });

  test('门控关 → 逐字节回退到 legacyFriendly', () => {
    const legacy = '抱歉，网络连接出现问题，无法完成请求。请检查网络连接后重试。';
    const s = resolveFriendlyFailureMessage({ errorType: 'network', cause: 'ECONNREFUSED', legacyFriendly: legacy, options: OFF });
    assert.equal(s, legacy);
  });

  test('门控开但无真因 → 诚实回退到 legacyFriendly,绝不编造', () => {
    const legacy = '抱歉，遇到了未预期的问题（unknown），我暂时无法处理这个请求。';
    const s = resolveFriendlyFailureMessage({ errorType: 'unknown', cause: '', legacyFriendly: legacy, options: ON });
    assert.equal(s, legacy);
  });

  test('真因已含类别语义 → 不重复前缀', () => {
    const s = resolveFriendlyFailureMessage({
      errorType: 'network',
      cause: '网络请求未能完成：上游 502 Bad Gateway',
      legacyFriendly: 'x',
      options: ON,
    });
    const count = (s.match(/网络请求未能完成/g) || []).length;
    assert.equal(count, 1, `前缀不重复: ${s}`);
  });

  test('绝不抛:异常输入回退', () => {
    assert.doesNotThrow(() => resolveFriendlyFailureMessage());
  });
});

describe('sanitizeCause — 诚实但不泄密', () => {
  test('剥离 bearer token,保留错误类', () => {
    const s = sanitizeCause('request failed: Bearer sk-abcdef123456 ETIMEDOUT');
    assert.ok(!s.includes('sk-abcdef123456'), `token 被脱敏: ${s}`);
    assert.ok(s.includes('ETIMEDOUT'), `保留可操作真因: ${s}`);
  });

  test('剥离 url 里的 user:pass', () => {
    const s = sanitizeCause('proxy https://user:secret@proxy.local:8080 refused');
    assert.ok(!s.includes('secret'), s);
    assert.ok(s.includes('refused'), s);
  });

  test('剥离 api_key=xxx', () => {
    const s = sanitizeCause('config api_key=ABC123XYZ invalid');
    assert.ok(!s.includes('ABC123XYZ'), s);
  });

  test('限长 + 压平空白', () => {
    const s = sanitizeCause('a\n\nb   c', 220);
    assert.equal(s, 'a b c');
  });

  test('空/空白 → 空串', () => {
    assert.equal(sanitizeCause(''), '');
    assert.equal(sanitizeCause(null), '');
  });
});

describe('extractToolFailureReason — 挖真因,不塌缩成「未知错误」', () => {
  test('build_project 失败:真因在 result.data.outputTail + 退出码', () => {
    const entry = {
      tool: 'build_project',
      result: { success: false, data: { exitCode: 1, errors: [], outputTail: 'cannot find symbol: foo()' } },
    };
    const s = extractToolFailureReason(entry, ON);
    assert.ok(s.includes('cannot find symbol'), `挖出 outputTail: ${s}`);
    assert.ok(s.includes('退出码 1'), s);
  });

  test('显式 error 优先', () => {
    const s = extractToolFailureReason({ tool: 'x', error: 'EACCES permission denied' }, ON);
    assert.ok(s.includes('EACCES'), s);
  });

  test('无文字真因但有非零退出码 → 比「未知」具体', () => {
    const s = extractToolFailureReason({ tool: 'x', result: { data: { exitCode: 137, outputTail: '' } } }, ON);
    assert.ok(s.includes('137'), s);
    assert.ok(!s.includes('未知'), s);
  });

  test('门控关 → 返回空串(调用方走旧兜底)', () => {
    const s = extractToolFailureReason({ tool: 'x', error: 'real cause' }, OFF);
    assert.equal(s, '');
  });

  test('完全无信号 → 空串', () => {
    assert.equal(extractToolFailureReason({ tool: 'x', result: { success: false } }, ON), '');
  });

  test('绝不抛', () => {
    assert.doesNotThrow(() => extractToolFailureReason(null, ON));
    assert.doesNotThrow(() => extractToolFailureReason(undefined));
  });
});

describe('isHonestFailureEnabled', () => {
  test('默认(无 env)→ 开', () => {
    assert.equal(isHonestFailureEnabled({}), true);
  });
  test('显式关', () => {
    assert.equal(isHonestFailureEnabled({ KHY_HONEST_FAILURE: 'false' }), false);
    assert.equal(isHonestFailureEnabled({ KHY_HONEST_FAILURE: '0' }), false);
  });
});

describe('buildKeyConfigInvite — 缺 key/密钥失效 → 主动邀请配/换 key', () => {
  const IENV = {}; // 默认开(flagRegistry default-on)

  test('auth 类 + 认出智谱 → 点名 GLM 的换 key 邀请', () => {
    const s = buildKeyConfigInvite({
      errorType: 'auth',
      cause: '智谱AI: Request failed with status code 401 - api [auth]',
      env: IENV,
    });
    assert.ok(s.includes('智谱 GLM'), s);
    assert.ok(/API Key/.test(s), s);
    assert.ok(/发我|写入|更新/.test(s), s);
  });

  test('密钥失效/额度用尽档(auth/auth_permanent/pool_exhausted)→「失效或额度用尽…换新 key」措辞', () => {
    for (const errorType of ['auth', 'auth_permanent', 'pool_exhausted']) {
      const s = buildKeyConfigInvite({ errorType, cause: '智谱 401 invalid key', env: IENV });
      assert.ok(s.includes('智谱 GLM'), `${errorType}: ${s}`);
      assert.ok(/失效或额度用尽/.test(s), `${errorType} 应走换 key 档措辞: ${s}`);
      assert.ok(/换一个新 key/.test(s), `${errorType}: ${s}`);
    }
  });

  test('no_key 类 → 配置措辞(与换 key 档区分),认不出 provider 用泛化', () => {
    const s = buildKeyConfigInvite({ errorType: 'no_key', cause: 'no available api key', env: IENV });
    assert.ok(s.includes('该模型'), s);
    assert.ok(/API Key/.test(s), s);
    assert.ok(/配置/.test(s), s);
    assert.ok(!/失效或额度用尽/.test(s), `no_key 不应走换 key 档: ${s}`);
  });

  test('认出多家 provider 名(openai / agnes / deepseek)', () => {
    assert.ok(buildKeyConfigInvite({ errorType: 'auth', cause: 'OpenAI 401 invalid api key', env: IENV }).includes('OpenAI'));
    assert.ok(buildKeyConfigInvite({ errorType: 'auth', cause: 'agnes-ai 403 forbidden', env: IENV }).includes('Agnes'));
    assert.ok(buildKeyConfigInvite({ errorType: 'auth', cause: 'deepseek unauthorized', env: IENV }).includes('DeepSeek'));
  });

  test('瞬时故障类(network/timeout/rate_limit)→ 空串,不邀请(429 双用途难区分,一并排除)', () => {
    assert.equal(buildKeyConfigInvite({ errorType: 'network', cause: 'ECONNREFUSED', env: IENV }), '');
    assert.equal(buildKeyConfigInvite({ errorType: 'timeout', cause: 'ETIMEDOUT', env: IENV }), '');
    assert.equal(buildKeyConfigInvite({ errorType: 'rate_limit', cause: '429', env: IENV }), '');
    assert.equal(buildKeyConfigInvite({ errorType: 'model_not_found', cause: '404', env: IENV }), '');
  });

  test('门控关(KHY_FAILURE_KEY_INVITE=off)→ 空串(失败文案逐字节不变)', () => {
    const s = buildKeyConfigInvite({
      errorType: 'auth', cause: '智谱 401', env: { KHY_FAILURE_KEY_INVITE: 'off' },
    });
    assert.equal(s, '');
  });

  test('绝不抛:异常/空输入 → 空串', () => {
    assert.doesNotThrow(() => buildKeyConfigInvite());
    assert.equal(buildKeyConfigInvite({}), '');
    assert.equal(buildKeyConfigInvite({ errorType: 'auth', cause: null, env: IENV }).length > 0, true); // 认不出仍给泛化邀请
  });
});
