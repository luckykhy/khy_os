'use strict';

/**
 * ccSwitch constants — CC-Switch-style provider-card subsystem.
 *
 * Single source of truth for:
 *   - Supported external apps (tools) that can be pointed at a card
 *   - Card protocols (wire formats each tool speaks)
 *   - The data file name + schema version
 *
 * The store lives in services/ccSwitch/store.js; CLI surface in
 * cli/handlers/ccSwitch.js; live-config writers in services/externalApps/*
 * (claudeCodeAdapter / codexAdapter / opencodeAdapter / geminiCliAdapter).
 */

// Wire protocol a card speaks to ITS upstream. The khy proxy converts between
// the tool's inbound protocol and this outbound protocol via protocolConverter.
const PROTOCOLS = Object.freeze({
  OPENAI: 'openai', // /v1/chat/completions
  ANTHROPIC: 'anthropic', // /v1/messages
  RESPONSES: 'openai_responses', // /v1/responses (Codex)
  GEMINI: 'gemini', // /v1beta/models/*:generateContent
});

// External apps that can be switched onto a card. Each maps to a live-config
// writer in services/externalApps/* and (optionally) a session-file scanner in
// services/usageScan/*.
const APPS = Object.freeze({
  CLAUDE_CODE: 'claude-code',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  GEMINI: 'gemini',
  DEEPSEEK: 'deepseek',
  REASONIX: 'reasonix',
  COMMAND_CODE: 'command-code',
  YCODE: 'ycode',
});

// App → human label (CLI/UI display).
const APP_LABELS = Object.freeze({
  [APPS.CLAUDE_CODE]: 'Claude Code',
  [APPS.CODEX]: 'Codex CLI',
  [APPS.OPENCODE]: 'OpenCode CLI',
  [APPS.GEMINI]: 'Gemini CLI',
  [APPS.DEEPSEEK]: 'DeepSeek TUI',
  [APPS.REASONIX]: 'Reasonix',
  [APPS.COMMAND_CODE]: 'Command Code',
  [APPS.YCODE]: 'YCode',
});

// Card-level default model per protocol (used by the switch writers when a card
// carries no per-app model override).
const PROTOCOL_DEFAULT_MODELS = Object.freeze({
  [PROTOCOLS.OPENAI]: 'gpt-4o',
  [PROTOCOLS.ANTHROPIC]: 'claude-sonnet-4-5',
  [PROTOCOLS.RESPONSES]: 'gpt-5-codex',
  [PROTOCOLS.GEMINI]: 'gemini-2.5-pro',
});

const DATA_FILE = 'cc_switch.json';
const SCHEMA_VERSION = 1;

module.exports = {
  PROTOCOLS,
  APPS,
  APP_LABELS,
  PROTOCOL_DEFAULT_MODELS,
  DATA_FILE,
  SCHEMA_VERSION,
};
