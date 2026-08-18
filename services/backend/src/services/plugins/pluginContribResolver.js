/**
 * Plugin on-demand lazy activation — resolve contributed tools from installed
 * extensions at the executeTool funnel, WITHOUT charging them into the static
 * tool registry until their declared name is actually invoked.
 *
 * Design philosophy (DeepSeek-Harness / Cordis "插件按需激活"):
 *   - A contributed tool is a pure leaf in the funnel: when `executeTool` fails
 *     to resolve a name through the normal registry/builtin path, it asks this
 *     resolver "do you own <name>?"; if yes, the resolver LAZILY `require()`s the
 *     extension's entry module and registers the built tool via the standard
 *     tools `register(tool)` as-is path, then returns the descriptor.
 *   - Until first invocation, the extension module body is NEVER executed — a
 *     disabled/absent extension costs zero load time and zero side effects.
 *
 * KHY-OS Iron Rules upheld:
 *   - **Dual-gate fail-closed**: BOTH the flagRegistry gate `KHY_PLUGIN_LAZY_LOAD`
 *     (default-on) AND the extension's `extensions_state.json` `enabled` state must
 *     pass; any failure → null → "unknown tool" → existing fuzzy-fix path. There is
 *     NO funnel bypass and NO new entrance into executeTool.
 *   - **Zero hard-coding**: paths mirror extensionManager (`getAppHome()` with the
 *     ~/.khyquant fallback), manifest file name, state file name — single source
 *     of truth kept in step with extensionManager by construction.
 *   - **Pure leaf / no cycles**: this module requires only `_baseTool`, the tools
 *     registry, and `flagRegistry` — nothing that requires toolCalling, so it can
 *     be required from toolCalling without creating an edge back into it.
 *   - **Never throws**: every read/parse/require is try/caught; failure returns
 *     null and the funnel keeps its fail-closed semantics.
 *
 * @module services/plugins/pluginContribResolver
 * @pattern Lazy Subscriber (registred on first use, never at startup)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const flagRegistry = require('../flagRegistry');

// ── Gate ───────────────────────────────────────────────────────────────
// Single-gate on flagRegistry (central registry). Default-on. The extension's
// own `enabled` state is a SECOND gate consulted per extension (see _enabled).
const GATE = 'KHY_PLUGIN_LAZY_LOAD';

// ── Paths (mirror extensionManager; single source of truth) ──────────
function _appHome() {
  try {
    const { getAppHome } = require('../../utils/dataHome');
    return getAppHome();
  } catch {
    return path.join(os.homedir(), '.khyquant');
  }
}
const EXTENSIONS_DIR = path.join(_appHome(), 'extensions');
const MANIFEST_FILE = 'openclaw.plugin.json';
const STATE_FILE = path.join(_appHome(), 'extensions_state.json');
const _TOOLS_FIELD = 'tools';

// ── Registry (lazy require to avoid any edge back into toolCalling) ──
function _baseTool() {
  return require('../../tools/_baseTool');
}
function _toolRegistry() {
  return require('../../tools');
}

// ── Cache of enabled extensions + their declared tool names ─────────
// Built lazily; invalidated wholesale when an extension is installed/uninstalled
// (bounded window — a re-scan on our own is cheaper than keeping a watcher).
let _catalog = null;
let _stateCache = null;

function _readStateFile() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    /* corrupt/unreadable → treat as no state (absent state = enabled) */
  }
  return {};
}

function _enabled(dirName, state) {
  return state[dirName]?.enabled !== false;
}

function _loadStateCached() {
  if (!_stateCache) {
    _stateCache = _readStateFile();
  }
  return _stateCache;
}

// Scan EXTENSIONS_DIR, collecting { dir, manifest, enabled } for every folder that
// carries a manifest declaring at least one tool. Pure read of manifest `tools`;
// the `entry` module is NOT required here.
function _scanEnabledExtensions() {
  const state = _loadStateCached();
  const found = [];
  try {
    const dirs = fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) {
        continue;
      }
      if (!_enabled(dir.name, state)) {
        continue;
      }
      const manifestPath = path.join(EXTENSIONS_DIR, dir.name, MANIFEST_FILE);
      let manifest;
      try {
        if (!fs.existsSync(manifestPath)) {
          continue;
        }
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch {
        continue; // corrupt manifest → skip
      }
      const declared = Array.isArray(manifest[_TOOLS_FIELD]) ? manifest[_TOOLS_FIELD] : [];
      if (!declared.length) {
        continue; // no contributed tools in this extension
      }
      found.push({ dir: dir.name, manifest });
    }
  } catch {
    /* EXTENSIONS_DIR missing/unreadable */
  }
  return found;
}

// Drop any module-level caches (exposed for tests + install/uninstall invalidation).
function _reset() {
  _catalog = null;
  _stateCache = null;
  toolIndex.clear();
}

// name → { dir, def, entryPath } for every declared contributed tool.
const toolIndex = new Map();

// Build the catalog by re-reading manifests AND re-reading the state file, then
// refreshing the flat name→record index. Wholesale rebuild is O(#extensions) —
// cheap because no entry module is ever required here (pure manifest reads).
function _rebuild() {
  toolIndex.clear();
  const state = _loadStateCached();
  const exts = _scanEnabledExtensions();
  _catalog = exts; // hold the scan result so a re-scan only happens on staleness
  for (const ext of exts) {
    if (state[ext.dir]?.enabled === false) {
      continue; // fail-closed: a JUST-disabled extension is excluded even mid-scan
    }
    const declared = ext.manifest[_TOOLS_FIELD] || [];
    for (const def of declared) {
      if (!def || typeof def !== 'object' || typeof def.name !== 'string' || !def.name) {
        continue;
      }
      const entryPath = ext.manifest.entry
        ? path.join(EXTENSIONS_DIR, ext.dir, ext.manifest.entry)
        : null;
      if (!entryPath || !fs.existsSync(entryPath)) {
        continue;
      }
      if (toolIndex.has(def.name)) {
        // Name collision between two extensions: first-scanned wins (deterministic
        // by dirname order); the later declaration is shadowed — fail-closed, never
        // ambiguous dispatch.
        continue;
      }
      toolIndex.set(def.name, { dir: ext.dir, def, entryPath });
    }
  }
}

function _catalogIsStale() {
  const state = _readStateFile();
  const key = JSON.stringify(state);
  // Staleness probe: a changed or absent cached state means the file changed since
  // we last indexed it (install/uninstall/enable/disable). Cheap, fail-open to
  // rebuild when unsure.
  return !_stateCache || _stateCache.__key !== key;
}

function _ensureCatalog() {
  if (_catalogIsStale()) {
    _stateCache = _readStateFile();
    _stateCache.__key = JSON.stringify(_stateCache);
    _rebuild();
  }
}

/**
 * Does any ENABLED extension declare a contributed tool with this name?
 * Pure read — never requires the entry module. Safely returns false when the
 * gate is off (ownership knowledge is gated too, so gate-off shows NO contributed
 * names at all — the funnel behaves byte-identically to an uninstalled plugin).
 * @param {string} name - the requested tool name (already normalized variant).
 */
function ownsTool(name) {
  if (!name || typeof name !== 'string') {
    return false;
  }
  if (!flagRegistry.isFlagEnabled(GATE, process.env)) {
    return false;
  }
  try {
    _ensureCatalog();
    return toolIndex.has(name);
  } catch {
    return false;
  }
}

/**
 * Lazy-activate a contributed tool: on FIRST call for this name, `require()` the
 * extension's entry module, build the tool via `_baseTool.defineTool(...)` (which
 * yields a validate+toFunctionDef object so `register()` stores it as-is), then
 * register it into the static tool registry. Returns the freshly-built tool, or
 * null on any failure (fail-soft → caller keeps the fail-closed unknown-tool path).
 *
 * Only ever fired AFTER the normal funnel resolution returned null (see the
 * executeTool call-site), so a real builtin/registry tool with the same name
 * ALWAYS wins regardless of position.
 *
 * @param {string} name - requested tool name.
 * @returns {object|null} the activated tool (also registered), or null.
 */
function activateContributedTool(name) {
  if (!name || typeof name !== 'string') {
    return null;
  }
  // Dual-gate, gate #1: central flagRegistry flag (default-on).
  if (!flagRegistry.isFlagEnabled(GATE, process.env)) {
    return null;
  }
  let rec;
  try {
    _ensureCatalog();
    rec = toolIndex.get(name);
  } catch {
    return null;
  }
  if (!rec) {
    return null;
  }
  const { defineTool } = _baseTool();
  // Lazy require happens HERE — the extension module body runs only on first call.
  let exported;
  try {
    exported = require(rec.entryPath);
  } catch (err) {
    return null;
  }
  // Behavioural overrides can come from either the manifest def or the entry's
  // per-tool export. Precedence rule:
  //   - JSON-safe declarations (scalars/booleans/arrays) → MANIFEST wins (declared
  //     intent at install site):   rec.def.X  ??  entryTool.X
  //   - Runtime FUNCTIONS (execute, requiresSandboxEscape, validateInput, ...) can
  //     ONLY exist in the JS entry export (openclaw.plugin.json is JSON — functions
  //     cannot be declared there) → ENTRY wins:      entryTool.X  ??  rec.def.X
  const entryTool =
    exported && exported.tools && Array.isArray(exported.tools)
      ? exported.tools.find((t) => t && t.name === rec.def.name)
      : null;

  // ── JSON-safe scalar/boolean/array fields (manifest intent wins) ──
  const _d = rec.def;
  const _e = entryTool;
  const scalar = (k) => (_d[k] !== undefined ? _d[k] : _e && _e[k]);
  // ── Runtime function fields (entry export wins — JSON can't hold fns) ──
  const fn = (k) => (typeof _e?.[k] === 'function' ? _e[k] : typeof _d?.[k] === 'function' ? _d[k] : undefined);

  const execute = fn('execute') || fn('handler');
  if (typeof execute !== 'function') {
    return null;
  }
  let tool;
  try {
    tool = defineTool({
      name: rec.def.name,
      description: _d.description || (_e && _e.description) || '',
      category: _d.category || (_e && _e.category) || 'custom',
      risk: _d.risk || (_e && _e.risk) || 'medium',
      inputSchema: _d.inputSchema || (_e && (_e.inputSchema || _e.parameters)) || {},
      execute,
      isReadOnly: scalar('isReadOnly'),
      isDestructive: scalar('isDestructive'),
      isConcurrencySafe: scalar('isConcurrencySafe'),
      isEnabled: fn('isEnabled'),
      interruptBehavior: scalar('interruptBehavior'),
      // Sandbox-escape declaration MUST be preserved through registration, else the
      // syscall gateway can never force a contributed tool to L2 (typed-YES).
      // `sandboxEscape` is a static boolean → manifest OR entry (either is JSON-safe /
      // readable); `requiresSandboxEscape` is a runtime function → entry export only.
      sandboxEscape: scalar('sandboxEscape'),
      requiresSandboxEscape: fn('requiresSandboxEscape'),
      shouldDefer: scalar('shouldDefer'),
      alwaysLoad: scalar('alwaysLoad'),
      aliases: Array.isArray(_d.aliases) ? _d.aliases : _e && _e.aliases,
      searchHint: scalar('searchHint'),
      maxResultSizeChars: scalar('maxResultSizeChars'),
      prompt: fn('prompt'),
      validateInput: fn('validateInput'),
      getActivityDescription: fn('getActivityDescription'),
      getToolUseSummary: fn('getToolUseSummary'),
    });
  } catch {
    return null; // defineTool threw (bad category/risk/schema) → invalid contributed tool
  }
  // Register as-is: defineTool-built tools carry validate + toFunctionDef, so
  // tools.register() stores it directly in the `_tools` partition (Priority-3
  // registry path), and the funnel re-resolves it as `source:'registry'`.
  try {
    _toolRegistry().register(tool);
  } catch {
    return null;
  }
  return tool;
}

module.exports = {
  ownsTool,
  activateContributedTool,
  EXTENSIONS_DIR,
  STATE_FILE,
  MANIFEST_FILE,
  // test hooks
  _reset,
  toolIndex,
};
