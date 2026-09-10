'use strict';
/**
 * Leaf-contract test for aiManagementKhyosWs.js (extracted from the aiManagementServer god-file).
 *
 * The KHY OS terminal/desktop WS handlers hold ZERO module-scope state (everything lives on the
 * passed-in `session`), and their only reverse edge is the stateless `wsSend`, injected via
 * setKhyosDeps. This test proves: (1) the six host-consumed handlers are exported functions,
 * (2) setKhyosDeps wires wsSend so a handler can emit a frame, (3) requiring aiManagementServer
 * performs that wiring for production (no manual injection needed downstream).
 */
const LEAF = '../../src/services/aiManagementKhyosWs';
const HOST = '../../src/services/aiManagementServer';

describe('Ai Management Khyos Ws Leaf', () => {
  test('leaf exports the six host-consumed handlers as functions', () => {
      const leaf = require(LEAF);
      for (const n of ['handleKhyosStart', 'handleKhyosInput', 'handleKhyosStop',
        'handleKhyosDesktopStart', 'handleKhyosDesktopStop', 'stopKhyosDesktopStream']) {
        expect(typeof leaf[n]).toBe('function', `missing handler ${n}`);
      }
      expect(typeof leaf.setKhyosDeps).toBe('function');
  });

  test('setKhyosDeps injects wsSend so a desktop-stop emits a frame through the host sender', () => {
      const leaf = require(LEAF);
      const sent = [];
      leaf.setKhyosDeps({ wsSend: (session, data) => sent.push(data) });
      const session = { ws: { readyState: 1, send: () => {} } };
      leaf.handleKhyosDesktopStop(session);
      expect(sent.length).toBe(1);
      expect(sent[0]).toEqual({ type: 'khyos_desktop_status', status: 'stopped' });
  });

  test('requiring aiManagementServer wires wsSend for production (frame reaches session.ws.send)', () => {
      require(HOST); // load-time setKhyosDeps({ wsSend }) runs
      const leaf = require(LEAF);
      const frames = [];
      const session = { ws: { readyState: 1, send: (s) => frames.push(s) } };
      leaf.handleKhyosDesktopStop(session);
      expect(frames.length).toBe(1);
      expect(frames[0]).toMatch(/"type":"khyos_desktop_status"/);
      expect(frames[0]).toMatch(/"status":"stopped"/);
  });

});

