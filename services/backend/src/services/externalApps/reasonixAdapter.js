'use strict';

/**
 * reasonixAdapter — 把模型 provider 增删改查落到 DeepSeek-Reasonix 的
 * `~/.reasonix/config.toml`(`[[providers]]` 表数组),密钥旁路到同目录 `.env`
 * 的 `api_key_env` 命名键(实证 Reasonix CONFIG_PATHS.md)。
 *
 * config.toml 里每个 provider 是一个 `[[providers]]`:
 *   [[providers]]
 *   name = "deepseek"
 *   kind = "openai"
 *   base_url = "https://api.deepseek.com"
 *   models = ["deepseek-v4-flash"]
 *   default = "deepseek-v4-flash"
 *   api_key_env = "DEEPSEEK_API_KEY"
 * config.toml 只存 `api_key_env` 键名,真 secret 写 `~/.reasonix/.env`。
 *
 * 契约同其它 adapter:configPath / list / get / add / remove,fail-soft,merge-write
 * (保留其余 provider 与顶层设置),remove 带 confirmed 闸门。TOML 经零依赖 tomlLite;
 * 解析/序列化异常由本层 try/catch 收敛为 {success:false,error}。
 */

const path = require('path');
const S = require('./_shared');
const toml = require('./tomlLite');

const APP = 'reasonix';
const TOMBSTONE = '# reasonix-cleared';

/** ~/.reasonix/(REASONIX_HOME 覆盖)。 */
function _home(env = process.env) {
  if (env && env.REASONIX_HOME) return S.expandHome(env.REASONIX_HOME, env);
  return S.expandHome('~/.reasonix', env);
}

function configPath(env = process.env) {
  return path.join(_home(env), 'config.toml');
}

function _envPath(env = process.env) {
  return path.join(_home(env), '.env');
}

function _load(env) {
  const file = configPath(env);
  const text = S.readIfExists(file);
  const doc = text ? toml.parse(text) : {};
  if (!Array.isArray(doc.providers)) doc.providers = [];
  return { file, doc };
}

function _providerView(p, envMap) {
  const keyEnv = p.api_key_env || S.envKeyName(p.name);
  return {
    id: p.name,
    models: Array.isArray(p.models) ? p.models.slice() : [],
    endpoint: p.base_url || '',
    hasKey: Boolean(envMap[keyEnv]),
  };
}

function list(env = process.env) {
  try {
    const { doc } = _load(env);
    const envMap = S.parseDotenv(S.readIfExists(_envPath(env)));
    const providers = doc.providers.map((p) => _providerView(p, envMap));
    return { success: true, app: APP, providers, model: doc.default_model || '' };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function get(target, env = process.env) {
  try {
    const { doc } = _load(env);
    const envMap = S.parseDotenv(S.readIfExists(_envPath(env)));
    const id = String(target || '').toLowerCase();
    const p = doc.providers.find((x) => String(x.name).toLowerCase() === id);
    if (!p) return { success: false, app: APP, error: `provider not found: ${id}` };
    return { success: true, app: APP, provider: _providerView(p, envMap) };
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
    const keyEnv = S.envKeyName(id);

    let p = doc.providers.find((x) => String(x.name).toLowerCase() === id);
    if (!p) { p = { name: id, kind: 'openai' }; doc.providers.push(p); }
    if (!p.kind) p.kind = 'openai';
    if (resolvedEndpoint) p.base_url = resolvedEndpoint;
    p.models = Array.isArray(p.models) ? p.models : [];
    if (resolvedModel && !p.models.includes(resolvedModel)) p.models.push(resolvedModel);
    if (resolvedModel) p.default = resolvedModel;
    p.api_key_env = keyEnv;
    if (resolvedModel) doc.default_model = `${id}/${resolvedModel}`;

    S.atomicWrite(file, toml.stringify(doc));

    let keyWritten = false;
    if (resolvedKey.key) {
      const envFile = _envPath(env);
      const next = S.upsertDotenv(S.readIfExists(envFile), keyEnv, resolvedKey.key);
      S.atomicWrite(envFile, next);
      keyWritten = true;
    }

    return {
      success: true, app: APP, action: 'add', provider: id,
      model: resolvedModel, endpoint: resolvedEndpoint,
      keySource: resolvedKey.source, keyMasked: S.maskKey(resolvedKey.key), keyWritten, file,
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function remove({ target, confirmed, removeKeys } = {}, env = process.env) {
  try {
    const id = String(target || '').toLowerCase();
    if (!id) return { success: false, app: APP, error: 'target is required' };
    const { file, doc } = _load(env);
    const idx = doc.providers.findIndex((x) => String(x.name).toLowerCase() === id);
    if (idx === -1) return { success: false, app: APP, error: `provider not found: ${id}` };

    if (!confirmed) {
      return {
        success: true, app: APP, action: 'remove', preview: true, confirmed: false,
        target: id, willRemoveKeys: Boolean(removeKeys),
        message: `将从 ${APP} 删除 provider「${id}」${removeKeys ? '(连同 .env 密钥)' : ''}。回复「确认删除」以执行。`,
      };
    }

    const keyEnv = doc.providers[idx].api_key_env || S.envKeyName(id);
    doc.providers.splice(idx, 1);
    if (doc.default_model && String(doc.default_model).startsWith(`${id}/`)) delete doc.default_model;
    S.atomicWrite(file, toml.stringify(doc));

    let keyRemoved = false;
    if (removeKeys) {
      const envFile = _envPath(env);
      const existing = S.readIfExists(envFile);
      if (existing != null) {
        const res = S.removeDotenvKey(existing, keyEnv, TOMBSTONE);
        if (res.removed) { S.atomicWrite(envFile, res.text); keyRemoved = true; }
      }
    }

    return { success: true, app: APP, action: 'remove', confirmed: true, target: id, keyRemoved, file };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 反向读取(khy 消费侧):返回**含真 key** 的可用视图(key 从旁路 .env 的 api_key_env 命名键取)。
 * 与 list 同源、同 _load/envMap,仅不脱敏 apiKey。
 */
function _usableView(p, envMap) {
  const keyEnv = p.api_key_env || S.envKeyName(p.name);
  const models = Array.isArray(p.models) ? p.models.slice() : [];
  return {
    id: p.name,
    endpoint: p.base_url || '',
    apiKey: envMap[keyEnv] || '',
    models,
    defaultModel: p.default || models[0] || '',
  };
}

function usable(env = process.env) {
  try {
    const { doc } = _load(env);
    const envMap = S.parseDotenv(S.readIfExists(_envPath(env)));
    const providers = doc.providers.map((p) => _usableView(p, envMap));
    return { success: true, app: APP, providers };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

module.exports = { configPath, list, get, add, remove, usable };
