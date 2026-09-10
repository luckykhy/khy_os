'use strict';
/**
 * visionDescribePinApiAdapter.test.js — 锁定「图像识别始终 404」的根因修复。
 *
 * 历史 bug(实测:key 有效、账号已开通 glm-4.6v-flash / glm-4v-flash 直连均 200,
 * 但对话识图始终返回 `OpenAI: 404 model_not_found`):
 *
 * describe 级联给嵌套 gateway.generate() 传 `apiPoolProvider`(如 'glm')以把请求定向到
 * GLM 视觉端点,但该字段**只在 `api` 适配器内部**被消费(_resolveApiPoolProviderForRequest
 * 仅在 entry.key==='api' 时读它)。旧代码没有同时把 `preferredAdapter` 钉到 'api' →
 * 嵌套调用从头跑完整适配器级联(kiro→cursor→trae→…→api),排在 api 前面的 OpenAI 兼容通道
 * 先接住请求、拿到裸视觉模型名(glm-4.6v-flash)打到自己的上游 → 那里没有此模型 →
 * `OpenAI: 404 model_not_found`。报错前缀「OpenAI」而非「智谱AI」即证据:请求根本没到智谱端点。
 *
 * 修:describe 候选带 poolHint(意味着要定向 api 池的某 provider)时,嵌套 generate() 同时钉
 * `preferredAdapter:'api'` + `strictPreferred:true`(失败不擅自级联到别的通道,而是返回失败
 * 结果由 _attempts 循环去试下一个 GLM 视觉候选)。无 poolHint(裸候选,默认同池)→ 不钉,让级联
 * 自然解析(逐字节回退旧行为)。判定收敛在纯方法 `_shouldPinApiAdapterForVisionDescribe`。
 *
 * 纯正确性修复,不加新 flag(apiPoolProvider 定向必须配合 api 适配器钉选才生效)。
 */
// module.exports = gateway 单例;方法直接挂实例。
const gateway = require('../../../src/services/gateway/aiGateway');

describe('Vision Describe Pin Api Adapter', () => {
  test('有 poolHint(如 glm)→ 应钉 api 适配器(否则被 OpenAI 兼容通道抢答 → 404)', () => {
      expect(gateway._shouldPinApiAdapterForVisionDescribe('glm')).toBe(true);
      expect(gateway._shouldPinApiAdapterForVisionDescribe('deepseek')).toBe(true);
      expect(gateway._shouldPinApiAdapterForVisionDescribe('qwen')).toBe(true);
      // 前后空白容忍(归一化后仍是真实 poolHint)。
      expect(gateway._shouldPinApiAdapterForVisionDescribe('  glm  ')).toBe(true);
  });

  test('无 poolHint(裸候选,默认同池)→ 不钉(逐字节回退,让级联自然解析)', () => {
      expect(gateway._shouldPinApiAdapterForVisionDescribe(undefined)).toBe(false);
      expect(gateway._shouldPinApiAdapterForVisionDescribe(null)).toBe(false);
      expect(gateway._shouldPinApiAdapterForVisionDescribe('')).toBe(false);
      // 纯空白 → 非真实 poolHint → 不钉。
      expect(gateway._shouldPinApiAdapterForVisionDescribe('   ')).toBe(false);
  });

  test('fail-soft:异常/非常规输入绝不抛(实际调用点 poolHint 恒为 string|undefined)', () => {
      // String() 归一化后非空即 true;`0`/`123` → "0"/"123" 非空 → true(非调用路径,仅证不抛)。
      expect(() => gateway._shouldPinApiAdapterForVisionDescribe().not.toThrow());
      expect(() => gateway._shouldPinApiAdapterForVisionDescribe(123).not.toThrow());
      expect(() => gateway._shouldPinApiAdapterForVisionDescribe(false).not.toThrow());
      // false → String(false)="false" 非空 → true(边界,非真实调用形态)。
      expect(gateway._shouldPinApiAdapterForVisionDescribe(false)).toBe(true);
  });

});
