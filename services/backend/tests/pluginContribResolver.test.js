'use strict';

/**
 * pluginContribResolver.test.js — Block A「插件按需激活」核心交付:
 *   在 executeTool 漏斗解析落空后,按名懒加载扩展 entry,并按 _baseTool.defineTool
 *   契约注册进静态注册表,走标准 Priority-3 `source:'registry'` 路径。
 *
 * Asserted invariants (与任务卡一一对应):
 *   1. ownsTool —— 仅当真扩展声明了该工具名且「flag 门 && 扩展 enabled」都过时才返回
 *      true;门关时对 ALL 名字返回 false(漏斗行为与"插件未安装"逐字节同构)。
 *   2. 懒加载 —— activateContributedTool 首次调用才会 require 扩展 entry(用全局哨兵验证
 *      模块体未在 ownsTool / 预扫描时执行),且命中的工具确已进入注册表。
 *   3. 双门故障关闭 —— flag 门关 OR 扩展 disabled → 返回 null(→ 漏斗 unknown-tool),绝无旁路。
 *   4. 契约一致性 —— 注册后的工具是 defineTool 产物(有 validate + toFunctionDef),register()
 *      走 as-is 分支;静态字段来自 manifest,运行时函数(requiresSandboxEscape 等)来自 entry
 *      导出(JSON 放不下函数)。
 *   5. 失败软化 —— entry 缺失 / 模块加载抛错 / defineTool 抛错 → null,绝不 throw。
 *
 * 隔离策略:
 *   - 在 require 本模块前把 KHY_APP_HOME 指向临时目录(fixture 扩展树),EXTENSIONS_DIR
 *     因此指向隔离区;每次用例前 _reset() 重置目录/状态缓存。
 *   - 每个用例使用**唯一工具名**,避免跨用例污染 tools 注册表(本套件不卸载注册表,
 *     只做断言级隔离)。
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let homeDir;
let resolver;
let tools;

before(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-plugincontrib-'));
  // MUST set before any module that touches getAppHome caches the home.
  process.env.KHY_APP_HOME = homeDir;
  // Fresh requires so EXTENSIONS_DIR resolves under the temp home.
  delete require.cache[require.resolve('../src/services/plugins/pluginContribResolver')];
  resolver = require('../src/services/plugins/pluginContribResolver');
  tools = require('../src/tools');
});

after(() => {
  delete process.env.KHY_APP_HOME;
  fs.rmSync(homeDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test must start from an isolated install: wipe extensions left on
  // disk by prior tests so an absent-state folder can't leak into the next
  // case (absent state = enabled by design, so leftover dirs would be owned).
  fs.rmSync(path.join(homeDir, 'extensions'), { recursive: true, force: true });
  resolver._reset();
  delete global.__resolverEntryExecuted;
});

// ── Fixture builders ──────────────────────────────────────────────────
const MANIFEST_FILE = 'openclaw.plugin.json';

function writeExtension(dirName, manifest, entrySource) {
  const dir = path.join(homeDir, 'extensions', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  if (entrySource) {
    fs.writeFileSync(path.join(dir, manifest.entry), entrySource, 'utf-8');
  }
}

function enabledState(entries) {
  const file = path.join(homeDir, 'extensions_state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

// Entry exports the tool's runtime execute. `__resolverEntryExecuted` proves the
// module body ran exactly as many times as node actually loaded it.
const trackedEntry = (toolName, extra = '') => `
global.__resolverEntryExecuted = (global.__resolverEntryExecuted || 0) + 1;
module.exports = { tools: [{ name: '${toolName}', execute: () => ({ success: true })${extra} }] };
`;

// Every test gets a UNIQUE extension dir + UNIQUE entry.js path so node's require
// cache never serves another test's output (a shared path + cache would leak a
// stale export across tests).
let _testSeq = 0;
function freshDir(manifestMaker, entrySource, name, { enabled = true } = {}) {
  _testSeq += 1;
  const dir = 'ext-' + _testSeq;
  writeExtension(dir, manifestMaker(name, dir), entrySource(name));
  enabledState({ [dir]: { enabled } });
  return dir;
}

const basicManifest = (toolName) => ({
  name: 'fixture-ext',
  version: '1.0.0',
  description: 'Block A fixture with one contributed tool',
  entry: './entry.js',
  tools: [
    {
      name: toolName,
      description: 'Fetch a quote',
      category: 'data',
      risk: 'low',
      inputSchema: { type: 'object', properties: { ticker: { type: 'string' } } },
    },
  ],
});

// ── 1. ownsTool gate behavior ────────────────────────────────────────
test('ownsTool true only for declared tool of an enabled extension', () => {
  freshDir(basicManifest, trackedEntry, 'quote_tracker');

  assert.ok(resolver.ownsTool('quote_tracker'), 'declared + enabled tool is "owned"');
  assert.ok(!resolver.ownsTool('nope'), 'undeclared name is not owned');
  assert.ok(!resolver.ownsTool(''), 'empty name is not owned');
  assert.ok(!resolver.ownsTool(null), 'null name is not owned');
});

test('ownsTool does NOT execute the entry module (pure manifest read)', () => {
  freshDir(basicManifest, trackedEntry, 'quote_tracker');

  assert.equal(global.__resolverEntryExecuted, undefined, 'entry must not run on ownsTool');
  assert.ok(resolver.ownsTool('quote_tracker'));
  assert.equal(global.__resolverEntryExecuted, undefined, 'still not run after ownsTool');
});

test('ownsTool false for an extension disabled in extensions_state.json', () => {
  freshDir(basicManifest, trackedEntry, 'quote_tracker', { enabled: false });

  assert.ok(!resolver.ownsTool('quote_tracker'), 'disabled extension names are not owned');
});

// ── 2. lazy activation + registration ────────────────────────────────
test('activateContributedTool lazily requires entry and registers a defineTool-built tool', () => {
  const name = 'activate_tool';
  freshDir(basicManifest, trackedEntry, name);

  // Before activation the tool is NOT in the registry, and the module body never ran.
  assert.equal(!!tools.get(name), false, 'not registered before activation');
  assert.equal(global.__resolverEntryExecuted, undefined, 'entry not loaded before activation');

  const tool = resolver.activateContributedTool(name);
  assert.ok(tool, 'activation returns the built tool');
  assert.equal(global.__resolverEntryExecuted, 1, 'entry executed exactly once on first call');
  assert.equal(!!tools.get(name), true, 'tool is now registered (Priority-3 registry path)');
  // Register() must store it AS-IS (defineTool-built has validate + toFunctionDef).
  assert.equal(typeof tool.validate, 'function', 'defineTool contract: validate present');
  assert.equal(typeof tool.toFunctionDef, 'function', 'defineTool contract: toFunctionDef present');
});

test('second activation is a no-op (node caches the module; registry entry reused)', () => {
  const name = 'second_activation';
  freshDir(basicManifest, trackedEntry, name);

  const tool1 = resolver.activateContributedTool(name);
  const tool2 = resolver.activateContributedTool(name);
  assert.ok(tool1 && tool2, 'both calls return a built tool');
  assert.equal(
    global.__resolverEntryExecuted,
    1,
    'entry module body executed only ONCE across calls (node require-cache)'
  );
});

test('behavioral fields survive defineTool: manifest scalars + entry runtime fns', () => {
  const name = 'sandbox_cmd';
  const manifest = {
    name: 'ext-sandbox',
    entry: './entry.js',
    tools: [
      {
        name,
        category: 'execution',
        risk: 'high',
        sandboxEscape: true, // static boolean — JSON-safe, declared in manifest
        aliases: ['sc'],
        alwaysLoad: true,
        shouldDefer: false,
        // NOTE: requiresSandboxEscape is a RUNTIME function → lives in the entry
        // export (openclaw.plugin.json is JSON and cannot hold functions).
      },
    ],
  };
  const entry = `
global.__resolverEntryExecuted = (global.__resolverEntryExecuted || 0) + 1;
module.exports = {
  tools: [{
    name: '${name}',
    requiresSandboxEscape: () => true,
    execute: () => ({ success: true }),
  }],
};
`;
  freshDir(() => manifest, () => entry, name);

  const tool = resolver.activateContributedTool(name);
  assert.ok(tool);
  assert.equal(tool.sandboxEscape, true, 'sandboxEscape preserved (manifest boolean)');
  assert.equal(typeof tool.requiresSandboxEscape, 'function', 'requiresSandboxEscape from entry export');
  assert.deepEqual(tool.aliases, ['sc'], 'aliases preserved (manifest array)');
  assert.ok(tool.alwaysLoad, 'alwaysLoad preserved');
});

// ── 3. dual-gate fail-closed ─────────────────────────────────────────
test('gate OFF → null (no activation, no registry write, no entry run)', () => {
  const name = 'gate_off_tool';
  freshDir(basicManifest, trackedEntry, name);
  const prev = process.env.KHY_PLUGIN_LAZY_LOAD;
  process.env.KHY_PLUGIN_LAZY_LOAD = 'off'; // default-on 门:显式 CANON off 词关闭

  const tool = resolver.activateContributedTool(name);
  assert.equal(tool, null, 'gate-off must fail closed to null');
  assert.equal(!!tools.get(name), false, 'no registry write when gated off');
  assert.equal(global.__resolverEntryExecuted, undefined, 'entry never runs when gated off');
  if (prev === undefined) {
    delete process.env.KHY_PLUGIN_LAZY_LOAD;
  } else {
    process.env.KHY_PLUGIN_LAZY_LOAD = prev;
  }
});

test('extension disabled → null (gate #2) even when flag is on', () => {
  const name = 'disabled_ext_tool';
  freshDir(basicManifest, trackedEntry, name, { enabled: false });

  const tool = resolver.activateContributedTool(name);
  assert.equal(tool, null, 'disabled extension must fail closed, not activate');
  assert.equal(!!tools.get(name), false, 'no registry write for disabled extension');
});

// ── 4. soft-fail paths (never throw) ─────────────────────────────────
test('missing entry file → null without throwing', () => {
  const name = 'missing_entry_tool';
  freshDir((t) => ({ ...basicManifest(t), entry: './missing.js' }), () => null, name);

  assert.doesNotThrow(() => resolver.activateContributedTool(name));
  assert.equal(resolver.activateContributedTool(name), null);
});

test('entry module that throws on require → null without throwing', () => {
  const name = 'throwing_entry_tool';
  freshDir(basicManifest, () => `throw new Error('boom');`, name);

  assert.doesNotThrow(() => resolver.activateContributedTool(name));
  assert.equal(resolver.activateContributedTool(name), null);
});

test('defineTool rejects bad category/risk → null without throwing', () => {
  const name = 'bad_cat_tool';
  freshDir(
    (t) => ({ name: 'bad-cat', entry: './entry.js', tools: [{ name: t, category: 'bogus', risk: 'medium' }] }),
    trackedEntry,
    name
  );

  assert.doesNotThrow(() => resolver.activateContributedTool(name));
  assert.equal(resolver.activateContributedTool(name), null, 'invalid category must not register');
});
