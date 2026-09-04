'use strict';

/**
 * ycodeAdapter — 把模型 provider 增删改查落到 YCode 的 `.ycode/config.json`
 * `provider` 块。实证 YCode 官方 README（github.com/yuzu-ux/ycode）。
 *
 * YCode 配置形状（`.ycode/config.json`）:
 *   {
 *     "provider": {
 *       "connection": "api",
 *       "base_url": "https://api.deepseek.com/v1",
 *       "model": "deepseek-chat",
 *       "api_key_env": "DEEPSEEK_API_KEY",   // 只引用 env 变量名，绝不落盘 key
 *       "timeout_seconds": 180,
 *       "stream": true
 *     },
 *     "agent": { ... }
 *   }
 *
 * 密钥策略（对齐 YCode 官方「never writes the key to its config」）：只写
 * `api_key_env` = `KHY_CC_SWITCH_<ID>_KEY`。真 key 由 khy apiKeyPool 持有，
 * 用户通过 khy 启动器或 shell export 注入。config 只含引用，可安全提交。
 *
 * 配置位置：默认项目级 `<cwd>/.ycode/config.json`。可用 YCODE_CONFIG_DIR 覆盖
 * 到用户级全局目录（对齐官方 override）。list/get 反读时同样考虑这两处。
 *
 * 契约同其它 adapter：configPath / list / get / add / remove，fail-soft
 * （任何异常 → {success:false,error}），merge-write（只动 provider 块，
 * 保留 agent 等其余配置），remove 带 confirmed 闸门。
 */

const fs = require('fs');
const path = require('path');

const S = require('./_shared');

const APP = 'ycode';

/** 配置目录：YCODE_CONFIG_DIR 优先，否则项目 .ycode。 */
function configDir(env = process.env) {
  if (env && env.YCODE_CONFIG_DIR) {
    return S.expandHome(env.YCODE_CONFIG_DIR, env);
  }
  return path.join(process.cwd(), '.ycode');
}

/** .ycode/config.json 路径。 */
function configPath(env = process.env) {
  return path.join(configDir(env), 'config.json');
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

/** 生成稳定的 env 引用名：KHY_CC_SWITCH_<ID>_KEY。 */
function envKeyNameForId(id) {
  const norm = String(id || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `KHY_CC_SWITCH_${norm || 'CUSTOM'}_KEY`;
}

function _providerView(provider) {
  return {
    id: provider && provider.base_url ? 'api' : '',
    models: provider && provider.model ? [provider.model] : [],
    endpoint: (provider && provider.base_url) || '',
    hasKey: Boolean(provider && provider.api_key_env),
    connection: (provider && provider.connection) || '',
    defaultModel: (provider && provider.model) || '',
  };
}

function list(env = process.env) {
  try {
    const { doc } = _load(env);
    const provider = doc.provider;
    const providers = provider && typeof provider === 'object' ? [_providerView(provider)] : [];
    return { success: true, app: APP, providers, model: (provider && provider.model) || '' };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function get(target, env = process.env) {
  try {
    const { doc } = _load(env);
    const provider = doc.provider;
    if (!provider || typeof provider !== 'object') {
      return { success: false, app: APP, error: `provider not found: ${target}` };
    }
    return { success: true, app: APP, provider: _providerView(provider) };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 增/改（upsert，幂等）：把 YCode 的 provider 块指向卡片端点 + 模型。
 * 只写 api_key_env 引用（YCode 官方绝不在配置里放 key 明文）。
 */
function add({ provider, model, apiKey, endpoint, connection } = {}, env = process.env) {
  try {
    const { file, doc } = _load(env);

    const resolvedEndpoint = endpoint || S.resolveEndpoint(provider || 'api', '');
    const resolvedModel = model || S.resolveModel(provider || 'api', '');
    if (!resolvedEndpoint) {
      return { success: false, app: APP, error: 'endpoint is required（卡片缺少 baseUrl）' };
    }

    const p = doc.provider && typeof doc.provider === 'object' ? doc.provider : {};
    p.connection = connection || 'api';
    p.base_url = resolvedEndpoint;
    if (resolvedModel) {
      p.model = resolvedModel;
    }
    if (apiKey) {
      // Only the env-var NAME is written — the real key never touches config.
      p.api_key_env = envKeyNameForId(provider || 'api');
    } else if (p.api_key_env === undefined) {
      delete p.api_key_env;
    }
    // Keep the other provider fields stable (timeout_seconds / stream preserved).
    if (p.timeout_seconds === undefined) {
      p.timeout_seconds = 180;
    }
    if (p.stream === undefined) {
      p.stream = true;
    }
    doc.provider = p;

    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    return {
      success: true,
      app: APP,
      action: 'add',
      provider: p.connection,
      model: resolvedModel,
      endpoint: resolvedEndpoint,
      keyEnvRef: p.api_key_env || '',
      file,
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function remove({ target, confirmed } = {}, env = process.env) {
  try {
    const { file, doc } = _load(env);
    if (!doc.provider || typeof doc.provider !== 'object') {
      return { success: false, app: APP, error: `provider not found: ${target}` };
    }

    if (!confirmed) {
      return {
        success: true,
        app: APP,
        action: 'remove',
        preview: true,
        confirmed: false,
        target: target || 'api',
        message: `将从 ${APP} 清空 provider 块（连接与模型引用）。回复「确认删除」以执行。`,
      };
    }

    delete doc.provider;
    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    return { success: true, app: APP, action: 'remove', confirmed: true, target: target || 'api', file };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/** 反向读取（khy 消费侧）：返回含 env 引用 key 的可用视图。 */
function _usableView(provider) {
  return {
    id: 'api',
    endpoint: (provider && provider.base_url) || '',
    apiKey: (provider && provider.api_key_env) || '',
    models: provider && provider.model ? [provider.model] : [],
    defaultModel: (provider && provider.model) || '',
  };
}

function usable(env = process.env) {
  try {
    const { doc } = _load(env);
    const provider = doc.provider;
    const providers = provider && typeof provider === 'object' ? [_usableView(provider)] : [];
    return { success: true, app: APP, providers };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

module.exports = { configPath, configDir, list, get, add, remove, usable, envKeyNameForId };
