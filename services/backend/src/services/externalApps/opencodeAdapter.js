'use strict';

/**
 * opencodeAdapter — 把模型 provider 增删改查落到 opencode 的 `~/.config/opencode/opencode.json`。
 *
 * opencode 配置形状(实证 opencode-dev):
 *   {
 *     "$schema": "...",
 *     "model": "deepseek/deepseek-v4-flash",              // 顶层默认 "provider/model"
 *     "provider": {
 *       "deepseek": {
 *         "npm": "@ai-sdk/openai-compatible",
 *         "name": "DeepSeek",
 *         "options": { "baseURL": "...", "apiKey": "sk-..." },
 *         "models": { "deepseek-v4-flash": { "name": "DeepSeek V4 Flash" } }
 *       }
 *     }
 *   }
 *
 * 契约(所有 adapter 统一):configPath / list / get / add / remove,fail-soft
 * (任何异常 → {success:false,error}),merge-write(读现配→并入→原子写),
 * remove 带 confirmed 闸门(未确认只回 preview)。密钥经 _shared.resolveApiKey
 * (NL 现给优先,否则复用 khy 已存)。
 */

const path = require('path');
const S = require('./_shared');

const APP = 'opencode';

const _HEAL_OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控 KHY_OPENCODE_CONFIG_HEAL(默认开,仅显式 0/false/off/no 关闭)。
 * 关闭后 _load 不自愈、add 逐字节回退旧「models 是对象就保留」行为。
 */
function _isHealEnabled(env = process.env) {
  const v = (env || process.env || {}).KHY_OPENCODE_CONFIG_HEAL;
  return !(v !== undefined && _HEAL_OFF.has(String(v).trim().toLowerCase()));
}

/**
 * 修正单个 provider 的 `models` 形状,使其满足 opencode schema
 * (`models` 必须是 `modelId -> object` 映射)。历史/损坏形状会被迁移:
 *   - `models.default`(字符串)  → 记为 defaultModelId + 补一个 `{name}` 条目,删 default 键
 *   - `models.list`(字符串数组) → 逐个补 `{name}` 条目,删 list 键
 *   - 其余「值不是对象」的损坏条目 → 保守丢弃
 * 判据:一个条目合法 ⇔ 其值是非 null、非数组的对象;否则视为损坏。
 * 合法形状零改动(字节等价)。绝不抛。
 *
 * @returns {{ changed: boolean, defaultModelId: string }}
 */
function _healProviderModels(p) {
  if (!p || typeof p !== 'object') return { changed: false, defaultModelId: '' };
  const models = p.models;
  if (models === undefined) return { changed: false, defaultModelId: '' };
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    // models 整体不是对象(如被写成数组/字符串)→ 规整为空映射。
    p.models = {};
    return { changed: true, defaultModelId: '' };
  }
  let changed = false;
  let defaultModelId = '';
  for (const key of Object.keys(models)) {
    const v = models[key];
    const isValidEntry = v && typeof v === 'object' && !Array.isArray(v);
    if (isValidEntry) continue;
    if (key === 'default' && typeof v === 'string' && v.trim()) {
      const id = v.trim();
      defaultModelId = id;
      if (!models[id]) models[id] = { name: id };
    } else if (key === 'list' && Array.isArray(v)) {
      for (const m of v) {
        const id = typeof m === 'string' ? m.trim() : '';
        if (id && !models[id]) models[id] = { name: id };
      }
    }
    delete models[key]; // 无论能否迁移,损坏键一律移除(opencode 会因它拒绝整个配置)
    changed = true;
  }
  return { changed, defaultModelId };
}

/**
 * 文档级自愈:逐 provider 修正 models,并在顶层 `model` 缺失/非法时用迁出的
 * defaultModelId 补出 `provider/model`。绝不抛。
 * @returns {{ changed: boolean }}
 */
function _healDoc(doc) {
  if (!doc || typeof doc.provider !== 'object' || doc.provider === null) return { changed: false };
  let changed = false;
  for (const id of Object.keys(doc.provider)) {
    const p = doc.provider[id];
    if (!p || typeof p !== 'object') continue;
    const r = _healProviderModels(p);
    if (r.changed) changed = true;
    if (r.defaultModelId) {
      const cur = typeof doc.model === 'string' ? doc.model.trim() : '';
      if (!cur) { doc.model = `${id}/${r.defaultModelId}`; changed = true; }
    }
  }
  return { changed };
}

/** opencode.json 官方路径(XDG:~/.config/opencode/)。OPENCODE_CONFIG 覆盖。 */
function configPath(env = process.env) {
  if (env && env.OPENCODE_CONFIG) return S.expandHome(env.OPENCODE_CONFIG, env);
  const xdg = (env && env.XDG_CONFIG_HOME) || S.expandHome('~/.config', env);
  return path.join(xdg, 'opencode', 'opencode.json');
}

/** 原始读取(不自愈):供 repair 侦测损坏用。 */
function _loadRaw(env) {
  const file = configPath(env);
  const text = S.readIfExists(file);
  const doc = text ? JSON.parse(text) : {};
  if (!doc.provider || typeof doc.provider !== 'object') doc.provider = {};
  return { file, doc };
}

/** 消费侧读取:门开时对内存视图自愈(list/get/add/remove/usable 皆见干净数据)。 */
function _load(env) {
  const { file, doc } = _loadRaw(env);
  if (_isHealEnabled(env)) _healDoc(doc);
  return { file, doc };
}

function _providerView(id, p) {
  const opts = (p && p.options) || {};
  const models = p && p.models && typeof p.models === 'object' ? Object.keys(p.models) : [];
  return {
    id,
    models,
    endpoint: opts.baseURL || opts.baseUrl || '',
    hasKey: Boolean(opts.apiKey),
  };
}

/** 列出已配置 provider。 */
function list(env = process.env) {
  try {
    const { doc } = _load(env);
    const providers = Object.keys(doc.provider).map((id) => _providerView(id, doc.provider[id]));
    return { success: true, app: APP, providers, model: doc.model || '' };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/** 查单个 provider 详情。 */
function get(target, env = process.env) {
  try {
    const { doc } = _load(env);
    const id = String(target || '').toLowerCase();
    const p = doc.provider[id];
    if (!p) return { success: false, app: APP, error: `provider not found: ${id}` };
    return { success: true, app: APP, provider: _providerView(id, p) };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/** 增/改(upsert,幂等):写 provider.<id>.options + models,并置顶层 model。 */
function add({ provider, model, apiKey, endpoint } = {}, env = process.env) {
  try {
    const id = String(provider || '').toLowerCase();
    if (!id) return { success: false, app: APP, error: 'provider is required' };
    const { file, doc } = _load(env);

    const resolvedKey = S.resolveApiKey(id, apiKey);
    const resolvedEndpoint = S.resolveEndpoint(id, endpoint);
    const resolvedModel = S.resolveModel(id, model);

    const p = doc.provider[id] && typeof doc.provider[id] === 'object' ? doc.provider[id] : {};
    if (!p.npm) p.npm = '@ai-sdk/openai-compatible';
    if (!p.name) p.name = id;
    p.options = p.options && typeof p.options === 'object' ? p.options : {};
    if (resolvedEndpoint) p.options.baseURL = resolvedEndpoint;
    if (resolvedKey.key) p.options.apiKey = resolvedKey.key;
    p.models = p.models && typeof p.models === 'object' ? p.models : {};
    if (resolvedModel && !p.models[resolvedModel]) p.models[resolvedModel] = { name: resolvedModel };
    doc.provider[id] = p;
    if (resolvedModel) doc.model = `${id}/${resolvedModel}`;

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

/** 删(带 confirmed 闸门):未确认只回 preview;确认后从 provider 树移除。 */
function remove({ target, confirmed, removeKeys } = {}, env = process.env) {
  try {
    const id = String(target || '').toLowerCase();
    if (!id) return { success: false, app: APP, error: 'target is required' };
    const { file, doc } = _load(env);
    if (!doc.provider[id]) return { success: false, app: APP, error: `provider not found: ${id}` };

    if (!confirmed) {
      return {
        success: true, app: APP, action: 'remove', preview: true, confirmed: false,
        target: id, willRemoveKeys: Boolean(removeKeys),
        message: `将从 ${APP} 删除 provider「${id}」${removeKeys ? '(连同其 apiKey)' : ''}。回复「确认删除」以执行。`,
      };
    }

    delete doc.provider[id];
    if (doc.model && String(doc.model).startsWith(`${id}/`)) delete doc.model;
    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    return { success: true, app: APP, action: 'remove', confirmed: true, target: id, file };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 反向读取(khy 消费侧):返回**含真 key** 的可用视图,供 appModelImporter 注册进 khy。
 * 与 list 同源、同 _load,仅不脱敏 apiKey(真 key 只在进程内流转,绝不上命令行/日志)。
 */
function _usableView(id, p) {
  const opts = (p && p.options) || {};
  const models = p && p.models && typeof p.models === 'object' ? Object.keys(p.models) : [];
  return {
    id,
    endpoint: opts.baseURL || opts.baseUrl || '',
    apiKey: opts.apiKey || '',
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

/**
 * 修复:侦测并落盘修正损坏的 opencode.json(把内部形状 `models:{default,list}`
 * 迁成 opencode 要求的 `{modelId:{name}}` 映射 + 顶层 `model:"provider/model"`)。
 * 无损坏 → no-op(不落盘)。门 KHY_OPENCODE_CONFIG_HEAL 关闭 → 明确回报 disabled。
 * 这直接根治「opencode.exe 因 Expected object 拒启动、且 khy 之前修不好」的问题。
 */
function repair(env = process.env) {
  try {
    if (!_isHealEnabled(env)) {
      return { success: false, app: APP, action: 'repair', error: 'config heal disabled (KHY_OPENCODE_CONFIG_HEAL=off)' };
    }
    const { file, doc } = _loadRaw(env);
    const before = JSON.stringify(doc);
    const { changed } = _healDoc(doc);
    if (!changed || JSON.stringify(doc) === before) {
      return { success: true, app: APP, action: 'repair', changed: false, file };
    }
    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    const providers = Object.keys(doc.provider).map((id) => _providerView(id, doc.provider[id]));
    return { success: true, app: APP, action: 'repair', changed: true, file, model: doc.model || '', providers };
  } catch (e) {
    return { success: false, app: APP, action: 'repair', error: String((e && e.message) || e) };
  }
}

module.exports = { configPath, list, get, add, remove, usable, repair, _healProviderModels, _healDoc };
