/**
 * importExternalAppModels — agent-callable tool that REVERSE-uses models already configured in
 * one of six external applications: it READS each app's usable providers (real key + endpoint +
 * models) and REGISTERS them into khy's OWN provider pool, so khy can select and route through
 * them just like the models in codex / claude-code.
 *
 * This is the SANCTIONED with-model execution path for「反向使用 opencode / openclaw /
 * DeepSeek-Reasonix / DeepSeek-TUI / coze-studio / claude-code 里已配置的模型」. It is the inverse
 * of configureExternalApp (which writes providers INTO those apps). It delegates to
 * services/externalApps/appModelImporter, which reads each app's config via the per-app adapters'
 * usable(env), then calls customProviderRegistrar.registerCustomProvider once per provider (writes
 * apiKeyPool + custom_providers.json + route env maps). After import, apiAdapter.listModels() lists
 * `api:<poolKey>:<model>` automatically — no route/gateway changes.
 *
 * Security: the real API key stays in-process (fed straight into registerCustomProvider.keyInput;
 * never shelled out — a key on a command line would leak via history / ps / logs). All tool output
 * is masked (head+tail 4 chars); the full key is never echoed.
 *
 * Sensitivity: 'discover' is read-only. 'import' registers a usable provider into khy (a stateful
 * side effect writing apiKeyPool/custom_providers.json/route env) → risk:'high'. 'unimport'
 * reverses it → isDestructive (unbypassable confirmation). Gate KHY_EXTERNAL_APP_IMPORT: off →
 * tool refuses (byte-fallback, registers nothing).
 */
'use strict';

const { defineTool } = require('../_baseTool');

let _importer = null;
try { _importer = require('../../services/externalApps/appModelImporter'); } catch { /* importer absent → degrade */ }

// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _normApp = require('../../utils/trimLowerCase');

function _resolveAction(input = {}) {
  const a = String(input.action || 'discover').trim().toLowerCase();
  return ['discover', 'import', 'unimport'].includes(a) ? a : 'discover';
}

module.exports = defineTool({
  name: 'importExternalAppModels',
  description:
    '反向使用 6 个外部软件里已配置的模型:读出 opencode / openclaw / DeepSeek-Reasonix / DeepSeek-TUI / coze-studio / claude-code 里可用的 provider(真 key+endpoint+models)并注册进 khy 自己的 provider 池,让 khy 能像用 codex/claude-code 的模型一样选它、调它。action=discover(只读列出可用)、import(注册进 khy,poolKey=`<app>-<provider>`)、unimport(反注册)。密钥全程进程内、绝不回显完整值,输出一律脱敏。',
  category: 'system',
  risk: 'high',
  isReadOnly: (input) => _resolveAction(input || {}) === 'discover',
  isDestructive: (input) => _resolveAction(input || {}) === 'unimport',
  isConcurrencySafe: false,
  shouldDefer: true,
  searchHint: '反向 使用 导入 复用 外部软件 模型 opencode openclaw reasonix deepseek-tui coze claude-code 扣子 discover import unimport 注册进 khy provider 池 像 codex claude-code 一样用 reverse use import external app models into khy',
  maxResultSizeChars: 4000,

  inputSchema: {
    action: { type: 'string', required: false, description: "动作:'discover'(默认,只读列出该 app 可用模型)、'import'(把该 app 可用模型注册进 khy)、'unimport'(反注册一个已导入的模型)" },
    app: { type: 'string', required: false, description: "目标外部软件:'opencode'|'openclaw'|'reasonix'(DeepSeek-Reasonix)|'deepseek-tui'|'coze'(coze-studio)|'claude-code';import/discover 留空且 all=true 时遍历全部" },
    all: { type: 'boolean', required: false, description: 'discover/import 时遍历所有 6 个外部软件(与 app 二选一)' },
    provider: { type: 'string', required: false, description: 'import 时只导入指定 provider id;unimport 时必填(要反注册的 provider)' },
    tier: { type: 'string', required: false, description: 'import 时给注册的 provider 打的层级标签(留空则自动)' },
    dryRun: { type: 'boolean', required: false, description: 'import 时只报告将注册什么、不真注册(预检)' },
    removeKeys: { type: 'boolean', required: false, description: 'unimport 时是否连同 khy 池里该 poolKey 的密钥一并清除(默认 false,保留)' },
  },

  getActivityDescription(input) {
    const action = _resolveAction(input || {});
    const app = _normApp(input && input.app);
    const scope = (input && input.all) ? '所有外部软件' : (app || '外部软件');
    if (action === 'discover') return `发现 ${scope} 里可反向使用的模型(只读)`;
    if (action === 'unimport') return `从 khy 反注册 ${app}-${(input && input.provider) || '?'} 模型${input && input.removeKeys ? '(连密钥一起清)' : ''}`;
    return `把 ${scope} 里可用的模型导入 khy${input && input.dryRun ? '(仅预检)' : ''}`;
  },

  async execute(params = {}) {
    if (!_importer) return { success: false, error: 'appModelImporter 不可用' };
    if (!_importer.isEnabled(process.env)) {
      return { success: false, error: '外部模型导入已被门控关闭（KHY_EXTERNAL_APP_IMPORT）' };
    }
    const action = _resolveAction(params);
    const app = _normApp(params.app);
    try {
      if (action === 'discover') {
        return params.all ? { action, ..._importer.discoverAll(process.env) } : { action, ..._importer.discover(app, process.env) };
      }
      if (action === 'unimport') {
        return { action, ..._importer.unimport({ app, provider: params.provider, removeKeys: params.removeKeys === true }, process.env) };
      }
      // import
      const opts = { app, provider: params.provider, tier: params.tier, dryRun: params.dryRun === true };
      return params.all
        ? { action, ..._importer.importAll({ tier: params.tier, dryRun: params.dryRun === true }, process.env) }
        : { action, ..._importer.importApp(opts, process.env) };
    } catch (err) {
      return { success: false, action, app, error: err && err.message ? err.message : String(err) };
    }
  },
});
