'use strict';

/**
 * commandCodeAdapter — 把模型 provider 增删改查落到 Command Code 的
 * `~/.commandcode/providers.json`（BYOK 供应商表）与 `~/.commandcode/config.json`
 * （默认模型）。实证 Command Code 官方文档（commandcode.ai/docs/byok、
 * /docs/settings）。
 *
 * providers.json 形状（BYOK 供应商核心）:
 *   {
 *     "provider": {
 *       "<id>": {
 *         "name": "DeepSeek",
 *         "baseURL": "https://api.deepseek.com/v1",
 *         "api": "openai-completions",        // 或 anthropic-messages
 *         "apiKey": "$KHY_CC_SWITCH_<ID>_KEY", // env 引用（key 绝不内联明文）
 *         "models": { "deepseek-chat": { "contextWindow": 65536 } }
 *       }
 *     }
 *   }
 *
 * 密钥策略（对齐官方「raw secret pasted into the file is refused」）：卡片密钥
 * 经 khy 的 apiKeyPool 持有，写入 providers.json 时只写 env 引用
 * `$KHY_CC_SWITCH_<ID>_KEY`；真实密钥由 khy 启动器（`khy` 环境）注入，或用户
 * 在自己的 shell 里 export。config.json 只置 `model`（默认模型）——Command Code
 * 按 `provider/<model>` 前缀路由 BYOK 模型。
 *
 * 契约同其它 adapter：configPath / list / get / add / remove，fail-soft
 * （任何异常 → {success:false,error}），merge-write（只动目标 provider 表，
 * 保留其余条目），remove 带 confirmed 闸门。
 */

const fs = require('fs');
const path = require('path');

const S = require('./_shared');

const APP = 'command-code';

// Wire 映射：ccSwitch 协议 → Command Code BYOK `api` 字段。
const API_WIRE = Object.freeze({
  openai: 'openai-completions',
  openai_responses: 'openai-completions',
  anthropic: 'anthropic-messages',
  gemini: 'openai-completions', // gemini 端点通常也走 OpenAI 兼容根
});

/** ~/.commandcode/providers.json（COMMAND_CODE_HOME 覆盖目录）。 */
function configPath(env = process.env) {
  const dir =
    env && env.COMMAND_CODE_HOME
      ? S.expandHome(env.COMMAND_CODE_HOME, env)
      : S.expandHome('~/.commandcode', env);
  return path.join(dir, 'providers.json');
}

/** ~/.commandcode/config.json（用户偏好：provider/model/theme）。 */
function configFilePath(env = process.env) {
  const dir =
    env && env.COMMAND_CODE_HOME
      ? S.expandHome(env.COMMAND_CODE_HOME, env)
      : S.expandHome('~/.commandcode', env);
  return path.join(dir, 'config.json');
}

function _load(env) {
  const file = configPath(env);
  const text = S.readIfExists(file);
  const doc = text ? JSON.parse(text) : {};
  if (!doc.provider || typeof doc.provider !== 'object') {
    doc.provider = {};
  }
  return { file, doc };
}

function _loadConfig(env) {
  const file = configFilePath(env);
  const text = S.readIfExists(file);
  const doc = text ? JSON.parse(text) : {};
  return { file, doc };
}

function _providerView(id, p, model) {
  const models = p && p.models && typeof p.models === 'object' ? Object.keys(p.models) : [];
  return {
    id,
    models,
    endpoint: (p && p.baseURL) || (p && p.options && p.options.baseURL) || '',
    hasKey: Boolean(p && p.apiKey),
    defaultModel: model || models[0] || '',
  };
}

function list(env = process.env) {
  try {
    const { doc } = _load(env);
    const { doc: cfg } = _loadConfig(env);
    const model = String(cfg.model || '').trim();
    const providers = Object.keys(doc.provider).map((id) => _providerView(id, doc.provider[id], model));
    return { success: true, app: APP, providers, model };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function get(target, env = process.env) {
  try {
    const { doc } = _load(env);
    const { doc: cfg } = _loadConfig(env);
    const id = String(target || '').toLowerCase();
    const p = doc.provider[id];
    if (!p) {
      return { success: false, app: APP, error: `provider not found: ${id}` };
    }
    return {
      success: true,
      app: APP,
      provider: _providerView(id, p, String(cfg.model || '').trim()),
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 增/改（upsert，幂等）：写 providers.json 的 provider 表 + 置 config.json 的
 * model。密钥只写 env 引用（`$KHY_CC_SWITCH_<ID>_KEY`），绝不内联明文——
 * Command Code 官方会拒绝 providers.json 里的裸密钥。
 */
function add({ provider, model, apiKey, endpoint, protocol, wireApi } = {}, env = process.env) {
  try {
    const id = String(provider || '').toLowerCase();
    if (!id) {
      return { success: false, app: APP, error: 'provider is required' };
    }
    const { file, doc } = _load(env);
    const { file: cfgFile, doc: cfg } = _loadConfig(env);

    const resolvedEndpoint = endpoint || S.resolveEndpoint(id, '');
    const resolvedModel = model || S.resolveModel(id, '');
    if (!resolvedEndpoint) {
      return { success: false, app: APP, error: 'endpoint is required（卡片缺少 baseUrl）' };
    }

    const api = API_WIRE[protocol] || (wireApi === 'responses' ? 'openai-completions' : 'openai-completions');

    const p = doc.provider[id] && typeof doc.provider[id] === 'object' ? doc.provider[id] : {};
    p.name = String(provider);
    p.baseURL = resolvedEndpoint;
    p.api = api;
    // Key as env reference only. `apiKey` given → the caller (khy) is expected to
    // have exported KHY_CC_SWITCH_<ID>_KEY; if absent we still write the reference
    // so the provider works once the env var is set (matches BYOK key-less flow).
    if (apiKey) {
      p.apiKey = `$KHY_CC_SWITCH_${id.toUpperCase()}_KEY`;
    } else if (p.apiKey === undefined) {
      // No key known at all — leave unset (keyless local endpoints) unless the
      // provider already declared a reference we should preserve.
      delete p.apiKey;
    }
    p.models = p.models && typeof p.models === 'object' ? p.models : {};
    if (resolvedModel && !p.models[resolvedModel]) {
      p.models[resolvedModel] = { contextWindow: 200000 };
    }
    doc.provider[id] = p;

    // Default model for new sessions: `<provider>/<model>` (BYOK prefix rule).
    if (resolvedModel) {
      cfg.model = `${id}/${resolvedModel}`;
    }
    // Ensure the selected provider is the active one.
    if (!cfg.provider) {
      cfg.provider = 'command-code';
    }

    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    S.atomicWrite(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    return {
      success: true,
      app: APP,
      action: 'add',
      provider: id,
      model: resolvedModel,
      endpoint: resolvedEndpoint,
      keyRef: p.apiKey || '',
      file,
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function remove({ target, confirmed } = {}, env = process.env) {
  try {
    const id = String(target || '').toLowerCase();
    if (!id) {
      return { success: false, app: APP, error: 'target is required' };
    }
    const { file, doc } = _load(env);
    const { file: cfgFile, doc: cfg } = _loadConfig(env);
    if (!doc.provider[id]) {
      return { success: false, app: APP, error: `provider not found: ${id}` };
    }

    if (!confirmed) {
      return {
        success: true,
        app: APP,
        action: 'remove',
        preview: true,
        confirmed: false,
        target: id,
        message: `将从 ${APP} 删除 provider「${id}」（providers.json 条目 + config.json 默认模型若指向它）。回复「确认删除」以执行。`,
      };
    }

    delete doc.provider[id];
    if (cfg.model && String(cfg.model).startsWith(`${id}/`)) {
      delete cfg.model;
    }
    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    S.atomicWrite(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    return { success: true, app: APP, action: 'remove', confirmed: true, target: id, file };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 反向读取（khy 消费侧）：返回含 env 引用 key 的可用视图（供检测/状态）。
 * 真 key 由 khy 侧从 apiKeyPool 解析，不经此路径。
 */
function _usableView(id, p) {
  const models = p && p.models && typeof p.models === 'object' ? Object.keys(p.models) : [];
  return {
    id,
    endpoint: (p && p.baseURL) || '',
    apiKey: (p && p.apiKey) || '',
    models,
    defaultModel: models[0] || '',
  };
}

function usable(env = process.env) {
  try {
    const { doc } = _load(env);
    const providers = Object.keys(doc.provider).map((id) => _usableView(id, doc.provider[id]));
    return { success: true, app: APP, providers };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

module.exports = { configPath, configFilePath, list, get, add, remove, usable, API_WIRE };
