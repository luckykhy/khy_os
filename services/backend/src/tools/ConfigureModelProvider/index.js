/**
 * configureModelProvider — agent-callable tool that configures a model
 * provider's API key (and the model it maps to) directly from a conversation.
 *
 * This is the SANCTIONED execution path for "帮我配置模型密钥" in chat: the agent
 * gathers the vendor / key / model, restates them with the key REDACTED, and
 * calls this tool to persist the config. It routes to the existing service
 * single sources of truth — never shells out, so the API key stays in-process
 * (a key on a shell command line would leak via history / ps / logs):
 *   - known built-in vendor (DeepSeek/Qwen/GLM/OpenAI/Anthropic/…)
 *       → services/gateway/builtinProviderConfig.applyBuiltinProviderKey
 *   - custom / relay (OpenAI-compatible)
 *       → services/customProviderRegistrar.registerCustomProvider
 *
 * Sensitivity: writing an API key is a high-risk side effect, so the tool is
 * declared risk:'high' (drives the human-gate confirmation) and isDestructive
 * when it would REPLACE an existing key (unbypassable confirmation). The full
 * key is never echoed — only `maskToken()` output appears in activity/result.
 */
'use strict';

const { defineTool } = require('../_baseTool');
const { findBuiltinProvider, applyBuiltinProviderKey } = require('../../services/gateway/builtinProviderConfig');
const { registerCustomProvider, unregisterCustomProvider } = require('../../services/customProviderRegistrar');
const { maskToken } = require('../../services/accountPool/credentialHelpers');

// 增/删/列 动作门控:KHY_PROVIDER_CONFIG_ACTIONS 默认开,仅 {0,false,off,no} 关。
// 关 → 强制 action='add' → 逐字节回退为「只增/替换」的历史行为(remove/list 路径不可达)。
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _actionsEnabled(env = process.env) {
  const raw = env && env.KHY_PROVIDER_CONFIG_ACTIONS;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}
/** Resolve the effective action. Gate off (or unknown value) → 'add' (byte-fallback). */
function resolveAction(input = {}) {
  if (!_actionsEnabled()) return 'add';
  const a = String(input.action || 'add').trim().toLowerCase();
  return (a === 'remove' || a === 'list') ? a : 'add';
}

/** Derive a pool-key slug from a free-form display name. */
function slugifyPoolKey(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Best-effort: does this pool key already hold a key? (drives isDestructive) */
function poolHasKey(poolKey) {
  if (!poolKey) return false;
  try {
    const pool = require('../../services/apiKeyPool');
    try { pool.init(); } catch { /* already initialised */ }
    return (pool.getPoolStatus(poolKey) || []).length > 0;
  } catch {
    return false;
  }
}

// ── 修 GLM 配置死循环:两个默认开门控(注册于 flagRegistry)。仿 builtinGlmKey.js 的
//    「registry 优先 + 本地 CANON 回退 + fail-soft」范式;门关/异常 → 逐字节回退旧行为。────
function _gateEnabled(name, env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('../../services/flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled(name, e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e[name];
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !_FALSY.has(v); // 未设 → 默认开
  } catch {
    return false;
  }
}

/**
 * 判定一个 provider 的 pool 状态里是否存在**真** key —— 即非「内置占位假 key」。
 * 占位 key 由 builtinGlmKey.js 以 priority 0 + label 'built-in' 并入(见其文档:
 * 占位是假 key、不能真调通),故 `label==='built-in' && priority===0` 即占位。
 * 用户经 NL/Web 加的真 key 落 priority 10 → 此谓词为真。空/异常 → false(保守:不谎报已配置)。
 * @param {Array<{priority:number,label:string}>} status  getPoolStatus 返回项
 * @returns {boolean}
 */
function _hasRealKey(status) {
  try {
    return (status || []).some((e) => !(e && e.label === 'built-in' && e.priority === 0));
  } catch {
    return false;
  }
}

/** Resolve the target pool key for an input without performing any writes. */
function resolvePoolKey(input = {}) {
  if (input.kind !== 'custom') {
    const builtin = findBuiltinProvider(input.provider);
    if (builtin && input.kind !== 'custom') return builtin.poolKey;
  }
  return input.poolKey ? slugifyPoolKey(input.poolKey) : slugifyPoolKey(input.provider);
}

/** action=list — read-only enumeration of configured providers, keys REDACTED. */
function executeList() {
  try {
    const customRegistry = require('../../services/customProviderRegistry');
    const pool = require('../../services/apiKeyPool');
    try { pool.init(); } catch { /* already initialised */ }
    const providers = (customRegistry.listProviders() || []).map((p) => {
      let keyCount = 0;
      let keyHeads = [];
      try {
        const status = pool.getPoolStatus(p.poolKey) || [];
        keyCount = status.length;
        keyHeads = status.map((e) => e.keyPreview).filter(Boolean); // already masked at source
      } catch { /* best effort */ }
      return {
        provider: p.name || p.poolKey,
        poolKey: p.poolKey,
        kind: 'custom',
        endpoint: p.endpoint || '',
        defaultModel: p.defaultModel || '',
        models: Array.isArray(p.models) ? p.models : [],
        keyCount,
        keyHeads,
      };
    });

    // ── 修 GLM 死循环(核心):内置 provider 的 key 写进 pool/env、从不写 custom_providers.json,
    //    历史 list 只读该文件 → 配了 key 的内置 provider 永不出现。门开 → 同时枚举**有真 key**
    //    (非 priority-0 占位)的内置 provider,tag kind:'builtin'。门关/异常 → 逐字节回退只读
    //    custom_providers.json(现行为)。全程 fail-soft,绝不让本增补拖垮既有 list。
    if (_gateEnabled('KHY_PROVIDER_LIST_MERGE_BUILTIN')) {
      try {
        const seen = new Set(providers.map((p) => p.poolKey));
        const { listBuiltinProviders } = require('../../services/gateway/builtinProviderConfig');
        for (const b of (listBuiltinProviders() || [])) {
          if (!b || !b.poolKey || seen.has(b.poolKey)) continue; // 跳过 poolKey:null(如 HuggingFace)与撞车
          let status = [];
          try { status = pool.getPoolStatus(b.poolKey) || []; } catch { status = []; }
          if (!_hasRealKey(status)) continue; // 只有内置占位假 key → 不谎报「已配置」
          // 智谱 key 配好后自动加入免费模型:glm 行的 models 并入免费聊天/视觉模型
          // (门控 KHY_ZHIPU_FREE_MODELS,门关/非 glm/异常 → 原样,逐字节回退)。
          let bModels = Array.isArray(b.models) ? b.models : [];
          try { bModels = require('../../services/gateway/zhipuFreeModels').augmentGlmPoolModels(b.poolKey, bModels); } catch { /* keep */ }
          providers.push({
            provider: b.name || b.poolKey,
            poolKey: b.poolKey,
            kind: 'builtin',
            endpoint: b.defaultEndpoint || '',
            defaultModel: (Array.isArray(b.models) && b.models[0]) || '',
            models: bModels,
            keyCount: status.length,
            keyHeads: status.map((e) => e.keyPreview).filter(Boolean),
          });
          seen.add(b.poolKey);
        }
      } catch { /* fail-soft: 内置合并失败不影响已构好的自定义列表 */ }
    }

    // ── 问 khyos「有哪些模型/渠道」时也给其他免费模型渠道(门控 KHY_FREE_MODEL_CHANNELS)。
    //    纯加法:只 append freeChannels 字段,既有字段逐字节不变;门关/异常静默省略(逐字节回退)。
    const listOut = { success: true, action: 'list', count: providers.length, providers };
    try {
      if (_gateEnabled('KHY_FREE_MODEL_CHANNELS')) {
        const channels = require('../../services/freeModelChannels').listFreeModelChannels();
        if (channels.length) listOut.freeChannels = channels;
      }
    } catch { /* fail-soft:免费渠道追加失败不影响 list 结果 */ }
    return listOut;
  } catch (err) {
    return { success: false, action: 'list', error: err && err.message ? err.message : String(err) };
  }
}

/**
 * action=remove — unregister a custom provider. Default keeps the stored keys
 * (recoverable); removeKeys=true also drops them. Built-in providers are
 * refused by the registrar (error transcribed). The unbypassable human-gate
 * (isDestructive=true for remove) provides the "preview + confirm" for Tier B/C.
 */
function executeRemove(params = {}) {
  const target = params.poolKey
    ? slugifyPoolKey(params.poolKey)
    : resolvePoolKey(params);
  if (!target) {
    return { success: false, action: 'remove', error: '未指定要删除的供应商（provider 或 poolKey）' };
  }
  try {
    const res = unregisterCustomProvider(target, { removeKeys: params.removeKeys === true });
    return {
      success: true,
      action: 'remove',
      poolKey: res.poolKey,
      removed: res.removed,
      keptKeys: res.keptKeys,
    };
  } catch (err) {
    return { success: false, action: 'remove', error: err && err.message ? err.message : String(err) };
  }
}

module.exports = defineTool({
  name: 'configureModelProvider',
  description:
    '配置某个模型供应商的 API Key 并登记其模型（落库生效）。支持内置厂商（DeepSeek/通义千问/智谱 GLM/豆包/OpenAI/Anthropic/Trae/Relay 等，按名称或 poolKey 识别）与自定义/中转（OpenAI 兼容，需 base-url）。调用前请先向用户复述配置且把 Key 脱敏，绝不回显完整 Key。',
  category: 'system',
  risk: 'high',
  // 动作随 action 变:list 只读;remove 破坏性;add 在会替换既有 key 时破坏性。
  // 门控关 → resolveAction 恒 'add' → isReadOnly=false、isDestructive=poolHasKey(...)(历史行为)。
  isReadOnly: (input) => resolveAction(input || {}) === 'list',
  isDestructive: (input) => {
    const a = resolveAction(input || {});
    if (a === 'remove') return true;
    if (a === 'list') return false;
    return poolHasKey(resolvePoolKey(input || {}));
  },
  isConcurrencySafe: false,
  shouldDefer: true,
  searchHint: '配置 模型 密钥 api key provider 厂商 网关 gateway configure model key add remove delete list provider 中转 relay deepseek qwen openai 删除 移除 列出 查看 替换 换成 换为 更换 切换 改成 改为 修改 更新 replace swap update change 替换密钥 换key 通义 智谱 豆包 文心',
  maxResultSizeChars: 2000,

  inputSchema: {
    action: { type: 'string', required: false, description: "动作：'add'(默认,配置/替换密钥)、'remove'(删除供应商,默认保留密钥)、'list'(只读列出已配置供应商,密钥脱敏)" },
    // provider/apiKey 对 add 必需(execute 内校验并友好报错);对 remove 用作目标;对 list 可省。
    // 刻意不在 schema 标 required:true,以便 list/remove 可调;门控关时 execute 的 add 守卫等价兜底。
    provider: { type: 'string', required: false, description: '厂商名称或 poolKey（内置如 deepseek/DeepSeek/通义千问），或自定义供应商的显示名（add 必填；remove 作为删除目标）' },
    apiKey: { type: 'string', required: false, description: 'API Key（机密，仅进程内使用，绝不回显完整值；add 必填）' },
    model: { type: 'string', required: false, description: '要设为默认并登记路由的模型 ID（自定义供应商必填）' },
    endpoint: { type: 'string', required: false, description: 'Base URL（自定义/中转必填；内置厂商可留空走默认）' },
    extraModels: { type: 'string', required: false, description: '额外模型 ID，逗号分隔（仅自定义）' },
    tier: { type: 'string', required: false, description: '能力档位 T0-T3，留空自动分级（仅自定义）' },
    poolKey: { type: 'string', required: false, description: '自定义供应商的内部 id（小写字母/数字/连字符）；留空则从显示名推导' },
    kind: { type: 'string', required: false, description: "强制配置类型：'builtin' 或 'custom'；留空自动判定" },
    removeKeys: { type: 'boolean', required: false, description: 'action=remove 时是否连同已存储的密钥一并删除（默认 false，仅摘 provider 元数据+路由、保留密钥可复用）' },
  },

  getActivityDescription(input) {
    const action = resolveAction(input || {});
    if (action === 'list') return '列出已配置的模型供应商（只读，密钥脱敏）';
    if (action === 'remove') {
      const tgt = input && (input.provider || input.poolKey) ? (input.provider || input.poolKey) : '供应商';
      return `删除供应商 ${tgt}（${input && input.removeKeys ? '连密钥一起删' : '默认保留密钥'}）`;
    }
    const masked = input && input.apiKey ? maskToken(input.apiKey) : '***';
    const model = input && input.model ? input.model : '默认';
    return `配置 ${input && input.provider ? input.provider : '供应商'}（模型 ${model}，Key ${masked}）`;
  },

  async execute(params = {}) {
    const action = resolveAction(params);
    if (action === 'list') return executeList();
    if (action === 'remove') return executeRemove(params);

    // ── action === 'add'(默认):以下为历史行为,逐字节不变 ──
    const provider = String(params.provider || '').trim();
    if (!provider) return { success: false, error: '未指定供应商（provider）' };
    const apiKey = params.apiKey;
    if (!apiKey || !String(apiKey).trim()) return { success: false, error: '未提供 API Key' };

    const keyRedacted = maskToken(apiKey);

    try {
      const forceCustom = params.kind === 'custom';
      const builtin = forceCustom ? null : findBuiltinProvider(provider);

      if (params.kind === 'builtin' && !builtin) {
        return { success: false, error: `未知的内置厂商: ${provider}（如需自定义请提供 endpoint 并设 kind=custom）` };
      }

      // ── built-in vendor branch ──
      if (builtin) {
        const result = applyBuiltinProviderKey({
          provider: builtin,
          keyInput: apiKey,
          endpoint: params.endpoint, // undefined → service falls back to defaultEndpoint
          model: params.model || '',
        });
        const out = {
          success: true,
          kind: 'builtin',
          provider: builtin.name,
          poolKey: result.poolKey,
          model: result.model || '',
          endpoint: result.endpoint || '',
          keyRedacted,
          added: result.added,
          duplicate: result.duplicate,
          models: result.models,
          token: !!result.token,
        };
        // ── 修 GLM 死循环:add 回读校验 + 引导 note(门控 KHY_PROVIDER_ADD_READBACK 默认开)。
        //    弱模型看到「add 成功」却在 list 找不到内置 provider(它的 key 只进 key 池、不进
        //    custom_providers.json)→ 误判「没加成功」反复重试。此处回读 pool 确认**真** key 是否
        //    落地(keyLanded),并 append 一条解释 note:内置 provider 不入 custom_providers.json
        //    属正常、配好真 key 后经 list 可见;若只剩占位假 key 则明确提示需填自己的 key。
        //    纯加法:只 append keyLanded/note 两字段,既有字段逐字节不变;回读失败静默省略。
        if (_gateEnabled('KHY_PROVIDER_ADD_READBACK')) {
          try {
            const pool = require('../../services/apiKeyPool');
            try { pool.init(); } catch { /* already initialised */ }
            const status = pool.getPoolStatus(result.poolKey) || [];
            const keyLanded = _hasRealKey(status);
            out.keyLanded = keyLanded;
            out.note = keyLanded
              ? `已写入 key 池:「${result.poolKey}」是内置 provider,其 key 存入内置 key 池而非 custom_providers.json(这是正常的,不要再手动改该文件);现在用 configureModelProvider(action=list) 即可看到它。`
              : `注意:「${result.poolKey}」当前只有内置占位 key(非真实可用),请填入你自己的该厂商 API Key;它不会出现在 custom_providers.json,这是正常的。`;
          } catch { /* fail-soft:回读失败不影响既有返回 */ }
        }
        // ── 目标:智谱 key 配好后自动加入免费模型 + 同时给其他免费模型渠道。─────────────────
        //    纯加法:只 append freeModels/freeChannels 字段与 note 尾注,既有字段逐字节不变;
        //    门关/异常静默省略(逐字节回退)。freeModels 仅 glm 池追加(与 zhipuFreeModels 叶子
        //    对齐,该叶子是免费模型权威源);freeChannels 对任何成功的内置 add 都附带,兑现「问
        //    khyos 也会给其他免费模型渠道」。
        try {
          if (String(result.poolKey || '').trim().toLowerCase() === 'glm'
            && _gateEnabled('KHY_ZHIPU_FREE_MODELS')) {
            const zf = require('../../services/gateway/zhipuFreeModels');
            const free = zf.listZhipuFreeModels();
            if (free.length) {
              out.freeModels = free;
              const ids = free.map((m) => m.id).join('、');
              out.note = `${out.note ? `${out.note} ` : ''}已为「glm」加入 ${free.length} 个智谱免费模型(${ids}),在 /model 选择器可见、可直接免费调用。`;
            }
          }
        } catch { /* fail-soft:免费模型追加失败不影响既有返回 */ }
        try {
          if (_gateEnabled('KHY_FREE_MODEL_CHANNELS')) {
            const fc = require('../../services/freeModelChannels');
            const channels = fc.listFreeModelChannels();
            if (channels.length) {
              out.freeChannels = channels;
              const msg = fc.buildFreeModelChannelsMessage();
              if (msg) out.note = `${out.note ? `${out.note} ` : ''}此外还有其他免费模型渠道可配置:${msg}。`;
            }
          }
        } catch { /* fail-soft:免费渠道追加失败不影响既有返回 */ }
        return out;
      }

      // ── custom / relay branch ──
      const endpoint = String(params.endpoint || '').trim();
      if (!endpoint) {
        return { success: false, error: `「${provider}」不是内置厂商，需要提供 base-url（endpoint）才能作为自定义/中转供应商配置` };
      }
      const model = String(params.model || '').trim();
      if (!model) {
        return { success: false, error: '自定义/中转供应商需要指定默认模型 ID（model）' };
      }
      const poolKey = params.poolKey ? slugifyPoolKey(params.poolKey) : slugifyPoolKey(provider);
      if (!poolKey) {
        return { success: false, error: '无法从显示名推导出有效的 poolKey，请提供 poolKey（小写字母/数字/连字符）' };
      }

      // ── 修 GLM 死循环:内置 poolKey 被误当 custom 的可操作引导。──────────────────────────
      //    registrar 的 normalizePoolKey 对内置 poolKey(glm/deepseek/…)抛 terse 异常
      //    (「…是内置 provider,不能作为自定义名称」)→ 弱模型对着异常瞎试(改 kind、手改
      //    custom_providers.json)撞循环。此处提前拦截,把 terse 报错换成明确出路:用 add
      //    (不带 kind=custom)配置,key 会进内置 key 池并可经 list 查看。严格超集(仅把一条
      //    必失败路径的报错文案变友好,不改任何成功语义),故无需门控;探测失败 → 静默放行
      //    落回 registrar 原有守卫(逐字节回退)。
      try {
        const { isBuiltinPoolKey } = require('../../services/customProviderRegistry');
        if (typeof isBuiltinPoolKey === 'function' && isBuiltinPoolKey(poolKey)) {
          return {
            success: false,
            error: `「${poolKey}」是内置 provider,不要当自定义供应商配置(也不要手动改 custom_providers.json)。请改用 configureModelProvider(action=add、不带 kind=custom、provider 填「${provider}」或「${poolKey}」)——它的 key 会写入内置 key 池,配好后用 action=list 即可看到。`,
          };
        }
      } catch { /* fail-soft:探测失败落回 registrar 原有内置守卫 */ }

      const result = registerCustomProvider({
        displayName: provider,
        poolKey,
        endpoint,
        keyInput: apiKey,
        defaultModel: model,
        extraModels: params.extraModels,
        tier: params.tier,
        ensureInit: true,
      });

      return {
        success: true,
        kind: 'custom',
        provider: result.displayName,
        poolKey: result.poolKey,
        model: result.defaultModel,
        endpoint: result.endpoint,
        keyRedacted,
        keyCount: result.keyCount,
        tier: result.tier,
        models: result.models,
      };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  },
});
