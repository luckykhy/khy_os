/**
 * configureExternalApp — agent-callable tool that configures a model provider into
 * one of six external applications' official config files, directly from a conversation.
 *
 * This is the SANCTIONED with-model execution path for「用自然语言给 opencode/openclaw/
 * DeepSeek-Reasonix/DeepSeek-TUI/coze-studio/claude-code 配置模型」. The agent gathers the
 * app + provider + model + (optional) key/endpoint, restates them with the key REDACTED,
 * and calls this tool. It routes to the per-app adapters under services/externalApps/*,
 * which read the existing config, merge (never full-overwrite), and atomic-write. The API
 * key stays in-process (an adapter writes it; never shelled out — a key on a command line
 * would leak via history / ps / logs). When the NL command omits a key, the adapter reuses
 * khy's stored key for that vendor via apiKeyPool.
 *
 * Sensitivity: writing another app's config (incl. an API key) is a high-risk side effect,
 * so the tool is risk:'high' (drives the human-gate confirmation) and isDestructive on
 * action=remove (unbypassable confirmation). The full key is never echoed — adapters return
 * only masked key output. Gate KHY_EXTERNAL_APP_ACTIONS: off → tool refuses (byte-fallback,
 * writes nothing).
 */
'use strict';

const { defineTool } = require('../_baseTool');

const _ADAPTERS = {
  reasonix: '../../services/externalApps/reasonixAdapter',
  'deepseek-tui': '../../services/externalApps/deepseekTuiAdapter',
  opencode: '../../services/externalApps/opencodeAdapter',
  openclaw: '../../services/externalApps/openclawAdapter',
  coze: '../../services/externalApps/cozeAdapter',
  'claude-code': '../../services/externalApps/claudeCodeAdapter',
};

// 落地动作门控:KHY_EXTERNAL_APP_ACTIONS 默认开,仅 {0,false,off,no} 关。
// 关 → execute 拒绝并回明确说明(逐字节回退:不写任何外部 app 配置)。
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function _actionsEnabled(env = process.env) {
  const raw = env && env.KHY_EXTERNAL_APP_ACTIONS;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _normApp = require('../../utils/trimLowerCase');

function _adapterFor(app) {
  const mod = _ADAPTERS[_normApp(app)];
  if (!mod) return null;
  try { return require(mod); } catch { return null; }
}

function _resolveAction(input = {}) {
  const a = String(input.action || 'add').trim().toLowerCase();
  return ['add', 'remove', 'list', 'get', 'repair'].includes(a) ? a : 'add';
}

module.exports = defineTool({
  name: 'configureExternalApp',
  description:
    '把模型 provider 配置进 6 个外部软件之一的官方配置文件(增删改查 + 修复):opencode / openclaw / DeepSeek-Reasonix / DeepSeek-TUI / coze-studio / claude-code。支持复用 khy 已存的对应厂商密钥或本次显式提供;调用前请先向用户复述配置且把 Key 脱敏,绝不回显完整 Key。action=repair 可修复损坏配置(如 opencode 因 models 形状被写坏导致启动报 Expected object)。',
  category: 'system',
  risk: 'high',
  isReadOnly: (input) => {
    const a = _resolveAction(input || {});
    return a === 'list' || a === 'get';
  },
  isDestructive: (input) => _resolveAction(input || {}) === 'remove',
  isConcurrencySafe: false,
  shouldDefer: true,
  searchHint: '外部软件 配置 模型 opencode openclaw reasonix deepseek-tui coze claude-code 扣子 增删改查 add remove list get repair 修复 修好 配置损坏 Expected object models 形状 启动报错 密钥 api key endpoint provider 模型 configure model external app 给软件配模型 帮我修 opencode 配置',
  maxResultSizeChars: 3000,

  inputSchema: {
    app: { type: 'string', required: true, description: "目标外部软件:'opencode'|'openclaw'|'reasonix'(DeepSeek-Reasonix)|'deepseek-tui'|'coze'(coze-studio)|'claude-code'" },
    action: { type: 'string', required: false, description: "动作:'add'(默认,配置/更新 provider+模型)、'remove'(删除,须 confirmed)、'list'(只读列出)、'get'(只读查详情)、'repair'(修复损坏配置,如 opencode 的 models 形状被写坏导致启动报 Expected object;无损坏则 no-op)" },
    provider: { type: 'string', required: false, description: '厂商 id(如 deepseek/openai/anthropic;add 必填,作为该 app 内的 provider)' },
    model: { type: 'string', required: false, description: '模型 ID(留空则用该厂商 preset 默认模型)' },
    apiKey: { type: 'string', required: false, description: 'API Key(机密,仅进程内使用,绝不回显完整值;留空则复用 khy 已存的该厂商密钥)' },
    endpoint: { type: 'string', required: false, description: 'Base URL(留空则用该厂商 preset 默认 baseUrl)' },
    target: { type: 'string', required: false, description: 'remove/get 的目标 provider id' },
    confirmed: { type: 'boolean', required: false, description: 'action=remove 时须为 true 才真正删除;false/省略 → 仅回删除预览' },
    removeKeys: { type: 'boolean', required: false, description: 'action=remove 时是否连同该 app 存储的密钥一并清除(默认 false,保留可复用)' },
  },

  getActivityDescription(input) {
    const app = _normApp(input && input.app) || '外部软件';
    const action = _resolveAction(input || {});
    if (action === 'list') return `列出 ${app} 已配置的模型(只读)`;
    if (action === 'get') return `查询 ${app} 的 ${input && input.target ? input.target : '模型'} 详情(只读)`;
    if (action === 'repair') return `修复 ${app} 的损坏配置(自动纠正后落盘,无损坏则不动)`;
    if (action === 'remove') {
      const tgt = (input && input.target) || '模型';
      return `从 ${app} 删除 ${tgt}（${input && input.removeKeys ? '连密钥一起删' : '默认保留密钥'}${input && input.confirmed ? '' : '，仅预览'}）`;
    }
    return `给 ${app} 配置 ${input && input.provider ? input.provider : '模型'}（模型 ${input && input.model ? input.model : '默认'}）`;
  },

  async execute(params = {}) {
    if (!_actionsEnabled()) {
      return { success: false, error: '外部软件配置动作已被门控关闭（KHY_EXTERNAL_APP_ACTIONS）' };
    }
    const app = _normApp(params.app);
    const adapter = _adapterFor(app);
    if (!adapter) {
      return { success: false, error: `不支持的外部软件: ${params.app || '(空)'}（支持 opencode/openclaw/reasonix/deepseek-tui/coze/claude-code）` };
    }
    const action = _resolveAction(params);
    try {
      let res;
      if (action === 'list') res = adapter.list(process.env);
      else if (action === 'get') res = adapter.get(params.target, process.env);
      else if (action === 'repair') {
        // repair 目前仅 opencode adapter 支持(其配置 schema 易被写坏)。其余 app 无损坏可修 → 明确回报。
        if (typeof adapter.repair !== 'function') {
          return { success: false, action, app, error: `${app} 暂不支持 repair(该 app 无已知配置损坏形态)` };
        }
        res = adapter.repair(process.env);
      } else if (action === 'remove') {
        res = adapter.remove({ target: params.target, confirmed: params.confirmed === true, removeKeys: params.removeKeys === true }, process.env);
      } else {
        res = adapter.add({ provider: params.provider, model: params.model, apiKey: params.apiKey, endpoint: params.endpoint }, process.env);
      }
      return { action, ...res };
    } catch (err) {
      return { success: false, action, app, error: err && err.message ? err.message : String(err) };
    }
  },
});
