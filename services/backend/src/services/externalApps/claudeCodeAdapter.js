'use strict';

/**
 * claudeCodeAdapter — 把模型 provider 增删改查落到 claude-code 的 `~/.claude/settings.json`
 * 的 `env` 块(实证 claude-code-main)。claude-code 用环境变量选模型/网关:
 *   {
 *     "env": {
 *       "ANTHROPIC_BASE_URL": "...",
 *       "ANTHROPIC_API_KEY": "sk-...",
 *       "ANTHROPIC_MODEL": "claude-opus-4-6"
 *     }
 *   }
 * 每个 provider 落一组 `<PROVIDER>_API_KEY` / `<PROVIDER>_BASE_URL`;当前默认模型写
 * `ANTHROPIC_MODEL`(claude-code 读该键选模型)。
 *
 * 契约同其它 adapter:configPath / list / get / add / remove,fail-soft,merge-write
 * (只动 env 块内目标键,保留其余设置),remove 带 confirmed 闸门。
 */

const path = require('path');
const S = require('./_shared');

const APP = 'claude-code';

/** ~/.claude/settings.json(CLAUDE_CONFIG_DIR 覆盖目录)。 */
function configPath(env = process.env) {
  const dir = (env && env.CLAUDE_CONFIG_DIR) ? S.expandHome(env.CLAUDE_CONFIG_DIR, env) : S.expandHome('~/.claude', env);
  return path.join(dir, 'settings.json');
}

function _load(env) {
  const file = configPath(env);
  const text = S.readIfExists(file);
  const doc = text ? JSON.parse(text) : {};
  if (!doc.env || typeof doc.env !== 'object') doc.env = {};
  return { file, doc };
}

/** 从 env 块反推已配置的 provider 集合(凡有 <P>_API_KEY 或 <P>_BASE_URL 即算)。 */
function _providersFromEnv(envBlock) {
  const ids = new Set();
  for (const k of Object.keys(envBlock)) {
    const m = k.match(/^([A-Z0-9]+)_(?:API_KEY|BASE_URL)$/);
    if (m) ids.add(m[1].toLowerCase());
  }
  return [...ids];
}

function _providerView(id, envBlock) {
  const keyName = S.envKeyName(id);
  const urlName = S.envKeyName(id, 'BASE_URL');
  return {
    id,
    models: envBlock.ANTHROPIC_MODEL ? [envBlock.ANTHROPIC_MODEL] : [],
    endpoint: envBlock[urlName] || '',
    hasKey: Boolean(envBlock[keyName]),
  };
}

function list(env = process.env) {
  try {
    const { doc } = _load(env);
    const providers = _providersFromEnv(doc.env).map((id) => _providerView(id, doc.env));
    return { success: true, app: APP, providers, model: doc.env.ANTHROPIC_MODEL || '' };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function get(target, env = process.env) {
  try {
    const { doc } = _load(env);
    const id = String(target || '').toLowerCase();
    const keyName = S.envKeyName(id);
    const urlName = S.envKeyName(id, 'BASE_URL');
    if (!doc.env[keyName] && !doc.env[urlName]) {
      return { success: false, app: APP, error: `provider not found: ${id}` };
    }
    return { success: true, app: APP, provider: _providerView(id, doc.env) };
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

    if (resolvedKey.key) doc.env[S.envKeyName(id)] = resolvedKey.key;
    if (resolvedEndpoint) doc.env[S.envKeyName(id, 'BASE_URL')] = resolvedEndpoint;
    if (resolvedModel) doc.env.ANTHROPIC_MODEL = resolvedModel;

    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    return {
      success: true, app: APP, action: 'add', provider: id,
      model: resolvedModel, endpoint: resolvedEndpoint,
      keySource: resolvedKey.source, keyMasked: S.maskKey(resolvedKey.key), file,
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
    const keyName = S.envKeyName(id);
    const urlName = S.envKeyName(id, 'BASE_URL');
    if (!doc.env[keyName] && !doc.env[urlName]) {
      return { success: false, app: APP, error: `provider not found: ${id}` };
    }

    if (!confirmed) {
      return {
        success: true, app: APP, action: 'remove', preview: true, confirmed: false,
        target: id, willRemoveKeys: Boolean(removeKeys),
        message: `将从 ${APP} 的 settings.json env 块删除 provider「${id}」的 BASE_URL${removeKeys ? ' 与 API_KEY' : ''}。回复「确认删除」以执行。`,
      };
    }

    delete doc.env[urlName];
    let keyRemoved = false;
    if (removeKeys && doc.env[keyName] !== undefined) { delete doc.env[keyName]; keyRemoved = true; }
    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    return { success: true, app: APP, action: 'remove', confirmed: true, target: id, keyRemoved, file };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 反向读取(khy 消费侧):返回**含真 key** 的可用视图(key 从 env 块取)。
 * 与 list 同源、同 _load,仅不脱敏 apiKey。claude-code 无 per-provider model 列表,
 * 以 ANTHROPIC_MODEL 为当前模型。
 */
function _usableView(id, envBlock) {
  const keyName = S.envKeyName(id);
  const urlName = S.envKeyName(id, 'BASE_URL');
  const models = envBlock.ANTHROPIC_MODEL ? [envBlock.ANTHROPIC_MODEL] : [];
  return {
    id,
    endpoint: envBlock[urlName] || '',
    apiKey: envBlock[keyName] || '',
    models,
    defaultModel: models[0] || '',
  };
}

function usable(env = process.env) {
  try {
    const { doc } = _load(env);
    const providers = _providersFromEnv(doc.env).map((id) => _usableView(id, doc.env));
    return { success: true, app: APP, providers };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

module.exports = { configPath, list, get, add, remove, usable };
