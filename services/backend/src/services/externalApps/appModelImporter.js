'use strict';

/**
 * appModelImporter — khy 消费侧薄壳:把 6 个外部软件里已配置的可用模型**读出来并注册进 khy
 * 自己的 provider 池**,让 khy 能像用 codex / claude-code 的模型一样选它、调它。
 *
 * 这是「把模型配进外部软件」(externalApps/*Adapter 的 add/remove)的**逆向**:
 *   - 读:各 adapter 的 usable(env) 回该 app 已配置 provider 的真 key+endpoint+models。
 *   - 注册:对每个 provider 调 customProviderRegistrar.registerCustomProvider,一次性写
 *     apiKeyPool + custom_providers.json + 路由 env 映射;之后 apiAdapter.listModels() 自动列出
 *     `api:<poolKey>:<model>`,modelRouter → apiAdapter.generate() 用 pool.pick 拿真 key 发请求。
 *   - poolKey = `<app>-<provider>`(如 opencode-deepseek):避与 khy 内置 poolKey 冲突 + 记录来源。
 *
 * 密钥安全:真 key 只在进程内从 adapter 直接喂给 registerCustomProvider.keyInput,**绝不上命令行、
 * 绝不回显**;所有返回经 maskKey(头尾各 4 字符)脱敏。app 无 key 时经 _shared.resolveApiKey 借
 * khy 已存的同厂商 key(keySource='pool')。
 *
 * 契约:门控 KHY_EXTERNAL_APP_IMPORT(flagRegistry 优先 + 本地 CANON 回退)、fail-soft(绝不抛 →
 * {success:false,error} 或 skipped)。registrar 依赖可注入(deps.registrar),便于测试传 spy 免污染
 * 全局 env/.env。门控关 → discover/import/unimport 整体 no-op(逐字节回退)。
 */

const S = require('./_shared');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

const _ADAPTERS = {
  opencode: './opencodeAdapter',
  openclaw: './openclawAdapter',
  'claude-code': './claudeCodeAdapter',
  reasonix: './reasonixAdapter',
  'deepseek-tui': './deepseekTuiAdapter',
  coze: './cozeAdapter',
};

const APPS = Object.keys(_ADAPTERS);

/** 门控:KHY_EXTERNAL_APP_IMPORT 默认开。flagRegistry 优先,叶子本地 CANON 回退(仅 {0,false,off,no} 关)。 */
function isEnabled(env = process.env) {
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_EXTERNAL_APP_IMPORT', env);
    }
  } catch { /* registry unavailable — local CANON fallback */ }
  const raw = env && env.KHY_EXTERNAL_APP_IMPORT;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _normApp = require('../../utils/trimLowerCase');

function _adapterFor(app) {
  const mod = _ADAPTERS[_normApp(app)];
  if (!mod) return null;
  try { return require(mod); } catch { return null; }
}

/** poolKey = `<app>-<provider>`,规整为 registrar 认可的 `/^[a-z0-9][-a-z0-9]*$/`。 */
function _poolKey(app, providerId) {
  const raw = `${_normApp(app)}-${String(providerId || '').toLowerCase()}`;
  return raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** 默认 registrar(真)。测试经 deps.registrar 注入 spy。 */
function _defaultRegistrar() {
  try { return require('./customProviderRegistrar'); } catch { return null; }
}

/**
 * 发现单个 app 已配置的可用 provider(脱敏视图,供展示)。
 * @returns { success, app, providers:[{id, endpoint, models, defaultModel, hasKey, keyMasked}] }
 */
function discover(app, env = process.env) {
  if (!isEnabled(env)) return { success: false, app: _normApp(app), error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）', providers: [] };
  const adapter = _adapterFor(app);
  if (!adapter || typeof adapter.usable !== 'function') {
    return { success: false, app: _normApp(app), error: `不支持的外部软件: ${app || '(空)'}`, providers: [] };
  }
  try {
    const res = adapter.usable(env) || {};
    if (!res.success) return { success: false, app: _normApp(app), error: res.error || 'usable failed', providers: [] };
    const providers = (res.providers || []).map((p) => ({
      id: p.id,
      endpoint: p.endpoint || '',
      models: Array.isArray(p.models) ? p.models.slice() : [],
      defaultModel: p.defaultModel || (p.models && p.models[0]) || '',
      hasKey: Boolean(p.apiKey),
      keyMasked: S.maskKey(p.apiKey || ''),
    }));
    return { success: true, app: _normApp(app), providers };
  } catch (e) {
    return { success: false, app: _normApp(app), error: String((e && e.message) || e), providers: [] };
  }
}

/** 遍历 6 app 聚合发现。 */
function discoverAll(env = process.env) {
  if (!isEnabled(env)) return { success: false, error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）', apps: [] };
  const apps = APPS.map((app) => discover(app, env));
  return { success: true, apps };
}

/**
 * 把单个 app 的可用 provider 注册进 khy。
 * @param {object} opts { app, provider?(只导入指定 id), tier?, dryRun? }
 * @param {object} env
 * @param {object} deps { registrar? } 可注入 registrar 供测试
 * @returns { success, app, imported:[...], skipped:[...] }
 */
function importApp(opts = {}, env = process.env, deps = {}) {
  const app = _normApp(opts.app);
  if (!isEnabled(env)) return { success: false, app, error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）', imported: [], skipped: [] };
  const adapter = _adapterFor(app);
  if (!adapter || typeof adapter.usable !== 'function') {
    return { success: false, app, error: `不支持的外部软件: ${opts.app || '(空)'}`, imported: [], skipped: [] };
  }
  const registrar = deps.registrar || _defaultRegistrar();
  if (!registrar || typeof registrar.registerCustomProvider !== 'function') {
    return { success: false, app, error: 'customProviderRegistrar 不可用', imported: [], skipped: [] };
  }

  const imported = [];
  const skipped = [];
  let raw;
  try {
    raw = adapter.usable(env) || {};
  } catch (e) {
    return { success: false, app, error: String((e && e.message) || e), imported: [], skipped: [] };
  }
  if (!raw.success) return { success: false, app, error: raw.error || 'usable failed', imported: [], skipped: [] };

  const wantOne = opts.provider ? String(opts.provider).toLowerCase() : '';
  for (const p of raw.providers || []) {
    const id = String(p.id || '').toLowerCase();
    if (wantOne && id !== wantOne) continue;

    // 密钥:app 自己的真 key 优先,否则借 khy 已存的同厂商 key。
    let key = p.apiKey || '';
    let keySource = key ? 'app' : 'none';
    if (!key) {
      try {
        const r = S.resolveApiKey(id, '');
        if (r && r.key) { key = r.key; keySource = r.source; }
      } catch { /* pool unavailable */ }
    }
    // endpoint:app 自己的优先,否则 preset baseUrl。
    let endpoint = p.endpoint || '';
    if (!endpoint) {
      try { endpoint = S.resolveEndpoint(id, ''); } catch { /* ignore */ }
    }
    const models = Array.isArray(p.models) ? p.models.filter(Boolean) : [];
    const defaultModel = p.defaultModel || models[0] || '';

    // 缺任一必要字段 → 跳过(记原因,绝不半截注册)。
    if (!defaultModel) { skipped.push({ app, provider: id, reason: 'no model configured' }); continue; }
    if (!endpoint) { skipped.push({ app, provider: id, reason: 'no endpoint (app 未配 + 无 preset)' }); continue; }
    if (!key) { skipped.push({ app, provider: id, reason: 'no api key (app 未配 + khy 池无同厂商 key)' }); continue; }

    const poolKey = _poolKey(app, id);
    if (opts.dryRun) {
      imported.push({
        app, provider: id, poolKey, models: models.length ? models : [defaultModel],
        defaultModel, endpoint, keySource, keyMasked: S.maskKey(key), dryRun: true,
      });
      continue;
    }
    try {
      const result = registrar.registerCustomProvider({
        displayName: `${app}:${id}`,
        poolKey,
        endpoint,
        keyInput: key,
        defaultModel,
        extraModels: models.filter((m) => m !== defaultModel),
        tier: opts.tier || '',
        ensureInit: true,
      });
      imported.push({
        app, provider: id, poolKey: (result && result.poolKey) || poolKey,
        models: (result && result.models) || models, defaultModel,
        endpoint: (result && result.endpoint) || endpoint,
        keySource, keyMasked: S.maskKey(key),
      });
    } catch (e) {
      skipped.push({ app, provider: id, reason: String((e && e.message) || e) });
    }
  }

  return { success: true, app, imported, skipped };
}

/** 遍历 6 app 全部导入。 */
function importAll(opts = {}, env = process.env, deps = {}) {
  if (!isEnabled(env)) return { success: false, error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）', imported: [], skipped: [] };
  const imported = [];
  const skipped = [];
  for (const app of APPS) {
    const r = importApp({ app, tier: opts.tier, dryRun: opts.dryRun }, env, deps);
    if (r && Array.isArray(r.imported)) imported.push(...r.imported);
    if (r && Array.isArray(r.skipped)) skipped.push(...r.skipped);
  }
  return { success: true, imported, skipped };
}

/**
 * 反注册一个已导入的外部 app 模型(khy 消费侧撤销)。
 * @param {object} opts { app, provider, removeKeys? }
 */
function unimport(opts = {}, env = process.env, deps = {}) {
  const app = _normApp(opts.app);
  if (!isEnabled(env)) return { success: false, app, error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）' };
  const id = String(opts.provider || '').toLowerCase();
  if (!id) return { success: false, app, error: 'provider is required' };
  const registrar = deps.registrar || _defaultRegistrar();
  if (!registrar || typeof registrar.unregisterCustomProvider !== 'function') {
    return { success: false, app, error: 'customProviderRegistrar 不可用' };
  }
  const poolKey = _poolKey(app, id);
  try {
    const result = registrar.unregisterCustomProvider(poolKey, { removeKeys: opts.removeKeys === true });
    return { success: true, app, provider: id, poolKey, removeKeys: opts.removeKeys === true, result };
  } catch (e) {
    return { success: false, app, provider: id, poolKey, error: String((e && e.message) || e) };
  }
}

module.exports = {
  isEnabled,
  discover,
  discoverAll,
  importApp,
  importAll,
  unimport,
  APPS,
  _poolKey,
};
