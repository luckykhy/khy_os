'use strict';

/**
 * bridgeUrlHint — single place that knows how to build the bridge collaboration
 * URL for "khy chat" / "gateway manage open" / FooterBar hints.
 *
 * The real source of truth is the bridge module's own `getDisplayUrl(port)`
 * (services/backend/src/bridge/bridgeServer.js:963), which knows the actual
 * bind host and degrades to loopback when the bridge is bound to 127.0.0.1.
 * This hint module is a thin shim that:
 *   1. Asks the bridge for its current display URL when it's running
 *      (so the URL never advertises a LAN IP the bridge is not bound to).
 *   2. Falls back to a configured default from constants/serviceDefaults.js
 *      (BRIDGE_DEFAULT_PORT) when the bridge is not yet up — but only when the
 *      caller asks for `mode=chat` URL construction; in that case we still
 *      report `running:false` so callers can `ensureBridgeStarted` first.
 *
 * The point: callers (gatewayManageDaemon, FooterBar, khy doctor) get ONE
 * function to ask for "the chat URL right now" without each writing its own
 * LAN-vs-loopback reasoning.
 */

const { BRIDGE_DEFAULT_PORT } = require('../constants/serviceDefaults');

function _tryLoadBridge() {
  try {
    // Lazy require so importing this module never pulls in WS/multer/etc.
    // (it might be loaded by lightweight TUI code paths).
    return require('./bridgeServer');
  } catch {
    return null;
  }
}

/**
 * @returns {{
 *   url: string,        // bare collaboration URL, e.g. http://192.168.1.193:9222/
 *   chatUrl: string,    // url + ?mode=chat, suitable for khy chat open-in-browser
 *   running: boolean,   // true iff the bridge server is actually listening
 *   port: number,       // 0 when not running
 *   localOnly: boolean  // true when bound to 127.0.0.1 (advertised host is local)
 * }}
 */
function getBridgeChatUrl() {
  const bridge = _tryLoadBridge();
  const port = bridge && typeof bridge.getPort === 'function' ? bridge.getPort() : 0;
  if (!bridge || !port) {
    // Not running — caller is responsible for starting the bridge first.
    // We still return a best-guess URL (loopback) so the UI can render
    // something before the bridge is up. The `running:false` flag is what
    // callers should branch on for actual behavior.
    const fallbackUrl = `http://127.0.0.1:${BRIDGE_DEFAULT_PORT}/`;
    return {
      url: fallbackUrl,
      chatUrl: fallbackUrl + '?mode=chat',
      running: false,
      port: 0,
      localOnly: true,
    };
  }
  const { url, localOnly } = bridge.getDisplayUrl(port);
  return {
    url,
    chatUrl: url + '?mode=chat',
    running: true,
    port,
    localOnly,
  };
}

module.exports = { getBridgeChatUrl };
