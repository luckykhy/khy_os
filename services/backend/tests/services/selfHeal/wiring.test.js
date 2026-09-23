'use strict';
/**
 * toolCalling.selfHealWiring.test.js — C-class wiring contract for selfHeal +
 * resilience (DESIGN-ARCH-029).
 *
 * Both subsystems were implemented but never wired into the live tool path
 * ("未改toolUseLoop待后续PR" / only reachable via the dormant KHY_EVO_ENGINE
 * offline path). They are now wired into executeTool() and active by default
 * (KHY_SELF_HEAL=off disables): a tool that HEADS a registered degradation tree is run through
 * FallbackTreeWithHeal over the resilience tree, so a failure auto-degrades along
 * the tree (WebBrowser→WebFetch→WebSearch) and yields a structured salvage.
 *
 * This test registers controllable fake web tools so the degradation runs
 * deterministically offline, and pins the wiring contract:
 *   1. EXPLICIT OFF (KHY_SELF_HEAL=off) �?no routing: a failing WebBrowser
 *      returns its own failure; WebFetch is never reached (escape hatch).
 *   2. FLAG ON �?degradation: WebBrowser fails �?WebFetch succeeds �?the routed
 *      call returns WebFetch's success result (cross-tool degrade in one call).
 *   3. INTENT-MAP MISS �?a tool with no tree (readFile) is never routed.
 *   4. RECURSION GUARD �?the run terminates (the coordinator's re-entrant
 *      executeTool calls are not re-routed).
 */
const os = require('os');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-selfheal-wiring-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
// Hermetic gates: let the funnel run registered tools without prompts.
process.env.KHY_TASK_CAPABILITY_GATE = 'false';
process.env.KHY_EXEC_APPROVAL = 'off';
process.env.KHY_METACONSTRAINT = 'off';
process.env.KHY_SYSCALL_GATEWAY = 'off';
process.env.KHY_PERMISSION_STORE = 'false';
const toolCalling = require('../../../src/services/toolCalling');
const registry = require('../../../src/tools');
// Per-test call ledger + scripted results for the fake web tools.
const calls = [];
let script = {};
function makeFake(name, ledgerName = name) {
  return {
    name,
    description: `fake ${name}`,
    risk: 'low',
    isReadOnly: true,
    inputSchema: { type: 'object', properties: {} },
    // _resolveToolDescriptor resolves real builtins (e.g. WebSearch) at
    // priority 2, ahead of registry tools lacking alwaysLoad (priority 3).
    // alwaysLoad hoists this fake to priority 1 so it shadows the builtin —
    // without it, tier 3 would fire the REAL WebSearch and hit the network.
    alwaysLoad: true,
    execute: async (params) => {
      // Alias fakes still ledger + script under the CANONICAL name:
      // normalizeToolName maps WebFetch/WebSearch to webFetch/webSearch, so
      // those alias keys resolve first; without this indirection the ledger
      // would record 'webFetch' and script lookups would miss.
      calls.push(ledgerName);
      const r = script[ledgerName];
      if (typeof r === 'function') return r(params);
      return r || { success: false, error: `${ledgerName} no-script` };
    },
  };
}

describe('Wiring', () => {
beforeAll(() => {
  registry.register(makeFake('WebBrowser'));
  registry.register(makeFake('WebFetch'));
  registry.register(makeFake('WebSearch'));
  registry.register(makeFake('readFile')); // intent-map miss control
  // _findRegistryTool resolves name VARIANTS first (webSearch, web_search, …)
  // before the exact key, and a sibling REAL `webSearch` registry entry
  // exists for WebSearch. Shadow every alias too, or tier 3 would execute
  // the real tool and hit the network instead of the scripted fake.
  const ALIASES = {
    WebBrowser: ['webBrowser', 'web_browser', 'browser'],
    WebFetch: ['webFetch', 'web_fetch', 'fetch_url'],
    WebSearch: ['webSearch', 'web_search', 'search_web'],
  };
  for (const [name, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) registry.register(makeFake(alias, name));
  }
});
  // merged from describe: selfHeal/resilience wiring contract (C-class)
  afterEach(() => {
    calls.length = 0;
    script = {};
    delete process.env.KHY_SELF_HEAL;
  });
  test('explicit off (KHY_SELF_HEAL=off): a failing WebBrowser is NOT routed (no degrade to WebFetch)', async () => {
        process.env.KHY_SELF_HEAL = 'off';
        script.WebBrowser = { success: false, error: 'browser boom' };
        script.WebFetch = { success: true, content: 'should-not-be-reached' };
        const res = await toolCalling.executeTool('WebBrowser', { url: 'https://x', query: 'q' }, {
          onControlRequest: async () => true,
        });
        expect(res.success).toBe(false);
        assert.deepEqual(calls, ['WebBrowser'], 'only WebBrowser runs when routing is off');
  });

  test('default on (KHY_SELF_HEAL unset): WebBrowser fails �?degrades to WebFetch', async () => {
        delete process.env.KHY_SELF_HEAL; // unset = active by default
        script.WebBrowser = { success: false, error: 'browser boom' };
        script.WebFetch = { success: true, content: 'KHY-HEAL-DEFAULT-ON' };
        const res = await toolCalling.executeTool('WebBrowser', { url: 'https://x', query: 'q' }, {
          onControlRequest: async () => true,
        });
        expect(res.success).toBe(true);
        expect(res.content).toBe('KHY-HEAL-DEFAULT-ON');
        expect(calls.includes('WebBrowser') && calls.includes('WebFetch')).toBeTruthy();
  });

  test('flag on: WebBrowser fails �?degrades to WebFetch success within one call', async () => {
        process.env.KHY_SELF_HEAL = 'on';
        script.WebBrowser = { success: false, error: 'browser boom' };
        script.WebFetch = { success: true, content: 'KHY-HEAL-OK' };
        const res = await toolCalling.executeTool('WebBrowser', { url: 'https://x', query: 'q' }, {
          onControlRequest: async () => true,
        });
        expect(res.success).toBe(true);
        expect(res.content).toBe('KHY-HEAL-OK');
        expect(calls.includes('WebBrowser') && calls.includes('WebFetch')).toBeTruthy();
        expect(!calls.includes('WebSearch')).toBeTruthy();
  });

  // Exhausting every tier (diagnose + heal attempts per tier) legitimately
  // takes longer than jest's 5s default; still bounded to catch real hangs.
  test('flag on, all tiers fail → structured salvage report, no infinite recursion', async () => {
        process.env.KHY_SELF_HEAL = 'on';
        script.WebBrowser = { success: false, error: 'b' };
        script.WebFetch = { success: false, error: 'f' };
        script.WebSearch = { success: false, error: 's' };
        const res = await toolCalling.executeTool('WebBrowser', { url: 'https://x', query: 'q' }, {
          onControlRequest: async () => true,
        });
        expect(res.success).toBe(false);
        expect(res._selfHealReport).toBeTruthy();
        expect(res._selfHealReport.status).toBe('failed');
        // It degraded past the first tier (browser �?fetch) before the bounded-window
        // circuit broke; how far it gets is governed by the budget floor (by design it
        // need not exhaust every tier). The wiring contract we assert is the recursion
        // guard: no tool is ever invoked more than once (the coordinator's re-entrant
        // executeTool calls are not re-routed).
        expect(calls.includes('WebBrowser') && calls.includes('WebFetch')).toBeTruthy();
        expect(calls.filter(c => c === 'WebBrowser').length <= 1).toBeTruthy();
        expect(calls.filter(c => c === 'WebFetch').length <= 1).toBeTruthy();
        expect(calls.filter(c => c === 'WebSearch').length <= 1).toBeTruthy();
  }, 30000);

  test('intent-map miss: a tool with no tree is never routed even when flag is on', async () => {
        process.env.KHY_SELF_HEAL = 'on';
        script.readFile = { success: false, error: 'rf boom' };
        script.WebFetch = { success: true, content: 'unreached' };
        const res = await toolCalling.executeTool('readFile', { path: '/nope' }, {
          onControlRequest: async () => true,
        });
        expect(res.success).toBe(false);
        expect(!calls.includes('WebFetch')).toBeTruthy();
  });

});

