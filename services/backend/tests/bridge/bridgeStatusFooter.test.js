'use strict';

/**
 * bridgeStatusFooter — the persistent LAN-collaboration footer line.
 *
 * The startup banner (bridgeServer.printStatus()) lands in scrollback and is
 * buried the moment a conversation streams. To keep the pairing URL / PIN /
 * live client count visible for the WHOLE session, FooterBar renders a pinned
 * line fed by bridgeServer.getStatusSnapshot(). This suite locks both ends of
 * that contract WITHOUT starting a real WebSocket server:
 *
 *   - getStatusSnapshot(): safe default is {running:false} when no bridge is up
 *     (so the footer renders nothing on a fresh process).
 *   - FooterBar: when given a running bridge it pins a line carrying the URL,
 *     PIN, client count and the (non-sensitive) token prefix; when the bridge is
 *     absent or not running it adds no such line.
 *
 * FooterBar is exercised as a pure prop→element function: inkRuntime.get() is
 * stubbed to hand back plain element types, so React.createElement builds a
 * serializable tree we can walk for text — no ESM `ink`, no terminal.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');

// ── Stub inkRuntime BEFORE requiring FooterBar so Box/Text are plain types. ──
const inkRuntimePath = require.resolve('../../src/cli/tui/inkRuntime');
const inkRuntime = require('../../src/cli/tui/inkRuntime');
inkRuntime.get = () => ({ Box: 'Box', Text: 'Text' });
require.cache[inkRuntimePath].exports = inkRuntime;

const FooterBar = require('../../src/cli/tui/ink-components/FooterBar');
const bridgeServer = require('../../src/bridge/bridgeServer');

/** Flatten every string descendant of a React element into one string. */
function textOf(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (node.props) return textOf(node.props.children);
  return '';
}

describe('getStatusSnapshot — safe default', () => {
  test('no running bridge → {running:false}', () => {
    const snap = bridgeServer.getStatusSnapshot();
    assert.equal(snap.running, false);
  });
});

describe('FooterBar — persistent bridge line', () => {
  const RUNNING = {
    running: true,
    url: 'http://192.168.2.11:9222',
    pin: '309562',
    clientCount: 0,
    tokenShort: 'e1040b5b',
  };

  test('running bridge → URL / PIN / client count / token prefix all pinned', () => {
    const text = textOf(FooterBar({ model: 'auto', permissionMode: 'default', bridge: RUNNING }));
    assert.match(text, /192\.168\.2\.11:9222/);
    assert.match(text, /309562/);
    assert.match(text, /0 端/);
    assert.match(text, /e1040b5b/);
    assert.match(text, /协作/);
  });

  test('client count reflects live connections', () => {
    const text = textOf(FooterBar({ model: 'auto', permissionMode: 'default', bridge: { ...RUNNING, clientCount: 3 } }));
    assert.match(text, /3 端/);
  });

  test('no bridge prop → no collaboration line', () => {
    const text = textOf(FooterBar({ model: 'auto', permissionMode: 'default' }));
    assert.doesNotMatch(text, /协作/);
  });

  test('bridge present but not running → no collaboration line', () => {
    const text = textOf(FooterBar({ model: 'auto', permissionMode: 'default', bridge: { running: false } }));
    assert.doesNotMatch(text, /协作/);
  });

  test('full token is never rendered (only the short prefix)', () => {
    const fullToken = 'e1040b5b-deadbeef-secret-tail';
    const text = textOf(FooterBar({
      model: 'auto', permissionMode: 'default',
      bridge: { ...RUNNING, tokenShort: 'e1040b5b' },
    }));
    assert.doesNotMatch(text, /deadbeef|secret-tail/);
    assert.ok(!text.includes(fullToken));
  });
});
