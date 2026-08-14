'use strict';

/**
 * capabilityModelKey.js — 「按模型实测的能力缓存」用哪个字符串做键的单一真源。
 *
 * 为什么必须收口:同一个模型在 khy 内部有两种写法,而两道决定「工具协议」的闸各拿到
 * 其中一种:
 *   - 教学门(khyUpgradeRuntime → cli/ai.js 的 activeModel)拿到**路由 id**
 *     `api:agnes:agnes-2.5-flash`(api 适配器刻意不剥前缀,见 aiGateway.js:1224-1233);
 *   - 剥离门(multiFreeService.callOpenAI 的 opts.model,来自 apiAdapter 的
 *     parseProviderModel)拿到**裸模型名** `agnes-2.5-flash`。
 * 主动探测按前者写库,被动学习(aiGatewayGenerateMethod:775 用 result.model)按后者写库。
 * 于是缓存里出现同一模型的两条相反记录 —— 实测到的现场:
 *     api:agnes:agnes-2.5-flash → text  (probe)
 *     agnes-2.5-flash           → native(passive)
 * 后果是模型在同一轮里既收到完整的原生 tools、又收到「你没有原生工具,请用
 * <tool_call> 文本语法」的教学 —— 指令自相矛盾,模型于是只用散文说「我先用 WebSearch
 * 搜索」而一个工具都不调。这正是 modelToolingCapability.js 头部所说、要靠单一真源杜绝
 * 的那类漂移,只不过漂移点从「判定逻辑」搬到了「键的命名空间」。
 *
 * 规范:键 = **裸模型名**(上游真正收到的那个)。理由有三:
 *   1. 与 toolCapabilityStore 头部既有的设计声明一致(「键 = 规范化 model id,刻意只按
 *      模型名」)—— 带前缀的写入本就是偏离;
 *   2. 剥离门只拿得到裸名,它**无法**还原前缀,所以裸名是唯一两端都可达的形式;
 *   3. 同一个模型不论经哪个适配器/池子到达,能否原生调工具是模型自身的属性。
 *
 * 剥前缀的约定与 adapters/apiAdapter.parseProviderModel、aiGateway.js:1231 同源(三段式
 * `api:<pool>:<model>` + 两段式 `<adapter>:<model>`)。tests 里有一条漂移断言,拿本模块
 * 与 parseProviderModel 在同一张表上对撞,防止三份正则各自演化。
 *
 * 只在前导段是**已知适配器名**时才剥两段式前缀 —— 这是关键的安全边界:ollama 风格的
 * 模型名本身带冒号(`llama3:8b`),若无条件剥就会把 `llama3:8b` 与 `qwen:8b` 一起塌成
 * `8b`,把两个模型的能力记录混作一条。`ollama:llama3:8b` 前导段是已知适配器 → 剥成
 * `llama3:8b`(正确);裸 `llama3:8b` 前导段不是适配器 → 原样保留(正确)。
 *
 * 纯叶子:零依赖(除 trim/lower 工具)、无副作用、绝不抛。
 */

const _norm = require('../../utils/trimLowerNullish');

/**
 * 已知适配器键(= src/services/gateway/adapters/ 下的适配器 + 其历史别名)。仅用于判断
 * 「前导段是不是适配器前缀」,不参与任何路由决策,所以多一个少一个都不会改变行为 ——
 * 少列一个 → 该模型保留旧键(与今天一致);多列一个 → 只影响能力缓存的键。
 */
const ADAPTER_PREFIXES = Object.freeze([
  'api',
  'relay_api',
  'relayapi',
  'claude',
  'codex',
  'kiro',
  'cursor',
  'cursor2api',
  'trae',
  'windsurf',
  'vscode',
  'warp',
  'opencode',
  'clitool',
  'cli_tool',
  'local',
  'localllm',
  'local_llm',
  'ollama',
  'clipboard',
  'clipboardrelay',
  'webrelay',
  'web_relay',
]);

/**
 * 已知池/服务商前缀 —— 两段式 `<provider>:<model>` 同样会造成键分裂:教学门看到
 * `openai:gpt-4o-mini`,而 apiAdapter.parseProviderModel 剥成 `gpt-4o-mini` 交给剥离门。
 * 取自 adapters/apiAdapter.js:46 的 DEFAULT_POOL_TO_SERVICE_PROVIDER(静态部分;env 追加
 * 的自定义池不在此列 —— 少列一个只是保留旧键,不会误伤)。
 */
const PROVIDER_PREFIXES = Object.freeze([
  'openai',
  'anthropic',
  'trae',
  'deepseek',
  'qwen',
  'glm',
  'doubao',
  'wenxin',
  'relay',
  'sensenova',
  'agnes',
  'stepfun',
]);

/**
 * ollama 风格的 tag(`qwen:7b` / `llama3:8b-instruct-q4_K_M` / `mistral:latest`)——
 * 冒号后面是**量化/尺寸标签**,不是模型名。这类串必须整体保留:`qwen` 恰好既是池名又是
 * ollama 的模型家族名,若按前缀剥掉,`qwen:7b` 就会以 `7b` 为键 —— 一个毫无意义、还可能
 * 与别的家族撞车的键。判据只认标签的形状,不猜模型名。
 * @param {string} rest
 * @returns {boolean}
 */
function _looksLikeModelTag(rest) {
  return /^(?:latest|\d+(?:\.\d+)?[bm](?:[-_].*)?|q\d.*)$/i.test(rest);
}

// 三段式路由 id:`api:<pool>:<model>`(与 apiAdapter.js:257 / aiGateway.js:1231 同一约定)。
const COMPOSITE_RE = /^api[:/]([a-z0-9_-]+)[:/](.+)$/i;
// 两段式:`<adapter>:<model>`(与 apiAdapter.js:267 同一约定)。
const PREFIXED_RE = /^([a-z0-9_-]+)[:/](.+)$/i;

/**
 * 把任意写法的 model 串规范成能力缓存的键(裸模型名,小写去空白)。
 * 空/非串 → ''(调用方据此放弃读写,与既有 normalizeModel 的语义一致)。
 * @param {string} model
 * @returns {string}
 */
function capabilityModelKey(model) {
  const m = _norm(model);
  if (!m) {
    return '';
  }

  const composite = COMPOSITE_RE.exec(m);
  if (composite) {
    return _norm(composite[2]);
  }

  const prefixed = PREFIXED_RE.exec(m);
  if (prefixed) {
    const head = prefixed[1];
    const rest = _norm(prefixed[2]);
    const known = ADAPTER_PREFIXES.includes(head) || PROVIDER_PREFIXES.includes(head);
    if (known && rest && !_looksLikeModelTag(rest)) {
      return rest;
    }
  }

  return m;
}

module.exports = {
  capabilityModelKey,
  ADAPTER_PREFIXES,
  PROVIDER_PREFIXES,
  COMPOSITE_RE,
  PREFIXED_RE,
};
