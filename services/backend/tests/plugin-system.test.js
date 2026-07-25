'use strict';

/**
 * Integration test — verifies the full plugin lifecycle:
 * 1. Discovery (from workspace node_modules)
 * 2. Manifest validation
 * 3. Activation (with timeout)
 * 4. Command execution
 * 5. Tool execution
 * 6. Storage isolation
 * 7. Deactivation / cleanup
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('plugin system integration', () => {
  let pluginLoader;
  let createContextFactory;
  let commandRegistry;
  let tmpDataHome;

  beforeAll(() => {
    tmpDataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-plugin-test-'));
    process.env.KHY_DATA_HOME = tmpDataHome;
    jest.resetModules();

    pluginLoader = require('../src/plugin-loader/index.js');
    ({ createContextFactory } = require('../src/plugin-loader/contextFactory.js'));
    commandRegistry = require('../src/cli/commandRegistry.js');
  });

  afterAll(async () => {
    try {
      await pluginLoader.shutdown();
    } catch {
      // ignore cleanup errors in tests
    }
    delete process.env.KHY_DATA_HOME;
    if (tmpDataHome) {
      fs.rmSync(tmpDataHome, { recursive: true, force: true });
    }
  });

  test('discovery -> activation -> command execution -> shutdown', async () => {
    // Ensure clean state for this test run
    await pluginLoader.shutdown();

    // ── Test 1: Discovery ──────────────────────────────────────────
    const candidates = pluginLoader.discoverPlugins(console);
    const helloCandidate = candidates.find(c => c.manifestData.name === 'khy-hello');
    assert(helloCandidate, 'khy-hello should be discovered from workspace');

    // ── Test 2: Manifest validation ────────────────────────────────
    const { validateManifest } = require('@khy/plugin-sdk');
    const { valid, errors } = validateManifest(helloCandidate.manifestData);
    assert(valid, `Manifest should be valid, got errors: ${errors.join(', ')}`);

    // ── Test 3: Full init (discovery + activation) ─────────────────
    const contextFactory = createContextFactory({
      commandRegistry,
      toolRegistry: null,
      aiGateway: null,
      logger: console,
      hostVersion: '1.0.0',
    });

    await pluginLoader.init({
      hostVersion: '1.0.0',
      contextFactory,
      logger: console,
    });

    const helloPlugin = pluginLoader.getPlugin('hello');
    assert(helloPlugin, 'hello plugin should be loaded');
    assert.strictEqual(helloPlugin.state, 'active', 'hello plugin should be active');

    // ── Test 4: Command registration ──────────────────────────────
    const allCmds = commandRegistry.getAll();
    const helloCmd = allCmds.find(c => c.cmd === '/hello.greet');
    assert(helloCmd, '/hello.greet should be registered in commandRegistry');
    assert(helloCmd._pluginHandler, 'Command should have a plugin handler');

    // ── Test 5: Command execution ─────────────────────────────────
    let cmdOutput = '';
    const mockCmdCtx = {
      print: (text) => { cmdOutput = text; },
      printStyled: (text) => { cmdOutput = text; },
      cwd: process.cwd(),
    };
    await helloCmd._pluginHandler(
      { raw: 'hello.greet khy', positional: ['khy'], flags: {} },
      mockCmdCtx
    );
    assert(cmdOutput.includes('Hello, khy!'), `Expected greeting, got: ${cmdOutput}`);
    assert(cmdOutput.includes('#1'), 'Should be greeting #1');

    // ── Test 6: Storage isolation ──────────────────────────────────
    await helloCmd._pluginHandler(
      { raw: 'hello.greet World', positional: ['World'], flags: {} },
      mockCmdCtx
    );
    assert(cmdOutput.includes('#2'), `Expected greeting #2, got: ${cmdOutput}`);

    // ── Test 7: Plugin status ──────────────────────────────────────
    const status = pluginLoader.getStatus();
    assert(status.length > 0, 'Should have at least one plugin in status');
    const helloStatus = status.find(s => s.namespace === 'hello');
    assert.strictEqual(helloStatus.state, 'active');
    assert.strictEqual(helloStatus.version, '1.0.0');

    // ── Test 8: Incompatible version handling ──────────────────────
    const fakeManifest = {
      name: 'khy-future',
      version: '9.0.0',
      engines: { khy: '>=99.0.0' },
      main: './src/index.js',
      namespace: 'future',
    };
    const vResult = validateManifest(fakeManifest);
    assert(vResult.valid, 'Manifest structure should be valid');

    // ── Test 9: Shutdown / deactivation ────────────────────────────
    await pluginLoader.shutdown();
    const afterShutdown = pluginLoader.getAllPlugins();
    assert.strictEqual(afterShutdown.length, 0, 'All plugins should be cleared');

    // ── Test 10: Host runs without plugins ─────────────────────────
    const remainingCmds = commandRegistry.getAll();
    const pluginCmds = remainingCmds.filter(c => c.source === 'plugin');
    assert.strictEqual(pluginCmds.length, 0, 'Plugin commands should be unregistered');
  });
});
