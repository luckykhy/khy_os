'use strict';

/**
 * commandAutoRegistry.js — Auto-discovery & dispatch for self-registering commands.
 *
 * Scans the `handlers/` directory for modules that export a command manifest
 * (via the MANIFEST_EXPORT_KEY convention from commandManifest.js), validates
 * them, and builds a dispatch table. route() consults this table before its
 * hardcoded switch, so newly-registered commands work without touching router.js.
 *
 * Progressive migration: existing commands keep working through the switch;
 * migrated commands are dispatched here first. Zero regression risk.
 *
 * @module cli/commandAutoRegistry
 */

const fs = require('fs');
const path = require('path');

const { extractManifest, validateManifest, HANDLERS_DIR } = require('./commandManifest');

// ── Internal state ────────────────────────────────────────────────

/** @type {Map<string, { name, handler, aliases, description, usage, subCommands, category, source }>} */
const _commands = new Map();

/** @type {Map<string, string>} — alias → canonical command name */
const _aliases = new Map();

let _initialized = false;

// ── Public API ────────────────────────────────────────────────────

/**
 * Scan handlers/ and register all self-describing commands.
 * Idempotent — calling multiple times re-scans (for hot-reload).
 */
function init() {
  _commands.clear();
  _aliases.clear();

  let files;
  try {
    files = fs.readdirSync(HANDLERS_DIR);
  } catch (err) {
    // handlers/ missing — fail-soft, registry stays empty.
    _initialized = true;
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.js')) {
      continue;
    }
    if (file.startsWith('_')) {
      continue; // private modules (e.g. _portableAutoInstall.js)
    }
    _registerFromFile(path.join(HANDLERS_DIR, file));
  }

  _initialized = true;
}

/**
 * Try to dispatch a command via the auto-registry.
 * @param {string} command — canonical command name
 * @param {object} ctx — { subCommand, args, options, rawCommandToken, parsed, context, printError, printHelp, printInfo, printTable, printSuccess, printWarn, withSpinner, chalk }
 * @returns {Promise<{ handled: boolean, result?: any }>}
 */
async function dispatch(command, ctx) {
  if (!_initialized) {
    init();
  }

  const entry = _commands.get(command);
  if (!entry) {
    return { handled: false };
  }

  try {
    const result = await entry.handler(ctx.parsed, ctx);
    return { handled: true, result };
  } catch (err) {
    // Fail-soft: log and let caller fall through to the switch.
    const { printError } = ctx;
    if (printError) {
      printError(`自注册命令执行失败: ${command} — ${err && err.message ? err.message : err}`);
    }
    return { handled: false };
  }
}

/**
 * @returns {string[]} all registered command names (sorted)
 */
function getCommandNames() {
  if (!_initialized) {
    init();
  }
  return [..._commands.keys()].sort();
}

/**
 * @returns {Record<string, string>} alias → canonical command name
 */
function getAliases() {
  if (!_initialized) {
    init();
  }
  const out = {};
  for (const [alias, cmd] of _aliases) {
    out[alias] = cmd;
  }
  return out;
}

/**
 * @returns {{ name: string, description: string, usage: string, category: string, subCommands: string[] }[]}
 */
function getCompletions() {
  if (!_initialized) {
    init();
  }
  return [..._commands.values()].map((e) => ({
    name: e.name,
    description: e.description || '',
    usage: e.usage || e.name,
    category: e.category || 'extension',
    subCommands: e.subCommands ? [...e.subCommands] : [],
  }));
}

/**
 * @returns {number} count of registered commands
 */
function size() {
  return _commands.size;
}

// ── Internal ──────────────────────────────────────────────────────

/**
 * Import a handler file and register its manifest if present.
 * @param {string} filePath — absolute path to .js file
 */
function _registerFromFile(filePath) {
  let mod;
  try {
    mod = require(filePath);
  } catch (err) {
    // Cannot import — skip (fail-soft, warn once per file).
    console.warn(`commandAutoRegistry: 跳过 ${path.basename(filePath)} (import 失败: ${err && err.message ? err.message : err})`);
    return;
  }

  const { manifest } = extractManifest(mod);
  if (!manifest) {
    return; // handler doesn't opt in — normal
  }

  const { valid, errors } = validateManifest(manifest);
  if (!valid) {
    console.warn(`commandAutoRegistry: 跳过 ${path.basename(filePath)} (清单无效: ${errors.join('; ')})`);
    return;
  }

  const name = manifest.name;

  if (_commands.has(name)) {
    console.warn(`commandAutoRegistry: 命令 "${name}" 重复注册 (来自 ${path.basename(filePath)})，跳过`);
    return;
  }

  _commands.set(name, {
    name,
    handler: manifest.handler,
    aliases: manifest.aliases || [],
    description: manifest.description || '',
    usage: manifest.usage || name,
    subCommands: manifest.subCommands || [],
    category: manifest.category || 'extension',
    source: path.basename(filePath),
  });

  // Register aliases
  for (const alias of manifest.aliases || []) {
    if (!_aliases.has(alias) && !_commands.has(alias)) {
      _aliases.set(alias, name);
    }
  }
}

// ── Auto-init on first require (lazy) ─────────────────────────────

// Do NOT auto-init at module load — router.js imports this at startup
// and will call init() explicitly after all handlers are in place.

module.exports = {
  init,
  dispatch,
  getCommandNames,
  getAliases,
  getCompletions,
  size,
};
