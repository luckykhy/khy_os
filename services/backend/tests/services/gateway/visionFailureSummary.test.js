'use strict';

/**
 * visionFailureSummary.test.js — 图像识别失败总结 + 配置邀约(纯叶子)。
 *
 * /goal「识图失败不能只说智谱失败;要一个总结,并询问是否帮忙配置 GLM 或其他合适的图像识别
 * 模型的 apikey」。本套件锁死叶子契约:
 *   - classifyVisionFailure:401/无 key/限流/超时/网络/未知 分类正确(顺序敏感:401 → auth);
 *   - buildVisionFailureMessage:含诚实总结 + 真因(脱敏) + 配置/换模型邀约,且不把失败窄化到
 *     单一 provider(始终以「图像识别失败」定性);auth/no_key 明确问「帮你配置…API Key」;
 *   - 门关(KHY_VISION_FAILURE_SUMMARY=0/false/off/no)→ buildVisionFailureMessage 返 null
 *     (调用方逐字节回退旧文案);
 *   - 脱敏剥离 bearer/api_key 但保留 401/主机;绝不抛(null/非字符串/junk)。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isVisionFailureSummaryEnabled,
  isFailureSummaryOcrSuppressEnabled,
  classifyVisionFailure,
  buildVisionFailureMessage,
  sanitizeCause,
} = require('../../../src/services/gateway/visionFailureSummary');

const ON = {}; // 默认开
const OFF = { KHY_VISION_FAILURE_SUMMARY: '0' };

test('gate default-on; off values close it (byte-revert)', () => {
  assert.strictEqual(isVisionFailureSummaryEnabled({}), true);
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(isVisionFailureSummaryEnabled({ KHY_VISION_FAILURE_SUMMARY: v }), false, v);
  }
  // 任意其它值 → 仍开
  assert.strictEqual(isVisionFailureSummaryEnabled({ KHY_VISION_FAILURE_SUMMARY: '1' }), true);
});

test('classifyVisionFailure: 401 / [auth] → auth', () => {
  assert.strictEqual(classifyVisionFailure('智谱AI: Request failed with status code 401 - api [auth]: Request failed with status code 401'), 'auth');
  assert.strictEqual(classifyVisionFailure('403 Forbidden'), 'auth');
  assert.strictEqual(classifyVisionFailure('invalid api key'), 'auth');
});

test('classifyVisionFailure: missing key → no_key (before generic network)', () => {
  assert.strictEqual(classifyVisionFailure('no available key for glm'), 'no_key');
  assert.strictEqual(classifyVisionFailure('未配置 GLM_API_KEY'), 'no_key');
  assert.strictEqual(classifyVisionFailure('无可用密钥'), 'no_key');
});

test('classifyVisionFailure: rate limit / timeout / network / unknown', () => {
  assert.strictEqual(classifyVisionFailure('429 Too Many Requests'), 'rate_limit');
  assert.strictEqual(classifyVisionFailure('请求超时 ETIMEDOUT'), 'timeout');
  assert.strictEqual(classifyVisionFailure('connect ECONNREFUSED 127.0.0.1:443'), 'network');
  assert.strictEqual(classifyVisionFailure('502 Bad Gateway'), 'network');
  assert.strictEqual(classifyVisionFailure('something weird happened'), 'unknown');
  assert.strictEqual(classifyVisionFailure(''), 'unknown');
  assert.strictEqual(classifyVisionFailure(null), 'unknown');
});

test('classifyVisionFailure: 404 / model_not_found → model_not_found (the reported bug)', () => {
  // 用户实测原文:裸模型名落到自定义 api 池 → 404 model_not_found。
  assert.strictEqual(
    classifyVisionFailure('OpenAI: Request failed with status code 404 - api [model_not_found]: Request failed with status code 404'),
    'model_not_found');
  assert.strictEqual(classifyVisionFailure('no such model: glm-4.6v-flash'), 'model_not_found');
  assert.strictEqual(classifyVisionFailure('该模型不存在'), 'model_not_found');
  // 顺序:404 不吞 401(auth 先判)/ 不吞 502(network 只认 50[234]);429 仍是限流。
  assert.strictEqual(classifyVisionFailure('401 unauthorized'), 'auth');
  assert.strictEqual(classifyVisionFailure('502 Bad Gateway'), 'network');
  assert.strictEqual(classifyVisionFailure('429 rate limit'), 'rate_limit');
});

test('classifyVisionFailure: 智谱结构化鉴权码 1000–1004 包在 404 里 → auth(非 model_not_found)', () => {
  // 根因(识图恒 404 三版未定位):智谱对**无效 key 也回 404**,callZhipu 现把上游原因体
  // (code+message)拼进 error.message。无效 key(code 1002)必须归 auth 走「粘贴真 key」邀约,
  // 不能被泛 `\b404\b` 误判成 model_not_found,把用户引向「模型未开通」的错误出路。
  assert.strictEqual(
    classifyVisionFailure('智谱AI: HTTP 404 · code 1002 · Invalid API key (Request failed with status code 404)'),
    'auth');
  assert.strictEqual(
    classifyVisionFailure('智谱AI: HTTP 401 · code 1000 · 缺少鉴权头 (Request failed with status code 401)'),
    'auth');
  // 但真正的模型不存在(code 1211)仍归 model_not_found——两类不再混为一谈。
  assert.strictEqual(
    classifyVisionFailure('智谱AI: HTTP 404 · code 1211 · 模型不存在 (Request failed with status code 404)'),
    'model_not_found');
  // 泛 404(无结构化码)保持旧行为 model_not_found,逐字节兼容。
  assert.strictEqual(classifyVisionFailure('Request failed with status code 404'), 'model_not_found');
});

test('buildVisionFailureMessage: 401 → summary + explicit key-config offer, not provider-narrowed', () => {
  const msg = buildVisionFailureMessage({
    rawError: '智谱AI: Request failed with status code 401 - api [auth]: Request failed with status code 401',
    model: 'glm-4.6v-flash',
    env: ON,
  });
  assert.ok(msg, 'message produced');
  // ① 以「图像识别失败」定性,不窄化到单一 provider
  assert.match(msg, /图像识别失败/);
  // ② 点出所用视觉模型
  assert.match(msg, /glm-4\.6v-flash/);
  // ③ 真因保留 401
  assert.match(msg, /401/);
  // ④ 明确的配置邀约(GLM 或其他 + API Key)
  assert.match(msg, /配置\s*GLM/);
  assert.match(msg, /API Key/i);
  assert.match(msg, /其他/);
  // ⑤ paste-to-replace invite present on the key-related category too
  assert.match(msg, /粘贴|发给我/);
  assert.match(msg, /立即用它替换|替换当前的 key/);
});

test('buildVisionFailureMessage: no_key → key-config offer', () => {
  const msg = buildVisionFailureMessage({ rawError: 'no available key for glm', model: 'glm-4.6v-flash', env: ON });
  assert.match(msg, /图像识别失败/);
  assert.match(msg, /API Key/i);
  assert.match(msg, /配置\s*GLM/);
});

test('buildVisionFailureMessage: network/timeout → still offers to switch/config a vision model', () => {
  const net = buildVisionFailureMessage({ rawError: 'connect ECONNREFUSED', model: 'glm-4.6v-flash', env: ON });
  assert.match(net, /图像识别失败/);
  assert.match(net, /图像识别模型/);
  assert.match(net, /API Key/i);
});

test('buildVisionFailureMessage: 404 model_not_found → names BOTH causes (wrong/placeholder key OR unsubscribed) + paste-to-replace invite', () => {
  const msg = buildVisionFailureMessage({
    rawError: 'OpenAI: Request failed with status code 404 - api [model_not_found]: Request failed with status code 404',
    model: 'glm-4.6v-flash',
    env: ON,
  });
  assert.ok(msg, 'message produced');
  assert.match(msg, /图像识别失败/);
  assert.match(msg, /未找到|model_not_found/);        // headline (neutral: not "model absent")
  assert.match(msg, /404/);                            // real cause preserved
  assert.match(msg, /GLM/);                            // offers the GLM route/key
  assert.match(msg, /provider|渠道|端点/);             // still mentions endpoint option
  // NEW: honest about the two real causes — key wrong/placeholder OR account not subscribed.
  assert.match(msg, /占位 key|无效的 API Key/);        // wrong/placeholder key cause
  assert.match(msg, /未开通/);                          // account-not-subscribed cause
  // NEW: paste-to-replace invite — user pastes the real key, khy replaces it immediately.
  assert.match(msg, /粘贴|发给我/);
  assert.match(msg, /立即用它替换|替换当前的 key/);
});

test('buildVisionFailureMessage: gate OFF → null (caller byte-reverts to legacy)', () => {
  assert.strictEqual(buildVisionFailureMessage({ rawError: '401', model: 'x', env: OFF }), null);
});

test('buildVisionFailureMessage: never throws on junk', () => {
  assert.doesNotThrow(() => buildVisionFailureMessage({ env: ON }));
  assert.doesNotThrow(() => buildVisionFailureMessage({ rawError: {}, model: 42, env: ON }));
  assert.doesNotThrow(() => buildVisionFailureMessage());
});

test('sanitizeCause: strips bearer/api_key, keeps status code + host', () => {
  const s = sanitizeCause('Bearer sk-abcdef123456 failed 401 at open.bigmodel.cn');
  assert.ok(!/sk-abcdef123456/.test(s), 'secret stripped');
  assert.match(s, /401/);
  assert.match(s, /open\.bigmodel\.cn/);
});

// ── OPS-MAN-142:失败墙推迟到 OCR 结果已知后(OCR suppress 子门) ────────────────────
test('isFailureSummaryOcrSuppressEnabled: default-on', () => {
  assert.strictEqual(isFailureSummaryOcrSuppressEnabled({}), true);
  assert.strictEqual(isFailureSummaryOcrSuppressEnabled(undefined), true);
});

test('isFailureSummaryOcrSuppressEnabled: off words close it (byte-revert to OCR-前发墙)', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
    assert.strictEqual(
      isFailureSummaryOcrSuppressEnabled({ KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS: v }),
      false,
      `off word ${v}`,
    );
  }
});

test('isFailureSummaryOcrSuppressEnabled: orthogonal to parent KHY_VISION_FAILURE_SUMMARY', () => {
  // 父门关不影响本子门读数(正交);父门决定「是否有墙」,子门决定「OCR 成功时是否抑制」。
  assert.strictEqual(
    isFailureSummaryOcrSuppressEnabled({ KHY_VISION_FAILURE_SUMMARY: '0' }),
    true,
    'parent off does not close child',
  );
  assert.strictEqual(
    isVisionFailureSummaryEnabled({ KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS: '0' }),
    true,
    'child off does not close parent',
  );
});

test('isFailureSummaryOcrSuppressEnabled: never throws on junk env', () => {
  assert.doesNotThrow(() => isFailureSummaryOcrSuppressEnabled(null));
  assert.doesNotThrow(() => isFailureSummaryOcrSuppressEnabled({ KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS: {} }));
});
