'use strict';

/**
 * geminiCliAdapter — 把模型 provider 增删改查落到 Gemini CLI 的
 * `~/.gemini/settings.json`（实证 gemini-cli 配置形状）。
 *
 * gemini-cli 读取 settings.json 的 `env` 块（与 claude-code 同构）：
 *   {
 *     "env": {
 *       "GEMINI_API_KEY": "...",
 *       "GOOGLE_GENAI_API_KEY": "...",
 *       "GOOGLE_GENAI_API_URL": "...",     // 或 GOOGLE_GENAI_BASE_URL
 *       "GOOGLE_GENAI_MODEL": "gemini-2.5-pro"
 *     }
 *   }
 *
 * 契约同其它 adapter：configPath / list / get / add / remove，fail-soft
 * （任何异常 → {success:false,error}），merge-write（只动目标键，保留其余）。
 */

const path = require('path');

const S = require('./_shared');

const APP = 'gemini';

/** ~/.gemini/settings.json（GEMINI_CONFIG_DIR 覆盖目录）。 */
function configPath(env = process.env) {
  const dir =
    env && env.GEMINI_CONFIG_DIR ? S.expandHome(env.GEMINI_CONFIG_DIR, env) : S.expandHome('~/.gemini', env);
  return path.join(dir, 'settings.json');
}

function _load(env) {
  const file = configPath(env);
  const text = S.readIfExists(file);
  const doc = text ? JSON.parse(text) : {};
  if (!doc.env || typeof doc.env !== 'object') {
    doc.env = {};
  }
  return { file, doc };
}

/** 从 env 块反推已配置的 provider 集合（凡有 <P>_API_KEY / <P>_BASE_URL 即算）。 */
function _providersFromEnv(envBlock) {
  const ids = new Set();
  for (const k of Object.keys(envBlock)) {
    const m = k.match(/^([A-Z0-9]+)_(?:API_KEY|BASE_URL)$/);
    if (m) {
      ids.add(m[1].toLowerCase());
    }
  }
  return [...ids];
}

/** 凭据：优先 GEMINI_API_KEY，否则 GOOGLE_GENAI_API_KEY。 */
function _credential(envBlock, id) {
  return (
    envBlock.GEMINI_API_KEY ||
    envBlock.GOOGLE_GENAI_API_KEY ||
    envBlock[`${String(id).toUpperCase()}_API_KEY`] ||
    ''
  );
}

function _providerView(id, envBlock) {
  const urlName = S.envKeyName(id, 'BASE_URL');
  return {
    id,
    models: envBlock.GOOGLE_GENAI_MODEL ? [envBlock.GOOGLE_GENAI_MODEL] : [],
    endpoint: envBlock[urlName] || envBlock.GOOGLE_GENAI_API_URL || envBlock.GOOGLE_GENAI_BASE_URL || '',
    hasKey: Boolean(_credential(envBlock, id)),
  };
}

function list(env = process.env) {
  try {
    const { doc } = _load(env);
    const providers = _providersFromEnv(doc.env).map((id) => _providerView(id, doc.env));
    return { success: true, app: APP, providers, model: doc.env.GOOGLE_GENAI_MODEL || '' };
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

/**
 * 增/改（upsert，幂等）：写 provider 相关 env 键 + 当前默认模型键。
 * gemini 的凭据键是 GEMINI_API_KEY / GOOGLE_GENAI_API_KEY，不按 provider 名分键，
 * 但 endpoint 按 provider 名分键（<P>_BASE_URL），便于多 provider 并存。
 */
function add({ provider, model, apiKey, endpoint } = {}, env = process.env) {
  try {
    const id = String(provider || '').toLowerCase();
    if (!id) {
      return { success: false, app: APP, error: 'provider is required' };
    }
    const { file, doc } = _load(env);

    const resolvedKey = S.resolveApiKey(id, apiKey);
    const resolvedEndpoint = S.resolveEndpoint(id, endpoint);
    const resolvedModel = S.resolveModel(id, model);

    if (resolvedKey.key) {
      doc.env.GEMINI_API_KEY = resolvedKey.key;
      doc.env.GOOGLE_GENAI_API_KEY = resolvedKey.key;
    }
    if (resolvedEndpoint) {
      doc.env[S.envKeyName(id, 'BASE_URL')] = resolvedEndpoint;
      doc.env.GOOGLE_GENAI_API_URL = resolvedEndpoint;
    }
    if (resolvedModel) {
      doc.env.GOOGLE_GENAI_MODEL = resolvedModel;
    }

    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    return {
      success: true,
      app: APP,
      action: 'add',
      provider: id,
      model: resolvedModel,
      endpoint: resolvedEndpoint,
      keySource: resolvedKey.source,
      keyMasked: S.maskKey(resolvedKey.key),
      file,
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function remove({ target, confirmed, removeKeys } = {}, env = process.env) {
  try {
    const id = String(target || '').toLowerCase();
    if (!id) {
      return { success: false, app: APP, error: 'target is required' };
    }
    const { file, doc } = _load(env);
    const keyName = S.envKeyName(id);
    const urlName = S.envKeyName(id, 'BASE_URL');
    if (!doc.env[keyName] && !doc.env[urlName]) {
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
        willRemoveKeys: Boolean(removeKeys),
        message: `将从 ${APP} 的 settings.json env 块删除 provider「${id}」的 BASE_URL${removeKeys ? ' 与 API_KEY' : ''}。回复「确认删除」以执行。`,
      };
    }

    delete doc.env[urlName];
    if (doc.env[urlName] === doc.env.GOOGLE_GENAI_API_URL) {
      delete doc.env.GOOGLE_GENAI_API_URL;
    }
    let keyRemoved = false;
    if (removeKeys) {
      // 仅当没有其它 provider 使用 GEMINI_API_KEY 时才删除共享凭据键。
      const stillUsed = Object.keys(doc.env).some((k) => {
        if (k === 'GEMINI_API_KEY' || k === 'GOOGLE_GENAI_API_KEY') {
          return false;
        }
        return false;
      });
      if (!stillUsed) {
        if (doc.env.GEMINI_API_KEY !== undefined) {
          delete doc.env.GEMINI_API_KEY;
          keyRemoved = true;
        }
        if (doc.env.GOOGLE_GENAI_API_KEY !== undefined) {
          delete doc.env.GOOGLE_GENAI_API_KEY;
        }
      }
    }
    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    return {
      success: true,
      app: APP,
      action: 'remove',
      confirmed: true,
      target: id,
      keyRemoved,
      file,
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/** 反向读取（khy 消费侧）：返回含真 key 的可用视图。 */
function _usableView(id, envBlock) {
  const urlName = S.envKeyName(id, 'BASE_URL');
  const models = envBlock.GOOGLE_GENAI_MODEL ? [envBlock.GOOGLE_GENAI_MODEL] : [];
  return {
    id,
    endpoint: envBlock[urlName] || envBlock.GOOGLE_GENAI_API_URL || '',
    apiKey: _credential(envBlock, id) || '',
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
