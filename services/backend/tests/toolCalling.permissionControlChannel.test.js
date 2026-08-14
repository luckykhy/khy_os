'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Regression: under the Ink TUI, interactive tool approval must route through the
// host channel (onControlRequest → Ink PermissionsPrompt) and must NOT touch the
// shared TTY raw mode. The classic readline dialog calls stdin.setRawMode(false),
// which drops the Ink TUI to cooked mode (↑→^[[A, Enter→newline, input leaks below
// the box). These tests pin the routing + decision mapping at the requestPermission
// seam, and assert raw mode is never touched on the host-channel path.

describe('toolCalling requestPermission — host control channel (Ink-safe)', () => {
  const originalEnv = { ...process.env };
  let tmpHome;

  beforeEach(() => {
    // Redirect homedir so approveTool()/savePermissions() write to a throwaway dir
    // (PERMISSIONS_FILE = ~/.khyquant/tool_permissions.json is resolved from
    // os.homedir() at module load). os.homedir() ignores process.env.HOME on macOS
    // (getpwuid), so we mock the module. This isolates tests from each other and
    // from the developer's real permissions file.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-perm-test-'));
    jest.doMock('os', () => ({ ...jest.requireActual('os'), homedir: () => tmpHome }));

    // Skip the human-gate riskGate probe and force the enhanced (non-legacy) UI
    // so the test deterministically reaches the approval branch.
    process.env.KHY_HUMAN_GATE = 'off';
    delete process.env.KHY_LEGACY_PERMISSION_UI;
    delete process.env.KHY_PERMISSION_STORE;

    // permissionStore: always 'ask' so no early allow/deny short-circuit; spy on
    // persistence so we can assert the host decision is recorded.
    jest.doMock('../src/services/permissionStore', () => ({
      check: jest.fn(() => 'ask'),
      approve: jest.fn(),
      deny: jest.fn(),
      getProfile: jest.fn(() => 'normal'),
    }));
    // Unknown tool in the registry → not auto-approved as safe/low.
    jest.doMock('../src/tools', () => ({ get: jest.fn(() => undefined) }));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
    try { if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function withRawModeSpy(fn) {
    const had = Object.prototype.hasOwnProperty.call(process.stdin, 'setRawMode');
    const original = process.stdin.setRawMode;
    const spy = jest.fn();
    // eslint-disable-next-line no-param-reassign
    process.stdin.setRawMode = spy;
    return Promise.resolve(fn(spy)).finally(() => {
      if (had) process.stdin.setRawMode = original;
      else delete process.stdin.setRawMode;
    });
  }

  test('onControlRequest resolving true → allow, raw mode untouched', async () => {
    const permStore = require('../src/services/permissionStore');
    const { requestPermission } = require('../src/services/toolCalling');
    await withRawModeSpy(async (rawSpy) => {
      const onControlRequest = jest.fn(async () => true);
      const decision = await requestPermission('qux_unapproved_tool', { foo: 1 }, onControlRequest);
      expect(decision).toBe('allow');
      expect(onControlRequest).toHaveBeenCalledTimes(1);
      const arg = onControlRequest.mock.calls[0][0];
      expect(arg.request.subtype).toBe('can_use_tool');
      expect(arg.request.tool_name).toBe('qux_unapproved_tool');
      expect(permStore.approve).toHaveBeenCalledWith('qux_unapproved_tool', 'once', expect.anything());
      expect(rawSpy).not.toHaveBeenCalled();
    });
  });

  test("onControlRequest resolving 'always' → allow-always, persisted forever", async () => {
    const permStore = require('../src/services/permissionStore');
    const { requestPermission } = require('../src/services/toolCalling');
    await withRawModeSpy(async (rawSpy) => {
      const decision = await requestPermission('qux_unapproved_tool', {}, async () => 'always');
      expect(decision).toBe('allow-always');
      expect(permStore.approve).toHaveBeenCalledWith('qux_unapproved_tool', 'forever', expect.anything());
      expect(rawSpy).not.toHaveBeenCalled();
    });
  });

  test('onControlRequest resolving false → deny, raw mode untouched', async () => {
    const permStore = require('../src/services/permissionStore');
    const { requestPermission } = require('../src/services/toolCalling');
    await withRawModeSpy(async (rawSpy) => {
      const decision = await requestPermission('qux_unapproved_tool', {}, async () => false);
      expect(decision).toBe('deny');
      expect(permStore.deny).toHaveBeenCalledWith('qux_unapproved_tool', 'session', expect.anything());
      expect(rawSpy).not.toHaveBeenCalled();
    });
  });

  test('no host channel → falls back to the injected prompter (port, not direct require)', async () => {
    // DESIGN-ARCH-057: the dialog is injected via permissionPromptPort, not
    // required from cli. The service consumes whatever the cli registered.
    const prompt = jest.fn(async () => 'deny');
    require('../src/services/permissionPromptPort').registerPermissionPrompter({ prompt });
    const { requestPermission } = require('../src/services/toolCalling');
    const decision = await requestPermission('qux_unapproved_tool', {});
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(decision).toBe('deny');
  });
});

describe('preflightPermission runPreflight — Ink channel skips classic batch dialog', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('with onControlRequest → returns empty sets and never opens the batch dialog', async () => {
    const promptBatch = jest.fn(async () => ({ decision: 'approve-all' }));
    require('../src/services/permissionPromptPort').registerPermissionPrompter({ promptBatch });
    const { runPreflight } = require('../src/services/preflightPermission');
    const res = await runPreflight(
      [{ name: 'writeFile' }, { name: 'shell_command' }],
      { onControlRequest: async () => true },
    );
    expect(res.approved.size).toBe(0);
    expect(res.denied.size).toBe(0);
    expect(promptBatch).not.toHaveBeenCalled();
  });
});
