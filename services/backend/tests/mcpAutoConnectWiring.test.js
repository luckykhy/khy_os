'use strict';
/**
 * MCP auto-connect wiring: the default manager must actually be the MCP client.
 *
 * Bug (RED until F7): `autoConnect.js` sets its default manager to
 * `../../../../agents/index` — the AGENT registry, which has no `loadConfig` /
 * `connectAll`. So `ensureMcpConnected()` with the default (i.e. the two
 * production call sites: the 9090 management server and the tool-loop) never
 * reaches the real MCP client, and configured external MCP servers are silently
 * never connected.
 *
 * This test mocks the MCP client module and drives `ensureMcpConnected()` with
 * its DEFAULT manager, then asserts the client's `connectAll` is actually
 * invoked. Today the default points elsewhere, so the mock is never called.
 */

const connectAllCalls = [];
const mockConnectAllCalls = connectAllCalls; // alias so the hoisted factory may reference it
jest.mock('../src/services/domain/messaging/mcp/index', () => {
  return {
    loadConfig(projectDir) {
      return { mcpServers: { srv: { command: 'node', args: ['x'] } } };
    },
    async connectAll(projectDir, onProgress) {
      mockConnectAllCalls.push({ projectDir, onProgress });
      return { connected: ['srv'], failed: [] };
    },
  };
}, { virtual: false });

let autoConnect;

beforeEach(() => {
  connectAllCalls.length = 0;
  delete require.cache[require.resolve('../src/services/domain/messaging/mcp/autoConnect')];
  autoConnect = require('../src/services/domain/messaging/mcp/autoConnect');
});

describe('MCP auto-connect default-manager wiring', () => {
  test('ensureMcpConnected() with the default manager dispatches to the MCP client connectAll', async () => {
    const result = await autoConnect.ensureMcpConnected({
      env: { ...process.env, KHY_MCP_AUTOCONNECT: 'true' },
      projectDir: 'C:\\proj',
      state: { started: false },
    });

    // The real MCP client must have been invoked (not the agent registry).
    expect(connectAllCalls.length).toBe(1);
    expect(connectAllCalls[0].projectDir).toBe('C:\\proj');
    expect(result.connected).toEqual(['srv']);
    expect(result.skipped).toBeUndefined();
  });

  test('the default manager is capable (exposes loadConfig + connectAll)', () => {
    // Reach the default manager through the public surface: when a config has
    // servers, ensureMcpConnected must NOT report a "no-servers"/"unsupported"
    // skip — those are exactly what the mis-pointed default produces.
    const result = autoConnect.ensureMcpConnected({
      env: { ...process.env, KHY_MCP_AUTOCONNECT: 'true' },
      state: { started: false },
    });
    // await it (the function is async)
    return result.then((r) => {
      expect(r.skipped).toBeUndefined();
      expect(Array.isArray(r.connected)).toBe(true);
    });
  });

  test('gate off still yields legacy no-connect (regression pin)', async () => {
    const result = await autoConnect.ensureMcpConnected({
      env: { KHY_MCP_AUTOCONNECT: 'false' },
      state: { started: false },
    });
    expect(result.skipped).toBe('disabled');
    expect(connectAllCalls.length).toBe(0);
  });
});
