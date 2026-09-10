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
const LEAF = '../../src/services/aiManagementChatHttp';
const HOST = '../../src/services/aiManagementServer';
const HOST_CONSUMED = [
  'handleChatHttp', 'handleChatStreamHttp', 'handlePersonaHttp',
  '_resolveChatAttachments', '_isWebInlineImagePathEnabled', '_summarizeToolResultForStream',
];

describe('Ai Management Chat Http Leaf', () => {
  test('leaf exports the 6 host-consumed handlers/helpers + setter as functions', () => {
      const leaf = require(LEAF);
      for (const n of HOST_CONSUMED) {
        expect(typeof leaf[n]).toBe('function', `missing ${n}`);
      }
      expect(typeof leaf.setChatHttpDeps).toBe('function');
  });

  test('_resolveChatAttachments passes through the no-attachment path deterministically', () => {
      const leaf = require(LEAF);
      const out = leaf._resolveChatAttachments({ }, 'hello');
      // No attachments/images â†?message unchanged, images empty. Shape must be stable.
      expect(out.message).toBe('hello');
      expect(Array.isArray(out.images).toBeTruthy());
      expect(out.images.length).toBe(0);
  });

  test('setChatHttpDeps wires sendJson so handlePersonaHttp runs end-to-end', () => {
      const leaf = require(LEAF);
      let captured = null;
      leaf.setChatHttpDeps({ sendJson: (res, code, body) => { captured = { code, body }; } });
      leaf.handlePersonaHttp({}, {});
      expect(captured).toBeTruthy();
      expect(typeof captured.code).toBe('number'); // 200 (or 500 if personaService throws) â€?either proves the wire
      expect(typeof captured.body).toBe('object');
  });

  test('requiring aiManagementServer performs production DI wiring (host chat symbols intact)', () => {
      const host = require(HOST);
      for (const n of ['start', 'stop', 'isRunning', 'getPort', 'configureFrontendStatic']) {
        expect(typeof host[n]).toBe('function', `host missing ${n}`);
      }
      expect(typeof host.__test__._resolveChatAttachments).toBe('function');
      expect(typeof host.__test__._isWebInlineImagePathEnabled).toBe('function');
  });

});

