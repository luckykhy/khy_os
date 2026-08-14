'use strict';

/**
 * configureCapability.js — model-callable settings tool ("Configure").
 *
 * Embodies the khyos principle "user is highest authority; natural language
 * drives everything — never tell the user to set an env var or edit a file."
 * When the user asks (in natural language) to turn a capability on/off or
 * change a setting, the model calls THIS tool and khyos performs the change
 * itself, persisting it — instead of replying with "set KHY_xxx yourself".
 *
 * Reuse, not rebuild:
 *  - `services/config/nlConfigResolver` is the single source of truth for the
 *    capability → KHY_* env-key registry and friendly-name resolution.
 *  - `cli/handlers/config._writeEnvPatch` is the single write path: it patches
 *    .env AND mutates process.env in-process, so the change takes effect now
 *    and survives restart (dotenv reloads it at boot).
 *
 * Low risk: this only edits the user's own khyos configuration. Listing is
 * read-only. Auto-registered by the tools/ readdir loader (flat defineTool).
 */

const { defineTool } = require('./_baseTool');
const resolver = require('../services/config/nlConfigResolver');
// Structured-error SSOT for the failure path (gate KHY_CONFIGURE_STRUCTURED_ERROR).
// Best-effort require so a load failure never disables the tool.
let _buildConfigureError;
try { ({ buildConfigureError: _buildConfigureError } = require('./configureErrorShape')); }
catch { _buildConfigureError = null; }

function _writeEnvPatch(envMap, unsetKeys, context) {
  // DI seam for tests; defaults to the canonical persister.
  const fn = (context && typeof context.writeEnvPatch === 'function')
    ? context.writeEnvPatch
    : require('../cli/handlers/config')._writeEnvPatch;
  return fn(envMap, unsetKeys || []);
}

function _renderList() {
  const caps = resolver.describeCapabilities();
  const lines = ['khyos 自然语言可控的能力(说「开启/关闭 + 名称」即可,无需改文件):', ''];
  for (const c of caps) {
    lines.push(`  • ${c.id} — ${c.summary}  [${c.envKey}]`);
  }
  lines.push('', '用法示例:「关闭改动监视」「打开省 token 模式」「enable ground truth」。');
  return lines.join('\n');
}

function _normalizeState(params) {
  // Accepts: state:'on'|'off', or action:'on'|'off', or value (raw).
  const raw = String(params.state || params.action || '').trim().toLowerCase();
  if (raw === 'on' || raw === 'enable' || raw === 'true') return 'on';
  if (raw === 'off' || raw === 'disable' || raw === 'false') return 'off';
  return null;
}

module.exports = defineTool({
  name: 'Configure',
  description:
    'Change a khyos capability/setting on the user\'s behalf and persist it — the user is the ' +
    'highest authority and natural language drives everything, so NEVER tell the user to set an ' +
    'env var or edit a file; call this tool instead. Actions: list (read-only, show controllable ' +
    'capabilities), on/off (toggle a capability by friendly name or KHY_* key), set (raw env value). ' +
    'Changes take effect immediately and persist across restarts.',
  category: 'system',
  risk: 'low',
  aliases: ['configure', 'set-capability', 'capability'],

  // Read-only only when just listing (or no capability + no value given).
  isReadOnly: (input) => {
    if (!input) return true;
    const action = String(input.action || '').trim().toLowerCase();
    if (action === 'list' || action === 'get') return true;
    return !input.capability && !input.value && !input.state;
  },

  inputSchema: {
    action: {
      type: 'string',
      required: false,
      description: "What to do: 'list' (default if no capability), 'on', 'off', or 'set'.",
      enum: ['list', 'get', 'on', 'off', 'set'],
    },
    capability: {
      type: 'string',
      required: false,
      description: 'Capability friendly name/id (e.g. "change-watch", "改动监视") or a raw KHY_* env key.',
      maxLength: 200,
    },
    state: {
      type: 'string',
      required: false,
      description: "Desired state when toggling: 'on' or 'off'.",
      enum: ['on', 'off'],
    },
    value: {
      type: 'string',
      required: false,
      description: 'Raw value when action is "set" (advanced; sets the env key to this exact value).',
      maxLength: 500,
    },
  },

  async execute(params = {}, context = {}) {
    // Accumulate call-site context so a throw with an EMPTY message still yields
    // a contextual structured error (not a bare "Unknown error"). Fields are set
    // as soon as they are resolved below.
    const _errCtx = { action: '', capability: '', envKey: '', target: '' };
    try {
      const action = String(params.action || '').trim().toLowerCase();
      _errCtx.action = action;
      if (params.capability) _errCtx.capability = String(params.capability);

      // List — read-only.
      if (action === 'list' || (!params.capability && !params.value && !action)) {
        return _renderList();
      }

      if (!params.capability) {
        return 'Configure: 请提供 capability(能力名/id 或 KHY_* 键)。用 action="list" 查看全部可控能力。';
      }

      const cap = resolver.findCapability(params.capability);
      const rawKey = /\bKHY_[A-Z0-9_]{2,}\b/.test(params.capability) ? params.capability.match(/\bKHY_[A-Z0-9_]{2,}\b/)[0] : null;
      const envKey = cap ? cap.envKey : rawKey;
      if (!envKey) {
        return `Configure: 未识别的能力「${params.capability}」。用 action="list" 查看可控能力,或直接给出 KHY_* 键。`;
      }
      _errCtx.envKey = envKey;

      let intent;
      if (action === 'set' || (params.value !== undefined && params.value !== null && params.value !== '')) {
        // Raw value set (advanced).
        intent = { kind: 'raw', envKey, value: String(params.value) };
      } else {
        const state = _normalizeState(params);
        if (!state) {
          return 'Configure: 请指定 state="on" 或 state="off"(或 action="on"/"off")。';
        }
        intent = {
          kind: 'toggle',
          capabilityId: cap ? cap.id : null,
          envKey,
          action: state,
          value: state === 'on' ? resolver.ON_VALUE : resolver.OFF_VALUE,
          summary: cap ? cap.summary : envKey,
        };
      }

      const { envMap, unsetKeys } = resolver.buildEnvPatch(intent);
      const writtenPath = _writeEnvPatch(envMap, unsetKeys, context);

      const newValue = envMap[envKey];
      const label = cap ? cap.summary : envKey;
      const actWord = intent.kind === 'raw'
        ? `已设为 ${newValue}`
        : (intent.action === 'on' ? '已开启' : '已关闭');
      return `✅ ${label} ${actWord}(${envKey}=${newValue})。已即时生效并持久化到 ${writtenPath}。`;
    } catch (e) {
      // Structured failure (gate KHY_CONFIGURE_STRUCTURED_ERROR): return a
      // `{success:false, error:{code,message,hint,...}}` shape so the tool loop
      // renders `[ERROR:code] message + Hint` — and message is GUARANTEED
      // non-empty / never a bare "Unknown error". Gate-off / leaf-missing →
      // byte-identical legacy string.
      if (_buildConfigureError) {
        const structured = _buildConfigureError(e, _errCtx, { env: process.env });
        if (structured) return structured;
      }
      return `Configure 执行失败:${e && e.message ? e.message : String(e)}`;
    }
  },
});
