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
const {
  isVisionFailureSummaryEnabled,
  isFailureSummaryOcrSuppressEnabled,
  classifyVisionFailure,
  buildVisionFailureMessage,
  sanitizeCause,
} = require('../../../src/services/gateway/visionFailureSummary');
const ON = {}; // 默认开
const OFF = { KHY_VISION_FAILURE_SUMMARY: '0' };
// ── OPS-MAN-142:失败墙推迟到 OCR 结果已知后(OCR suppress 子门) ────────────────────

describe('Vision Failure Summary', () => {
  test('gate default-on; off values close it (byte-revert)', () => {
      expect(isVisionFailureSummaryEnabled({})).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'No']) {
        expect(isVisionFailureSummaryEnabled({ KHY_VISION_FAILURE_SUMMARY: v })).toBe(false, v);
      }
      // 任意其它值 → 仍开
      expect(isVisionFailureSummaryEnabled({ KHY_VISION_FAILURE_SUMMARY: '1' })).toBe(true);
  });

  test('classifyVisionFailure: 401 / [auth] → auth', () => {
      expect(classifyVisionFailure('智谱AI: Request failed with status code 401 - api [auth]: Request failed with status code 401')).toBe('auth');
      expect(classifyVisionFailure('403 Forbidden')).toBe('auth');
      expect(classifyVisionFailure('invalid api key')).toBe('auth');
  });

  test('classifyVisionFailure: missing key → no_key (before generic network)', () => {
      expect(classifyVisionFailure('no available key for glm')).toBe('no_key');
      expect(classifyVisionFailure('未配置 GLM_API_KEY')).toBe('no_key');
      expect(classifyVisionFailure('无可用密钥')).toBe('no_key');
  });

  test('classifyVisionFailure: rate limit / timeout / network / unknown', () => {
      expect(classifyVisionFailure('429 Too Many Requests')).toBe('rate_limit');
      expect(classifyVisionFailure('请求超时 ETIMEDOUT')).toBe('timeout');
      expect(classifyVisionFailure('connect ECONNREFUSED 127.0.0.1:443')).toBe('network');
      expect(classifyVisionFailure('502 Bad Gateway')).toBe('network');
      expect(classifyVisionFailure('something weird happened')).toBe('unknown');
      expect(classifyVisionFailure('')).toBe('unknown');
      expect(classifyVisionFailure(null)).toBe('unknown');
  });

  test('classifyVisionFailure: 404 / model_not_found → model_not_found (the reported bug)', () => {
      // 用户实测原文:裸模型名落到自定义 api 池 → 404 model_not_found。
      assert.strictEqual(
        classifyVisionFailure('OpenAI: Request failed with status code 404 - api [model_not_found]: Request failed with status code 404'),
        'model_not_found');
      expect(classifyVisionFailure('no such model: glm-4.6v-flash')).toBe('model_not_found');
      expect(classifyVisionFailure('该模型不存在')).toBe('model_not_found');
      // 顺序:404 不吞 401(auth 先判)/ 不吞 502(network 只认 50[234]);429 仍是限流。
      expect(classifyVisionFailure('401 unauthorized')).toBe('auth');
      expect(classifyVisionFailure('502 Bad Gateway')).toBe('network');
      expect(classifyVisionFailure('429 rate limit')).toBe('rate_limit');
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
      expect(classifyVisionFailure('Request failed with status code 404')).toBe('model_not_found');
  });

  test('buildVisionFailureMessage: 401 → summary + explicit key-config offer, not provider-narrowed', () => {
      const msg = buildVisionFailureMessage({
        rawError: '智谱AI: Request failed with status code 401 - api [auth]: Request failed with status code 401',
        model: 'glm-4.6v-flash',
        env: ON,
      });
      expect(msg).toBeTruthy();
      // ① 以「图像识别失败」定性,不窄化到单一 provider
      expect(msg).toMatch(/图像识别失败/);
      // ② 点出所用视觉模型
      expect(msg).toMatch(/glm-4\.6v-flash/);
      // ③ 真因保留 401
      expect(msg).toMatch(/401/);
      // ④ 明确的配置邀约(GLM 或其他 + API Key)
      expect(msg).toMatch(/配置\s*GLM/);
      expect(msg).toMatch(/API Key/i);
      expect(msg).toMatch(/其他/);
      // ⑤ paste-to-replace invite present on the key-related category too
      expect(msg).toMatch(/粘贴|发给我/);
      expect(msg).toMatch(/立即用它替换|替换当前的 key/);
  });

  test('buildVisionFailureMessage: no_key → key-config offer', () => {
      const msg = buildVisionFailureMessage({ rawError: 'no available key for glm', model: 'glm-4.6v-flash', env: ON });
      expect(msg).toMatch(/图像识别失败/);
      expect(msg).toMatch(/API Key/i);
      expect(msg).toMatch(/配置\s*GLM/);
  });

  test('buildVisionFailureMessage: network/timeout → still offers to switch/config a vision model', () => {
      const net = buildVisionFailureMessage({ rawError: 'connect ECONNREFUSED', model: 'glm-4.6v-flash', env: ON });
      expect(net).toMatch(/图像识别失败/);
      expect(net).toMatch(/图像识别模型/);
      expect(net).toMatch(/API Key/i);
  });

  test('buildVisionFailureMessage: 404 model_not_found → names BOTH causes (wrong/placeholder key OR unsubscribed) + paste-to-replace invite', () => {
      const msg = buildVisionFailureMessage({
        rawError: 'OpenAI: Request failed with status code 404 - api [model_not_found]: Request failed with status code 404',
        model: 'glm-4.6v-flash',
        env: ON,
      });
      expect(msg).toBeTruthy();
      expect(msg).toMatch(/图像识别失败/);
      expect(msg).toMatch(/未找到|model_not_found/);        // headline (neutral: not "model absent")
      expect(msg).toMatch(/404/);                            // real cause preserved
      expect(msg).toMatch(/GLM/);                            // offers the GLM route/key
      expect(msg).toMatch(/provider|渠道|端点/);             // still mentions endpoint option
      // NEW: honest about the two real causes — key wrong/placeholder OR account not subscribed.
      expect(msg).toMatch(/占位 key|无效的 API Key/);        // wrong/placeholder key cause
      expect(msg).toMatch(/未开通/);                          // account-not-subscribed cause
      // NEW: paste-to-replace invite — user pastes the real key, khy replaces it immediately.
      expect(msg).toMatch(/粘贴|发给我/);
      expect(msg).toMatch(/立即用它替换|替换当前的 key/);
  });

  test('buildVisionFailureMessage: gate OFF → null (caller byte-reverts to legacy)', () => {
      expect(buildVisionFailureMessage({ rawError: '401', model: 'x', env: OFF })).toBe(null);
  });

  test('buildVisionFailureMessage: never throws on junk', () => {
      expect(() => buildVisionFailureMessage({ env: ON }).not.toThrow());
      expect(() => buildVisionFailureMessage({ rawError: {}, model: 42, env: ON }).not.toThrow());
      expect(() => buildVisionFailureMessage().not.toThrow());
  });

  test('sanitizeCause: strips bearer/api_key, keeps status code + host', () => {
      const s = sanitizeCause('Bearer sk-abcdef123456 failed 401 at open.bigmodel.cn');
      expect(!/sk-abcdef123456/.test(s)).toBeTruthy();
      expect(s).toMatch(/401/);
      expect(s).toMatch(/open\.bigmodel\.cn/);
  });

  test('isFailureSummaryOcrSuppressEnabled: default-on', () => {
      expect(isFailureSummaryOcrSuppressEnabled({})).toBe(true);
      expect(isFailureSummaryOcrSuppressEnabled(undefined)).toBe(true);
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
      expect(() => isFailureSummaryOcrSuppressEnabled(null).not.toThrow());
      expect(() => isFailureSummaryOcrSuppressEnabled({ KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS: {} }).not.toThrow());
  });

});
