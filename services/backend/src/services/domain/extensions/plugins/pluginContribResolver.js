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
 *   - **Zero hard-coding**: roots, manifest names and state file all come from
 *     `services/extensions/extensionRoots` — the single source of truth legislated by
 *     [DESIGN-ARCH-069]. This module used to COPY those three constants from
 *     extensionManager and keep them in step "by construction" (i.e. by a human
 *     remembering); it no longer owns any path of its own.
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
const path = require('path');

const flagRegistry = require('../../../flagRegistry');
const extensionRoots = require('../extensions/extensionRoots');

// ── Gate ───────────────────────────────────────────────────────────────
// Single-gate on flagRegistry (central registry). Default-on. The extension's
// own `enabled` state is a SECOND gate consulted per extension (see _enabled).
const GATE = 'KHY_PLUGIN_LAZY_LOAD';

// ── Paths — delegated wholesale to extensionRoots (真源) ──────────────
// These three are kept as exports ONLY because existing tests and call sites read
// them; they are now derived, not declared. EXTENSIONS_DIR in particular is no
// longer "the" directory — there are up to five roots (repo `extensions/` included,
// which this resolver could not see at all before) — so it reports the user root
// for backwards compatibility while the actual scan walks every root.
const EXTENSIONS_DIR = extensionRoots.userExtensionsDir();
const MANIFEST_FILE = extensionRoots.MANIFEST_LEGACY_JSON;
const STATE_FILE = extensionRoots.stateFilePath();
const _TOOLS_FIELD = 'tools';

// ── Registry (lazy require to avoid any edge back into toolCalling) ──
function _baseTool() {
  return require('../../../../tools/_baseTool');
}
function _toolRegistry() {
  return require('../../../../cli/handlers/tools');
}

// ── Cache of enabled extensions + their declared tool names ─────────
// Built lazily; invalidated wholesale when an extension is installed/uninstalled
// (bounded window — a re-scan on our own is cheaper than keeping a watcher).
let _catalog = null;
let _stateCache = null;

function _readStateFile() {
  return extensionRoots.readState();
}

function _enabled(dirName, state) {
  return extensionRoots.isEnabled(dirName, state);
}

function _loadStateCached() {
  if (!_stateCache) {
    _stateCache = _readStateFile();
  }
  return _stateCache;
}

// Scan EVERY extension root (repo `extensions/` + user dirs + legacy plugins dirs),
// collecting { dir, manifest, absDir } for each enabled extension declaring at least
// one tool. Pure manifest read — no `entry` module is required here.
//
// Delegating to extensionRoots.discover() is what widened this resolver's reach from
// one hardcoded directory to the full root set; the disabled-filter, first-wins
// collision policy and fail-soft behaviour are unchanged because discover() applies
// exactly the same rules (sorted dir names, skip-on-bad-manifest, absent state =
// enabled). `dir` stays the BARE DIRECTORY NAME: it is the state key and the
// collision key, and [DESIGN-ARCH-069] §3.3 pins both to the directory basename.
function _scanEnabledExtensions() {
  const found = [];
  try {
    for (const ext of extensionRoots.discover()) {
      if (ext.kind !== 'runtime') {
        continue; // ide-bridge / asset never contribute runtime tools
      }
      const declared = Array.isArray(ext[_TOOLS_FIELD]) ? ext[_TOOLS_FIELD] : [];
      if (!declared.length) {
        continue; // no contributed tools in this extension
      }
      found.push({ dir: ext.id, absDir: ext.dir, manifest: ext });
    }
  } catch {
    /* every root missing/unreadable → no contributed tools, funnel unchanged */
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
      // Absolute dir comes from the root that actually provided this extension —
      // joining EXTENSIONS_DIR would silently mis-resolve anything found in the repo
      // root or a legacy plugins dir.
      const entryPath = ext.manifest.entry ? path.join(ext.absDir, ext.manifest.entry) : null;
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

/**
 * 拓展经 manifest **声明**的全部工具描述符 —— 纯 JSON 读，**永不 require 任何入口**。
 *
 * 为什么需要这个：`ownsTool()` / `activateContributedTool()` 是**执行**兜底，只在
 * 模型已经发出 tool_use 之后才被问到。而模型能不能发出这个 tool_use，取决于它有没有
 * 在工具清单里见过这个名字 —— 那份清单由 `assembleToolPool()` 从**已加载**的工具生成，
 * 里面永远没有惰性拓展。结果是一个迁出核的工具「叫得动但看不见」，等于从模型手里
 * 拿走了它。这是 khy-notebook 试点实测出来的缺口，不是假想。
 *
 * 补法必须保持惰性：manifest 是 JSON，name/description/inputSchema 三样**不执行任何
 * 拓展代码**就能读到 —— 这正是 [DESIGN-ARCH-069] §3 坚持「manifest 是 JSON 不是 JS」
 * 换来的东西。声明用来广告，入口仍然等到首次真正调用才 require。
 *
 * @returns {Array<{name:string,description:string,inputSchema:object,dir:string}>}
 *          失败一律返回空数组（fail-soft：宁可少广告一个工具，不可让清单构建抛异常）。
 */
function listDeclaredTools() {
  if (!flagRegistry.isFlagEnabled(GATE, process.env)) {
    return [];
  }
  try {
    _ensureCatalog();
  } catch {
    return [];
  }
  const out = [];
  for (const [name, rec] of toolIndex) {
    out.push({
      name,
      description: (rec.def && rec.def.description) || '',
      inputSchema: (rec.def && rec.def.inputSchema) || { type: 'object', properties: {} },
      dir: rec.dir,
    });
  }
  return out;
}

module.exports = {
  ownsTool,
  activateContributedTool,
  listDeclaredTools,
  EXTENSIONS_DIR,
  STATE_FILE,
  MANIFEST_FILE,
  // test hooks
  _reset,
  toolIndex,
};
