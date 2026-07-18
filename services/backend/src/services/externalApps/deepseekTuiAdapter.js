'use strict';

/**
 * deepseekTuiAdapter — 把模型 provider 增删改查落到 DeepSeek-TUI 的
 * `~/.deepseek/config.toml`(点分子表 `[providers.<id>]`),密钥直接写子表的 `api_key`
 * (实证 DeepSeek-TUI config.example.toml / docs/CONFIGURATION.md)。
 *
 * config.toml 形状:
 *   provider = "deepseek"                 # 顶层当前 provider
 *   default_text_model = "deepseek-v4-flash"
 *   [providers.deepseek]
 *   base_url = "https://api.deepseek.com"
 *   api_key  = "sk-..."
 *   models   = ["deepseek-v4-flash"]
 *
 * 契约同其它 adapter:configPath / list / get / add / remove,fail-soft,merge-write,
 * remove 带 confirmed 闸门。TOML 经零依赖 tomlLite;异常由本层收敛。
 */

const path = require('path');
const S = require('./_shared');
const toml = require('./tomlLite');

const APP = 'deepseek-tui';

/** ~/.deepseek/config.toml(DEEPSEEK_CONFIG_PATH 直指文件 / DEEPSEEK_HOME 覆盖目录)。 */
function configPath(env = process.env) {
  if (env && env.DEEPSEEK_CONFIG_PATH) return S.expandHome(env.DEEPSEEK_CONFIG_PATH, env);
  const dir = (env && env.DEEPSEEK_HOME) ? S.expandHome(env.DEEPSEEK_HOME, env) : S.expandHome('~/.deepseek', env);
  return path.join(dir, 'config.toml');
}

function _load(env) {
  const file = configPath(env);
  const text = S.readIfExists(file);
  const doc = text ? toml.parse(text) : {};
  if (!doc.providers || typeof doc.providers !== 'object') doc.providers = {};
  return { file, doc };
}

function _providerView(id, p) {
  return {
    id,
    models: Array.isArray(p && p.models) ? p.models.slice() : [],
    endpoint: (p && p.base_url) || '',
    hasKey: Boolean(p && p.api_key),
  };
}

function list(env = process.env) {
  try {
    const { doc } = _load(env);
    const providers = Object.keys(doc.providers).map((id) => _providerView(id, doc.providers[id]));
    return { success: true, app: APP, providers, model: doc.default_text_model || '' };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function get(target, env = process.env) {
  try {
    const { doc } = _load(env);
    const id = String(target || '').toLowerCase();
    const p = doc.providers[id];
    if (!p) return { success: false, app: APP, error: `provider not found: ${id}` };
    return { success: true, app: APP, provider: _providerView(id, p) };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function add({ provider, model, apiKey, endpoint } = {}, env = process.env) {
  try {
    const id = String(provider || '').toLowerCase();
    if (!id) return { success: false, app: APP, error: 'provider is required' };
    const { file, doc } = _load(env);

    const resolvedKey = S.resolveApiKey(id, apiKey);
    const resolvedEndpoint = S.resolveEndpoint(id, endpoint);
    const resolvedModel = S.resolveModel(id, model);

    const p = doc.providers[id] && typeof doc.providers[id] === 'object' ? doc.providers[id] : {};
    if (resolvedEndpoint) p.base_url = resolvedEndpoint;
    if (resolvedKey.key) p.api_key = resolvedKey.key;
    p.models = Array.isArray(p.models) ? p.models : [];
    if (resolvedModel && !p.models.includes(resolvedModel)) p.models.push(resolvedModel);
    doc.providers[id] = p;
    doc.provider = id;
    if (resolvedModel) doc.default_text_model = resolvedModel;

    S.atomicWrite(file, toml.stringify(doc));
    return {
      success: true, app: APP, action: 'add', provider: id,
      model: resolvedModel, endpoint: resolvedEndpoint,
      keySource: resolvedKey.source, keyMasked: S.maskKey(resolvedKey.key), file,
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function remove({ target, confirmed } = {}, env = process.env) {
  try {
    const id = String(target || '').toLowerCase();
    if (!id) return { success: false, app: APP, error: 'target is required' };
    const { file, doc } = _load(env);
    if (!doc.providers[id]) return { success: false, app: APP, error: `provider not found: ${id}` };

    if (!confirmed) {
      return {
        success: true, app: APP, action: 'remove', preview: true, confirmed: false, target: id,
        message: `将从 ${APP} 删除 provider「${id}」(含其 api_key)。回复「确认删除」以执行。`,
      };
    }

    delete doc.providers[id];
    if (doc.provider === id) delete doc.provider;
    S.atomicWrite(file, toml.stringify(doc));
    return { success: true, app: APP, action: 'remove', confirmed: true, target: id, file };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 反向读取(khy 消费侧):返回**含真 key** 的可用视图(key 为子表 inline api_key)。
 * 与 list 同源、同 _load,仅不脱敏 apiKey。
 */
function _usableView(id, p) {
  const models = Array.isArray(p && p.models) ? p.models.slice() : [];
  return {
    id,
    endpoint: (p && p.base_url) || '',
    apiKey: (p && p.api_key) || '',
    models,
    defaultModel: models[0] || '',
  };
}

function usable(env = process.env) {
  try {
    const { doc } = _load(env);
    const providers = Object.keys(doc.providers).map((id) => _usableView(id, doc.providers[id]));
    return { success: true, app: APP, providers };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

module.exports = { configPath, list, get, add, remove, usable };
