'use strict';

/**
 * builtinGlmKey.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * pip 安装后开箱可用:给智谱 GLM(poolKey `glm`)预置一个**占位** API key,使 GLM 在
 * 首次启动即以「已配置」态出现在 provider 池 / /model 选择器 / Web 网关里,无需先 khy init。
 * 这条与 apiKeyPool.BUILTIN_PROVIDER_KEYS 里 sensenova 的既有先例同构——builtin fallback
 * **仅当该 key 尚不在池中才并入**,优先级 0(最低),因此:
 *   - 用户经自然语言(「配置 glm 的 key…」)或 Web 网关(POST /api/ai-gateway/pool/glm/keys)
 *     添加**真** key 时,真 key 落 priority 10 → 组成最高优先组 → 占位 key 永不被选中
 *     (apiKeyPool 只在最高优先组内轮询);
 *   - 用户删除/覆盖占位 key 亦即时生效(reload 重新对账)。
 *
 * 门控 KHY_BUILTIN_GLM_KEY(默认开):关(0/false/off/no)→ builtinGlmKeyEntries 返 {} →
 * apiKeyPool 完全不并入该占位 key → 逐字节回退今日「GLM 无内置 key,须自行配置」行为。
 * 绝不抛:异常一律回退关门语义(返 {})。flagRegistry 优先,失败回退本地 CANON 解析。
 *
 * 诚实:这是**占位**假 key,不能真调通 GLM;它只是让 pip 安装后 GLM 以「已配置」态出现、
 * 并给用户一个可经 NL/Web 一键替换的目标。真正可用需用户填自己的智谱 key。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 智谱 GLM 占位 key(id.secret 形态,与 legacy JWT 路径兼容;真 key 由用户经 NL/Web 覆盖)。
// 端点复用 apiKeyPool 既有 GLM 默认(OpenAI 兼容 v4)。priority 0 = 最低,任何真 key 皆盖过它。
// 安全铁律:此值必须是**一眼可辨的假值**,绝不能是任何真实 key 的变体/篡改副本——它会随
// pip 包分发进源码,任何近似真 key 的写法都是凭据泄漏。占位判定只依赖本常量值(见 apiKeyPool
// _placeholderKeys),换值即自洽,无需改其它文件。
const GLM_POOL_KEY = 'glm';
const GLM_PLACEHOLDER_KEY = 'khy-builtin-placeholder.not-a-real-key-configure-your-own';
const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4';

/**
 * 门控 KHY_BUILTIN_GLM_KEY:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function builtinGlmKeyEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_BUILTIN_GLM_KEY', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_BUILTIN_GLM_KEY;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 内置 GLM 占位 key 条目(供 apiKeyPool 并入 BUILTIN_PROVIDER_KEYS 的 fallback 集):
 *   - 开门 → { glm: { key, endpoint, priority:0, label:'built-in' } };
 *   - 关门/异常 → {}(apiKeyPool 逐字节回退,不并入)。
 * 返回全新对象,调用方可自由改动不影响内部常量。
 * @param {Record<string,string>} [env]
 * @returns {Record<string, {key:string, endpoint:string, priority:number, label:string}>}
 */
function builtinGlmKeyEntries(env = process.env) {
  try {
    if (!builtinGlmKeyEnabled(env)) return {};
    return {
      [GLM_POOL_KEY]: {
        key: GLM_PLACEHOLDER_KEY,
        endpoint: GLM_ENDPOINT,
        priority: 0,
        label: 'built-in',
        // 占位 key 无法真正调通 GLM(见文件头「诚实」注释):标记为 placeholder,让 apiKeyPool
        // 的可用性/选择路径(hasAvailableKeys/pick)把它排除——只用于让 GLM 以「已配置」态出现在
        // 选择器/introspection(getPoolStatus 仍列出),绝不被当作可发请求的真实凭据。
        placeholder: true,
      },
    };
  } catch {
    return {};
  }
}

module.exports = {
  GLM_POOL_KEY,
  GLM_PLACEHOLDER_KEY,
  GLM_ENDPOINT,
  builtinGlmKeyEnabled,
  builtinGlmKeyEntries,
};
