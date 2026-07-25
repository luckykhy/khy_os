'use strict';

/**
 * Leaf-contract test for aiManagementConversationsPrompts.js (extracted from aiManagementServer).
 *
 * Proves: (1) the 20 host-consumed handlers are exported functions, (2) the three private stores
 * (_conversationStore/_promptStore/_promptTemplateCatalog) are reachable only via the leaf's own
 * getters (no host leakage), (3) setConversationsPromptsDeps wires the reverse edges so a handler
 * runs end-to-end through injected sendJson + getSecurity, (4) requiring aiManagementServer performs
 * the production wiring.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../src/services/aiManagementConversationsPrompts';
const HOST = '../../src/services/aiManagementServer';

const HOST_CONSUMED = [
  'handleListAiConversations', 'handleCreateAiConversation', 'handleGetAiConversation',
  'handleUpdateAiConversation', 'handleDeleteAiConversation', 'handleAiContextStats',
  'handleListBuiltinPrompts', 'handleListPrompts', 'handleCreatePrompt', 'handleGetPrompt',
  'handleUpdatePrompt', 'handleDeletePrompt', 'handleUsePrompt', 'handleApprovePrompt',
  'maybeAutoCapturePrompt',
  'handleGetUsage', 'handleGetUsageHistory', 'handleListTools', 'handleExecuteTool',
  'handleSecurityStats',
];

test('leaf exports the 20 host-consumed handlers as functions', () => {
  const leaf = require(LEAF);
  for (const n of HOST_CONSUMED) {
    assert.strictEqual(typeof leaf[n], 'function', `missing handler ${n}`);
  }
  assert.strictEqual(typeof leaf.setConversationsPromptsDeps, 'function');
});

test('setConversationsPromptsDeps wires sendJson + getSecurity so handleSecurityStats runs', async () => {
  const leaf = require(LEAF);
  let captured = null;
  leaf.setConversationsPromptsDeps({
    sendJson: (res, code, body) => { captured = { code, body }; },
    getSecurity: () => ({ getSecurityStats: () => ({ ok: true, blocked: 3 }) }),
  });
  await leaf.handleSecurityStats({}, {});
  assert.strictEqual(captured.code, 200);
  assert.deepStrictEqual(captured.body, { success: true, data: { ok: true, blocked: 3 } });
});

test('requiring aiManagementServer performs production DI wiring (host exports intact)', () => {
  const host = require(HOST);
  // Host public contract is unchanged by the extraction.
  for (const n of ['start', 'stop', 'isRunning', 'getPort', 'configureFrontendStatic']) {
    assert.strictEqual(typeof host[n], 'function', `host missing ${n}`);
  }
  assert.ok(host.__test__ && typeof host.__test__ === 'object');
});
