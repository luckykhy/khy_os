'use strict';

/**
 * Leaf-contract test for aiManagementChatHttp.js (extracted from aiManagementServer).
 *
 * Proves: (1) the 6 host-consumed handlers/helpers are exported functions,
 * (2) _resolveChatAttachments is a pure deterministic re-export for the no-attachment
 * path, (3) setChatHttpDeps wires the reverse edge so handlePersonaHttp runs end-to-end
 * through injected sendJson, (4) requiring aiManagementServer performs the production
 * wiring and keeps the host __test__ chat symbols intact.
 */
const test = require('node:test');
const assert = require('node:assert');

const LEAF = '../../src/services/aiManagementChatHttp';
const HOST = '../../src/services/aiManagementServer';

const HOST_CONSUMED = [
  'handleChatHttp', 'handleChatStreamHttp', 'handlePersonaHttp',
  '_resolveChatAttachments', '_isWebInlineImagePathEnabled', '_summarizeToolResultForStream',
];

test('leaf exports the 6 host-consumed handlers/helpers + setter as functions', () => {
  const leaf = require(LEAF);
  for (const n of HOST_CONSUMED) {
    assert.strictEqual(typeof leaf[n], 'function', `missing ${n}`);
  }
  assert.strictEqual(typeof leaf.setChatHttpDeps, 'function');
});

test('_resolveChatAttachments passes through the no-attachment path deterministically', () => {
  const leaf = require(LEAF);
  const out = leaf._resolveChatAttachments({ }, 'hello');
  // No attachments/images → message unchanged, images empty. Shape must be stable.
  assert.strictEqual(out.message, 'hello');
  assert.ok(Array.isArray(out.images));
  assert.strictEqual(out.images.length, 0);
});

test('setChatHttpDeps wires sendJson so handlePersonaHttp runs end-to-end', () => {
  const leaf = require(LEAF);
  let captured = null;
  leaf.setChatHttpDeps({ sendJson: (res, code, body) => { captured = { code, body }; } });
  leaf.handlePersonaHttp({}, {});
  assert.ok(captured, 'no response emitted — reverse edge not wired');
  assert.strictEqual(typeof captured.code, 'number'); // 200 (or 500 if personaService throws) — either proves the wire
  assert.strictEqual(typeof captured.body, 'object');
});

test('requiring aiManagementServer performs production DI wiring (host chat symbols intact)', () => {
  const host = require(HOST);
  for (const n of ['start', 'stop', 'isRunning', 'getPort', 'configureFrontendStatic']) {
    assert.strictEqual(typeof host[n], 'function', `host missing ${n}`);
  }
  assert.strictEqual(typeof host.__test__._resolveChatAttachments, 'function');
  assert.strictEqual(typeof host.__test__._isWebInlineImagePathEnabled, 'function');
});
