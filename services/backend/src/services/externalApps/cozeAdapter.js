'use strict';

/**
 * cozeAdapter — 把模型 provider 增删改查落到 coze-studio 的 `backend/conf/model/` 下
 * 每模型一个 `model_template_<id>.yaml`(实证 coze-studio-main)。
 *
 * 与其它 5 个 app 不同:coze 官方配置目录是**项目内**(非用户 home),故首版按
 *   1) 用户显式给的项目根(COZE_HOME / COZE_MODEL_DIR),或
 *   2) 探测已解压目录(此处只认显式环境变量,不猜文件系统)
 * 定位;无法定位时降级为返回可写入的 YAML 文本让用户自行放置(fail-soft,不猜路径)。
 *
 * 单个模板 YAML 形状:
 *   id: 100001
 *   name: deepseek-v4-flash
 *   meta:
 *     protocol: openai
 *     conn_config:
 *       base_url: "https://api.deepseek.com"
 *       api_key:  "sk-..."
 *       model:    "deepseek-v4-flash"
 *
 * 契约同其它 adapter:configPath / list / get / add / remove,fail-soft,merge-write
 * (一模型一文件,增改就是 upsert 该文件),remove 带 confirmed 闸门。YAML 经 js-yaml。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const S = require('./_shared');

const APP = 'coze';

/** 返回 model 模板目录(可能为 null:未指明项目根)。 */
function _modelDir(env = process.env) {
  if (env && env.COZE_MODEL_DIR) return S.expandHome(env.COZE_MODEL_DIR, env);
  if (env && env.COZE_HOME) return path.join(S.expandHome(env.COZE_HOME, env), 'backend', 'conf', 'model');
  return null;
}

/** configPath 语义在 coze 上是模板目录(供上层显示定位结果)。 */
function configPath(env = process.env) {
  return _modelDir(env) || '';
}

/** 由 provider/model 生成模板文件名(确定性,便于 upsert/删除定位)。 */
function _templateName(id) {
  return `model_template_${String(id).replace(/[^A-Za-z0-9._-]+/g, '_')}.yaml`;
}

/** 列目录下所有 model_template_*.yaml → provider 视图(coze 无 provider 层,以 name 为单元)。 */
function list(env = process.env) {
  try {
    const dir = _modelDir(env);
    if (!dir || !fs.existsSync(dir)) {
      return { success: true, app: APP, providers: [], model: '', note: dir ? '' : 'coze 项目根未指明(设 COZE_HOME 或 COZE_MODEL_DIR)' };
    }
    const files = fs.readdirSync(dir).filter((f) => /^model_template_.*\.ya?ml$/.test(f));
    const providers = [];
    for (const f of files) {
      const doc = yaml.load(S.readIfExists(path.join(dir, f))) || {};
      const cc = (doc.meta && doc.meta.conn_config) || {};
      providers.push({
        id: doc.name || f,
        models: cc.model ? [cc.model] : [],
        endpoint: cc.base_url || '',
        hasKey: Boolean(cc.api_key),
      });
    }
    return { success: true, app: APP, providers, model: '' };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function get(target, env = process.env) {
  try {
    const dir = _modelDir(env);
    const id = String(target || '').toLowerCase();
    if (!dir) return { success: false, app: APP, error: 'coze 项目根未指明' };
    const file = path.join(dir, _templateName(id));
    const text = S.readIfExists(file);
    if (text == null) return { success: false, app: APP, error: `template not found: ${id}` };
    const doc = yaml.load(text) || {};
    const cc = (doc.meta && doc.meta.conn_config) || {};
    return {
      success: true, app: APP,
      provider: { id: doc.name || id, models: cc.model ? [cc.model] : [], endpoint: cc.base_url || '', hasKey: Boolean(cc.api_key) },
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/** 构造模板 YAML 文本(供落地或降级回传)。 */
function _buildTemplate({ id, provider, model, apiKey, endpoint }) {
  const doc = {
    id,
    name: model || provider,
    meta: {
      protocol: 'openai',
      conn_config: {
        base_url: endpoint || '',
        api_key: apiKey || '',
        model: model || '',
      },
    },
  };
  return yaml.dump(doc, { lineWidth: -1 });
}

function add({ provider, model, apiKey, endpoint } = {}, env = process.env) {
  try {
    const id = String(provider || model || '').toLowerCase();
    if (!id) return { success: false, app: APP, error: 'provider or model is required' };

    const resolvedKey = S.resolveApiKey(provider, apiKey);
    const resolvedEndpoint = S.resolveEndpoint(provider, endpoint);
    const resolvedModel = S.resolveModel(provider, model);
    const templateName = _templateName(resolvedModel || id);

    const dir = _modelDir(env);
    // 无项目根 → 降级:回传可写入 YAML,不猜路径落盘。
    if (!dir) {
      const yamlText = _buildTemplate({
        id: 100001, provider, model: resolvedModel, apiKey: resolvedKey.key, endpoint: resolvedEndpoint,
      });
      return {
        success: true, app: APP, action: 'add', degraded: true, provider: id,
        model: resolvedModel, endpoint: resolvedEndpoint, keySource: resolvedKey.source,
        keyMasked: S.maskKey(resolvedKey.key), suggestedFile: templateName, yaml: yamlText,
        note: 'coze 项目根未指明:请将以下 YAML 存到 backend/conf/model/(或设 COZE_HOME 后重试落盘)',
      };
    }

    const file = path.join(dir, templateName);
    // merge:已存则保留原 id,只更新 conn_config。
    const existing = S.readIfExists(file);
    const doc = existing ? (yaml.load(existing) || {}) : {};
    doc.id = doc.id || 100001;
    doc.name = resolvedModel || provider || doc.name;
    doc.meta = doc.meta && typeof doc.meta === 'object' ? doc.meta : {};
    if (!doc.meta.protocol) doc.meta.protocol = 'openai';
    doc.meta.conn_config = doc.meta.conn_config && typeof doc.meta.conn_config === 'object' ? doc.meta.conn_config : {};
    if (resolvedEndpoint) doc.meta.conn_config.base_url = resolvedEndpoint;
    if (resolvedKey.key) doc.meta.conn_config.api_key = resolvedKey.key;
    if (resolvedModel) doc.meta.conn_config.model = resolvedModel;

    S.atomicWrite(file, yaml.dump(doc, { lineWidth: -1 }));
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
    const dir = _modelDir(env);
    if (!dir) return { success: false, app: APP, error: 'coze 项目根未指明' };
    const file = path.join(dir, _templateName(id));
    if (!fs.existsSync(file)) return { success: false, app: APP, error: `template not found: ${id}` };

    if (!confirmed) {
      return {
        success: true, app: APP, action: 'remove', preview: true, confirmed: false, target: id,
        message: `将删除 ${APP} 模板文件「${_templateName(id)}」。回复「确认删除」以执行。`,
      };
    }

    fs.unlinkSync(file);
    return { success: true, app: APP, action: 'remove', confirmed: true, target: id, file };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 反向读取(khy 消费侧):返回**含真 key** 的可用视图(key 为 yaml meta.conn_config.api_key)。
 * 与 list 同源(遍历 model_template_*.yaml),仅不脱敏 apiKey。无项目根 → 空 providers。
 * coze 无 provider 层,以模板的 name/model 为单元。
 */
function usable(env = process.env) {
  try {
    const dir = _modelDir(env);
    if (!dir || !fs.existsSync(dir)) return { success: true, app: APP, providers: [] };
    const files = fs.readdirSync(dir).filter((f) => /^model_template_.*\.ya?ml$/.test(f));
    const providers = [];
    for (const f of files) {
      const doc = yaml.load(S.readIfExists(path.join(dir, f))) || {};
      const cc = (doc.meta && doc.meta.conn_config) || {};
      const models = cc.model ? [cc.model] : [];
      providers.push({
        id: doc.name || f,
        endpoint: cc.base_url || '',
        apiKey: cc.api_key || '',
        models,
        defaultModel: cc.model || models[0] || '',
      });
    }
    return { success: true, app: APP, providers };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

module.exports = { configPath, list, get, add, remove, usable };
