'use strict';

/**
 * ccSwitch appWriters — per-app live-config writers.
 *
 * Maps each supported external app to the concrete config file it reads at
 * startup and rewrites it (atomically, preserving unrelated content) to point
 * the app at a selected provider card. This is the "正门" for state changes
 * (AGENTS.md 通道选择: 写必走正门) — nothing here mutates the store; the store
 * only records which card is active after a successful write.
 *
 * Apps:
 *   claude-code → ~/.claude/settings.json env block (claudeCodeAdapter.add)
 *   codex       → ~/.codex/config.toml + auth.json (config-only bearer token,
 *                 mirroring cc-switch v3.20.1 — key goes into the provider's
 *                 own [model_providers.*] table, NOT auth.json)
 *   opencode    → ~/.config/opencode/opencode.json provider tree
 *   gemini      → ~/.gemini/settings.json env block
 *   deepseek    → ~/.deepseek/config.toml (deepseekTuiAdapter)
 *   reasonix    → ~/.reasonix/config.toml + .env (reasonixAdapter)
 *   command-code→ ~/.commandcode/providers.json BYOK 表 + config.json 默认模型
 *                 (key 只写 env 引用 $KHY_CC_SWITCH_<ID>_KEY，官方拒绝裸密钥)
 *   ycode       → .ycode/config.json provider 块 (key 只写 api_key_env 引用)
 *
 * Fail-soft: every app writer returns { success, ... } — never throws.
 */

const { APPS, PROTOCOLS } = require('./constants');
const claudeCodeAdapter = require('../externalApps/claudeCodeAdapter');
const opencodeAdapter = require('../externalApps/opencodeAdapter');
const geminiCliAdapter = require('../externalApps/geminiCliAdapter');
const commandCodeAdapter = require('../externalApps/commandCodeAdapter');
const ycodeAdapter = require('../externalApps/ycodeAdapter');

/**
 * Preflight a card for an app: return a human-readable verdict on whether the
 * switch is safe BEFORE moving the live config (mirrors cc-switch's write
 * pre-check — reject by name instead of "switch succeeded" then the app fails).
 *
 * @param {object} card
 * @param {string} app
 * @returns {{ ok: boolean, reason?: string }}
 */
function preflightCardForApp(card, app) {
  if (!card || !card.name) {
    return { ok: false, reason: '卡片无效（缺少名称）' };
  }
  if (!card.baseUrl) {
    return { ok: false, reason: '卡片缺少 baseUrl，无法切换' };
  }
  if (app === APPS.CLAUDE_CODE) {
    // Claude Code expects an Anthropic-wire endpoint. OpenAI-compatible cards
    // are still usable through the khy proxy (which converts), so only warn.
    if (card.protocol === PROTOCOLS.OPENAI) {
      return {
        ok: true,
        reason: '卡片为 OpenAI 协议，Claude Code 需经 khy 代理转换（ANTHROPIC_BASE_URL 指向本地代理）',
      };
    }
    return { ok: true };
  }
  if (app === APPS.CODEX) {
    if (![PROTOCOLS.OPENAI, PROTOCOLS.RESPONSES].includes(card.protocol)) {
      return { ok: false, reason: 'Codex 仅支持 OpenAI 兼容协议（openai / openai_responses）' };
    }
    return { ok: true };
  }
  if (app === APPS.OPENCODE) {
    if (![PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC].includes(card.protocol)) {
      return { ok: false, reason: 'OpenCode 支持 openai / anthropic 协议' };
    }
    return { ok: true };
  }
  if (app === APPS.COMMAND_CODE) {
    // Command Code BYOK supports openai-completions and anthropic-messages wires.
    if (![PROTOCOLS.OPENAI, PROTOCOLS.ANTHROPIC, PROTOCOLS.RESPONSES].includes(card.protocol)) {
      return { ok: false, reason: 'Command Code BYOK 支持 openai / anthropic 协议' };
    }
    return { ok: true };
  }
  if (app === APPS.YCODE) {
    // YCode's hosted-API connection is OpenAI-compatible only.
    if (![PROTOCOLS.OPENAI, PROTOCOLS.RESPONSES].includes(card.protocol)) {
      return { ok: false, reason: 'YCode api 连接仅支持 OpenAI 兼容协议（openai / openai_responses）' };
    }
    return { ok: true };
  }
  return { ok: true };
}

/**
 * Apply a card to an app's live config. On success the caller (CLI/UI) records
 * the active card in the store — this function itself never mutates the store.
 *
 * @param {object} card  normalized card from the store
 * @param {string} app   one of APPS.*
 * @param {{ store?: object, key?: string, proxyBaseUrl?: string, proxyToken?: string }} opts
 * @returns {Promise<{ success: boolean, app: string, error?: string, detail?: object }>}
 */
async function applyCardToApp(card, app, opts = {}) {
  const pre = preflightCardForApp(card, app);
  if (!pre.ok) {
    return { success: false, app, error: pre.reason };
  }

  const key = opts.key || (opts.store && opts.store.getCardCredential ? opts.store.getCardCredential(card.id) : null) || '';
  const defaultModel = card.defaultModel || '';

  try {
    switch (app) {
      case APPS.CLAUDE_CODE: {
        // Write via the canonical adapter; pass explicit endpoint/key/model so
        // preset fallback never injects an unrelated provider.
        const result = claudeCodeAdapter.add({
          provider: card.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: card.baseUrl,
        });
        return { success: result.success, app, error: result.error, detail: result };
      }
      case APPS.CODEX: {
        const { setCodexUpstreamConfigOnly } = require('./codexWriter');
        const result = setCodexUpstreamConfigOnly({
          providerName: card.name,
          baseUrl: card.baseUrl,
          model: defaultModel,
          apiKey: key || undefined,
          wireApi: card.wireApi || (card.protocol === PROTOCOLS.RESPONSES ? 'responses' : 'chat'),
          requiresOpenaiAuth: card.requiresOpenaiAuth === true,
        });
        return { success: true, app, error: result.error, detail: result };
      }
      case APPS.OPENCODE: {
        const result = opencodeAdapter.add({
          provider: card.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: card.baseUrl,
        });
        return { success: result.success, app, error: result.error, detail: result };
      }
      case APPS.GEMINI: {
        const result = geminiCliAdapter.add({
          provider: card.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: card.baseUrl,
        });
        return { success: result.success, app, error: result.error, detail: result };
      }
      case APPS.COMMAND_CODE: {
        const result = commandCodeAdapter.add({
          provider: card.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: card.baseUrl,
          protocol: card.protocol,
          wireApi: card.wireApi,
        });
        return { success: result.success, app, error: result.error, detail: result };
      }
      case APPS.YCODE: {
        const result = ycodeAdapter.add({
          provider: card.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
          model: defaultModel,
          apiKey: key || undefined,
          endpoint: card.baseUrl,
          connection: 'api',
        });
        return { success: result.success, app, error: result.error, detail: result };
      }
      default:
        return { success: false, app, error: `暂不支持把卡片写到应用: ${app}` };
    }
  } catch (e) {
    return { success: false, app, error: String((e && e.message) || e) };
  }
}

/**
 * Read back which provider a card maps to in each app's live config (reverse
 * direction — used by `khy cc-switch status` to reconcile detected state).
 *
 * @param {string} app
 * @returns {{ success: boolean, providers: Array<{id:string,endpoint:string,hasKey:boolean,models:string[]}> }}
 */
function detectCardInApp(app) {
  try {
    switch (app) {
      case APPS.CLAUDE_CODE:
        return claudeCodeAdapter.list();
      case APPS.CODEX: {
        const { getCodexUpstreamSnapshot } = require('../gateway/adapters/codexAdapter');
        const snap = getCodexUpstreamSnapshot();
        return {
          success: true,
          providers: snap.provider
            ? [
                {
                  id: snap.provider,
                  endpoint: snap.baseUrl || '',
                  hasKey: snap.hasApiKey,
                  models: snap.model ? [snap.model] : [],
                },
              ]
            : [],
        };
      }
      case APPS.OPENCODE:
        return opencodeAdapter.list();
      case APPS.GEMINI:
        return geminiCliAdapter.list();
      case APPS.COMMAND_CODE:
        return commandCodeAdapter.list();
      case APPS.YCODE:
        return ycodeAdapter.list();
      default:
        return { success: false, providers: [], error: `不支持的应用: ${app}` };
    }
  } catch (e) {
    return { success: false, providers: [], error: String((e && e.message) || e) };
  }
}

module.exports = { applyCardToApp, preflightCardForApp, detectCardInApp };
