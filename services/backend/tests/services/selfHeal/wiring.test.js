'use strict';
/**
 * toolCalling.selfHealWiring.test.js â€?C-class wiring contract for selfHeal +
 * resilience (DESIGN-ARCH-029).
 *
 * Both subsystems were implemented but never wired into the live tool path
 * ("æœªæ”¹toolUseLoopå¾…åŽç»­PR" / only reachable via the dormant KHY_EVO_ENGINE
 * offline path). They are now wired into executeTool() and active by default
 * (KHY_SELF_HEAL=off disables): a tool that HEADS a registered degradation tree is run through
 * FallbackTreeWithHeal over the resilience tree, so a failure auto-degrades along
 * the tree (WebBrowserâ†’WebFetchâ†’WebSearch) and yields a structured salvage.
 *
 * This test registers controllable fake web tools so the degradation runs
 * deterministically offline, and pins the wiring contract:
 *   1. EXPLICIT OFF (KHY_SELF_HEAL=off) â†?no routing: a failing WebBrowser
 *      returns its own failure; WebFetch is never reached (escape hatch).
 *   2. FLAG ON â†?degradation: WebBrowser fails â†?WebFetch succeeds â†?the routed
 *      call returns WebFetch's success result (cross-tool degrade in one call).
 *   3. INTENT-MAP MISS â†?a tool with no tree (readFile) is never routed.
 *   4. RECURSION GUARD â†?the run terminates (the coordinator's re-entrant
 *      executeTool calls are not re-routed).
 */
const os = require('os');
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
function makeFake(name) {
  return {
    name,
    description: `fake ${name}`,
    risk: 'low',
    isReadOnly: true,
    inputSchema: { type: 'object', properties: {} },
    execute: async (params) => {
      calls.push(name);
      const r = script[name];
      if (typeof r === 'function') return r(params);
      return r || { success: false, error: `${name} no-script` };
    },
  };
}
before(() => {
  registry.register(makeFake('WebBrowser'));
  registry.register(makeFake('WebFetch'));
  registry.register(makeFake('WebSearch'));
  registry.register(makeFake('readFile')); // intent-map miss control
});
describe('selfHeal/resilience wiring contract (C-class)', () => {
  afterEach(() => {
    calls.length = 0;
    script = {};
    delete process.env.KHY_SELF_HEAL;
  });
});

describe('Wiring', () => {
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

  test('default on (KHY_SELF_HEAL unset): WebBrowser fails â†?degrades to WebFetch', async () => {
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

  test('flag on: WebBrowser fails â†?degrades to WebFetch success within one call', async () => {
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

  test('flag on, all tiers fail â†?structured salvage report, no infinite recursion', async () => {
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
        // It degraded past the first tier (browser â†?fetch) before the bounded-window
        // circuit broke; how far it gets is governed by the budget floor (by design it
        // need not exhaust every tier). The wiring contract we assert is the recursion
        // guard: no tool is ever invoked more than once (the coordinator's re-entrant
        // executeTool calls are not re-routed).
        expect(calls.includes('WebBrowser') && calls.includes('WebFetch')).toBeTruthy();
        expect(calls.filter(c => c === 'WebBrowser').length <= 1).toBeTruthy();
        expect(calls.filter(c => c === 'WebFetch').length <= 1).toBeTruthy();
        expect(calls.filter(c => c === 'WebSearch').length <= 1).toBeTruthy();
  });

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

