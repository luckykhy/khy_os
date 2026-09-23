'use strict';

/**
 * zcodeAdapter — 把模型 provider 增删改查落到 ZCode 的 `~/.zcode/cli/config.json`。
 *
 * 实证 zcode-app-cli 官方 docs（github.com/kingsword09/zcode-cli，CONFIGURATION.md）：
 *   {
 *     "provider": {
 *       "zai": {
 *         "kind": "anthropic" | "openai-compatible" | "openai",
 *         "name": "显示名（可任意）",
 *         "options": { "apiKeyRequired": true, "baseURL": "...", "apiKey": "<内联>" },
 *         "headers": {},
 *         "models": { "<modelId>": { "name": "..." } }
 *       }
 *     },
 *     "model": { "main": "zai/<modelId>", "lite": "zai/<modelId>" }
 *   }
 *
 * 关键约束（上游 CLI 0.15.x 登录门）：
 *   - 直连 API key 仅当它存在于 provider 槽位 `zai` 或 `bigmodel` 下才算「已配置」，
 *     其它任意 provider id 仍会触发登录向导 → khy 一律写 `zai` 槽位（可用 slot 参数
 *     切 `bigmodel`），显示名/端点/模型目录全部可自定义。
 *   - 无登录路径要求 `options.apiKey` 非空且**内联**——env 引用不满足登录门，因此本
 *     adapter 与 command-code/ycode 的「只写 env 引用」策略不同：key 会落入配置文件。
 *     缓解：中继模式下写入的是 khy 网关单令牌（可吊销、低敏感），上游真 key 留在
 *     khy 密钥池；写盘后 POSIX 收敛到 0600（Windows 保持继承 ACL，best-effort）。
 *   - 既有 CLI 侧同槽位 apiKey 总是保留（zcode 官方语义），khy 仅在自己提供 key 时覆盖。
 *
 * 密钥策略：add 时带 key → 内联写入；不带 key → 仍写端点/模型并返回 warning（zcode
 * 首启要求登录补齐），绝不丢既有内联 key。
 *
 * 契约同其它 adapter：configPath / list / get / add / remove / usable，fail-soft
 * （任何异常 → {success:false,error}），merge-write（只动 provider.<slot> 与 model
 * 角色块，保留 ui/modelStream/subagents 等其余配置），remove 带 confirmed 闸门。
 *
 * 配置位置：`~/.zcode/cli/config.json`（Windows 即 %USERPROFILE%\.zcode\cli\），
 * 可用 ZCODE_CLI_CONFIG_FILE 覆盖到任意路径（测试/便携布局）。
 */

const os = require('os');
const path = require('path');

const S = require('./_shared');

const APP = 'zcode';

// 登录门认可的 provider 槽位（上游 CLI 0.15.x 行为，见文件头实证链接）。
const GATE_SLOTS = Object.freeze(['zai', 'bigmodel']);
const DEFAULT_SLOT = 'zai';

/** ZCode 运行时支持的 wire kind（kinds 之外的卡片协议需在 khy 代理侧先转换）。 */
const KINDS = Object.freeze(['anthropic', 'openai-compatible', 'openai']);

/** 由卡片协议解析 kind：anthropic → anthropic；openai / openai_responses → openai-compatible。 */
function kindForProtocol(protocol) {
  switch (String(protocol || '').toLowerCase()) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'openai_responses':
      return 'openai-compatible';
    default:
      return 'anthropic';
  }
}

/** 配置路径：ZCODE_CLI_CONFIG_FILE 优先，否则 ~/.zcode/cli/config.json。 */
function configPath(env = process.env) {
  if (env && env.ZCODE_CLI_CONFIG_FILE) {
    return S.expandHome(env.ZCODE_CLI_CONFIG_FILE, env);
  }
  return path.join(S.expandHome('~', env), '.zcode', 'cli', 'config.json');
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

/** 规范化模型引用：`khy/gpt-4o` → modelId `gpt-4o`（zcode 用 slot/modelId 引用）。 */
function _modelIdOf(model) {
  const s = String(model || '').trim();
  if (!s) {
    return '';
  }
  return s.includes('/') ? s.split('/').slice(1).join('/') : s;
}

function _providerView(id, p) {
  const opts = (p && p.options) || {};
  const models = p && p.models && typeof p.models === 'object' ? Object.keys(p.models) : [];
  return {
    id,
    kind: (p && p.kind) || '',
    name: (p && p.name) || '',
    endpoint: opts.baseURL || opts.baseUrl || '',
    hasKey: Boolean(opts.apiKey),
    models,
    isGateSlot: GATE_SLOTS.includes(id),
  };
}

/** 列出已配置 provider（含 zai/bigmodel 槽位标记与 model 角色）。 */
function list(env = process.env) {
  try {
    const { doc } = _load(env);
    const providers = Object.keys(doc.provider).map((id) => _providerView(id, doc.provider[id]));
    const roles = (doc.model && typeof doc.model === 'object') ? doc.model : {};
    return {
      success: true,
      app: APP,
      providers,
      model: { main: roles.main || '', lite: roles.lite || '' },
    };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

function get(target, env = process.env) {
  try {
    const { doc } = _load(env);
    const slot = String(target || '').trim();
    const p = doc.provider[slot];
    if (!p || typeof p !== 'object') {
      return { success: false, app: APP, error: `provider slot not found: ${slot}` };
    }
    return { success: true, app: APP, provider: _providerView(slot, p) };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/**
 * 增/改（upsert，幂等）：把 ZCode 的 `provider.<slot>` 指向卡片端点 + 模型，
 * 并把 `model.main` / `model.lite` 双角色指到该槽位。
 *
 * @param {object} opts
 * @param {string} [opts.slot]     provider 槽位，默认 `zai`（登录门槽位）
 * @param {string} [opts.provider] 卡片显示名（写入 provider.<slot>.name）
 * @param {string} [opts.model]    模型引用（可含 `provider/model` 前缀，自动取 modelId）
 * @param {string} [opts.liteModel] 轻量角色模型（缺省同 model）
 * @param {string} [opts.apiKey]   内联 key（zcode 登录门要求非空；缺省保留既有）
 * @param {string} [opts.endpoint] baseURL
 * @param {string} [opts.kind]     wire kind；缺省由 protocol 推导
 * @param {string} [opts.protocol] 卡片协议（openai/anthropic/openai_responses）
 */
function add({ provider, model, liteModel, apiKey, endpoint, kind, protocol, slot } = {}, env = process.env) {
  try {
    const resolvedSlot = String(slot || DEFAULT_SLOT).trim() || DEFAULT_SLOT;
    if (!GATE_SLOTS.includes(resolvedSlot)) {
      return {
        success: false,
        app: APP,
        error: `provider 槽位「${resolvedSlot}」不满足 zcode 登录门（仅 ${GATE_SLOTS.join(' / ')} 认可内联 key），拒绝写入`,
      };
    }
    const resolvedKind = kind || kindForProtocol(protocol);
    if (!KINDS.includes(resolvedKind)) {
      return { success: false, app: APP, error: `不支持的 wire kind「${resolvedKind}」（支持 ${KINDS.join(' / ')}）` };
    }

    const { file, doc } = _load(env);
    const modelId = _modelIdOf(model);
    const liteId = _modelIdOf(liteModel || model);

    const p = doc.provider[resolvedSlot] && typeof doc.provider[resolvedSlot] === 'object'
      ? doc.provider[resolvedSlot]
      : {};
    p.kind = resolvedKind;
    if (provider) {
      p.name = String(provider);
    } else if (!p.name) {
      p.name = resolvedSlot;
    }
    p.options = p.options && typeof p.options === 'object' ? p.options : {};
    if (endpoint) {
      p.options.baseURL = endpoint;
    }
    p.options.apiKeyRequired = true;
    let keyWritten = false;
    if (apiKey) {
      p.options.apiKey = String(apiKey);
      keyWritten = true;
    }
    p.models = p.models && typeof p.models === 'object' ? p.models : {};
    if (modelId && !p.models[modelId]) {
      p.models[modelId] = { name: modelId };
    }
    doc.provider[resolvedSlot] = p;

    if (modelId) {
      doc.model = {
        main: `${resolvedSlot}/${modelId}`,
        lite: liteId ? `${resolvedSlot}/${liteId}` : `${resolvedSlot}/${modelId}`,
      };
    }

    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    _lockDown(file);

    const result = {
      success: true,
      app: APP,
      action: 'add',
      slot: resolvedSlot,
      kind: resolvedKind,
      model: modelId || '',
      endpoint: endpoint || '',
      keyWritten,
      keyMasked: S.maskKey(apiKey || ''),
      file,
    };
    if (!keyWritten && !apiKey) {
      result.warning = '未提供密钥：zcode 无登录路径要求 options.apiKey 非空（内联），首启将提示登录补齐；既有内联 key（若有）保持不变';
    }
    return result;
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/** 删（带 confirmed 闸门）：未确认只回 preview；确认后移除槽位并清理指向它的 model 角色。 */
function remove({ target, confirmed, slot } = {}, env = process.env) {
  try {
    const resolvedSlot = String(target || slot || DEFAULT_SLOT).trim() || DEFAULT_SLOT;
    const { file, doc } = _load(env);
    if (!doc.provider[resolvedSlot]) {
      return { success: false, app: APP, error: `provider slot not found: ${resolvedSlot}` };
    }

    if (!confirmed) {
      return {
        success: true,
        app: APP,
        action: 'remove',
        preview: true,
        confirmed: false,
        target: resolvedSlot,
        message: `将从 ${APP} 删除 provider 槽位「${resolvedSlot}」及其 model 角色引用。回复「确认删除」以执行。`,
      };
    }

    delete doc.provider[resolvedSlot];
    if (doc.model && typeof doc.model === 'object') {
      for (const role of ['main', 'lite']) {
        if (String(doc.model[role] || '').startsWith(`${resolvedSlot}/`)) {
          delete doc.model[role];
        }
      }
    }
    S.atomicWrite(file, `${JSON.stringify(doc, null, 2)}\n`);
    return { success: true, app: APP, action: 'remove', confirmed: true, target: resolvedSlot, file };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/** 反向读取（khy 消费侧）：含内联 key 的可用视图（key 仅进程内流转，绝不上命令行/日志）。 */
function _usableView(id, p) {
  const view = _providerView(id, p);
  return {
    ...view,
    apiKey: ((p && p.options) || {}).apiKey || '',
  };
}

function usable(env = process.env) {
  try {
    const { doc } = _load(env);
    const providers = Object.keys(doc.provider)
      .filter((id) => doc.provider[id] && ((doc.provider[id].options || {}).apiKey || '').length > 0)
      .map((id) => _usableView(id, doc.provider[id]));
    return { success: true, app: APP, providers };
  } catch (e) {
    return { success: false, app: APP, error: String((e && e.message) || e) };
  }
}

/** 密钥明文落盘（登录门所限）→ POSIX 收敛 0600；Windows 无 chmod 语义，静默跳过。 */
function _lockDown(file) {
  try {
    if (process.platform !== 'win32') {
      require('fs').chmodSync(file, 0o600);
    }
  } catch {
    /* best-effort: Windows 继承 ACL，不视为失败 */
  }
}

module.exports = { configPath, list, get, add, remove, usable, GATE_SLOTS, KINDS, kindForProtocol };
