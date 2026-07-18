'use strict';

/**
 * openclawAdapter — 把模型 provider 增删改查落到 openclaw 的 `~/.openclaw/openclaw.json`,
 * 密钥旁路到同目录 `.env` 的 `<PROVIDER>_API_KEY`(实证 openclaw-main)。
 *
 * openclaw 配置形状:
 *   {
 *     "models": {
 *       "providers": {
 *         "deepseek": { "baseUrl": "...", "models": ["deepseek-v4-flash"], "input": ["text"] }
 *       }
 *     },
 *     "agents": { "defaults": { "model": { "primary": "deepseek/deepseek-v4-flash" } } }
 *   }
 * 密钥不进 json,写 `~/.openclaw/.env`:`DEEPSEEK_API_KEY=sk-...`。
 *
 * 契约同其它 adapter:configPath / list / get / add / remove,fail-soft,merge-write,
 * remove 带 confirmed 闸门(removeKeys 时一并清 .env 键)。
 */

const path = require('path');
const S = require('./_shared');

const APP = 'openclaw';
const TOMBSTONE = '# openclaw-cleared';

/** ~/.openclaw/ 目录(OPENCLAW_HOME 覆盖)。 */
function _home(env = process.env) {
  if (env && env.OPENCLAW_HOME) return S.expandHome(env.OPENCLAW_HOME, env);
  return S.expandHome('~/.openclaw', env);
}

function configPath(env = process.env) {
  return path.join(_home(env), 'openclaw.json');
}

function _envPath(env = process.env) {
  return path.join(_home(env), '.env');
}

function _load(env) {
  const file = configPath(env);
  const text = S.readIfExists(file);
  const doc = text ? JSON.parse(text) : {};
  if (!doc.models || typeof doc.models !== 'object') doc.models = {};
  if (!doc.models.providers || typeof doc.models.providers !== 'object') doc.models.providers = {};
  return { file, doc };
}

function _providerView(id, p, envMap) {
  const models = Array.isArray(p && p.models) ? p.models.slice() : [];
  return {
    id,
    models,
    endpoint: (p && (p.baseUrl || p.baseURL)) || '',
    hasKey: Boolean(envMap[S.envKeyName(id)]),
  };
}

function list(env = process.env) {
  try {
    const { doc } = _load(env);
    const envMap = S.parseDotenv(S.readIfExists(_envPath(env)));
    const providers = Object.keys(doc.models.providers)
      .map((id) => _providerView(id, doc.models.providers[id], envMap));
    const primary = (((doc.agents || {}).defaults || {}).model || {}).primary || '';
    return { success: true, app: APP, providers, model: primary };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function get(target, env = process.env) {
  try {
    const { doc } = _load(env);
    const envMap = S.parseDotenv(S.readIfExists(_envPath(env)));
    const id = String(target || '').toLowerCase();
    const p = doc.models.providers[id];
    if (!p) return { success: false, app: APP, error: `provider not found: ${id}` };
    return { success: true, app: APP, provider: _providerView(id, p, envMap) };
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

    const p = doc.models.providers[id] && typeof doc.models.providers[id] === 'object'
      ? doc.models.providers[id] : {};
    if (resolvedEndpoint) p.baseUrl = resolvedEndpoint;
    p.models = Array.isArray(p.models) ? p.models : [];
    if (resolvedModel && !p.models.includes(resolvedModel)) p.models.push(resolvedModel);
    if (!Array.isArray(p.input)) p.input = ['text'];
    doc.models.providers[id] = p;

    if (resolvedModel) {
      doc.agents = doc.agents && typeof doc.agents === 'object' ? doc.agents : {};
      doc.agents.defaults = doc.agents.defaults && typeof doc.agents.defaults === 'object' ? doc.agents.defaults : {};
      doc.agents.defaults.model = doc.agents.defaults.model && typeof doc.agents.defaults.model === 'object'
        ? doc.agents.defaults.model : {};
      doc.agents.defaults.model.primary = `${id}/${resolvedModel}`;
    }

    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);

    // 密钥旁路 .env。
    let keyWritten = false;
    if (resolvedKey.key) {
      const envFile = _envPath(env);
      const next = S.upsertDotenv(S.readIfExists(envFile), S.envKeyName(id), resolvedKey.key);
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
    if (!doc.models.providers[id]) return { success: false, app: APP, error: `provider not found: ${id}` };

    if (!confirmed) {
      return {
        success: true, app: APP, action: 'remove', preview: true, confirmed: false,
        target: id, willRemoveKeys: Boolean(removeKeys),
        message: `将从 ${APP} 删除 provider「${id}」${removeKeys ? '(连同 .env 密钥)' : ''}。回复「确认删除」以执行。`,
      };
    }

    delete doc.models.providers[id];
    const primary = (((doc.agents || {}).defaults || {}).model || {}).primary;
    if (primary && String(primary).startsWith(`${id}/`)) {
      delete doc.agents.defaults.model.primary;
    }
    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);

    let keyRemoved = false;
    if (removeKeys) {
      const envFile = _envPath(env);
      const existing = S.readIfExists(envFile);
      if (existing != null) {
        const res = S.removeDotenvKey(existing, S.envKeyName(id), TOMBSTONE);
        if (res.removed) { S.atomicWrite(envFile, res.text); keyRemoved = true; }
      }
    }

    return { success: true, app: APP, action: 'remove', confirmed: true, target: id, keyRemoved, file };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 反向读取(khy 消费侧):返回**含真 key** 的可用视图(key 从旁路 .env 取)。
 * 与 list 同源、同 _load/envMap,仅不脱敏 apiKey。
 */
function _usableView(id, p, envMap) {
  const models = Array.isArray(p && p.models) ? p.models.slice() : [];
  return {
    id,
    endpoint: (p && (p.baseUrl || p.baseURL)) || '',
    apiKey: envMap[S.envKeyName(id)] || '',
    models,
    defaultModel: models[0] || '',
  };
}

function usable(env = process.env) {
  try {
    const { doc } = _load(env);
    const envMap = S.parseDotenv(S.readIfExists(_envPath(env)));
    const providers = Object.keys(doc.models.providers)
      .map((id) => _usableView(id, doc.models.providers[id], envMap));
    return { success: true, app: APP, providers };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

module.exports = { configPath, list, get, add, remove, usable };
