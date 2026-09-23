'use strict';

/**
 * credential-lease broker (host side).
 *
 * Holds the long-lived credential behind an injected provider and hands out
 * short-lived leases to capability-bearing local clients. The refresh token /
 * master key never crosses the process boundary; only the access material the
 * provider returns does, with a bounded expiry.
 *
 * Invariants (borrowed conclusions, proposal 2026-09-18-tier1-minimax-code):
 * - `generation` is monotonic: revoke() invalidates every lease the host has
 *   issued, and clients discard cached tokens from an older generation.
 * - Single flight: concurrent lease requests collapse into one provider call.
 * - Fail closed: a wrong capability kills the connection.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const {
  PROTOCOL_VERSION,
  encodeFrame,
  createFrameDecoder,
  newCapability,
  verifyCapability,
  endpointPathFor,
} = require('./leaseProtocol');

const DEFAULTS = Object.freeze({
  refreshLeadMs: 5 * 60 * 1000,
  maxConnections: 32,
  idleTimeoutMs: 30 * 1000,
  minValidityMs: 0,
});

function _ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function _writePrivateFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on exotic FS */ }
}

function createLeaseBroker({
  dataDir,
  provider,
  namespace = '',
  refreshLeadMs = DEFAULTS.refreshLeadMs,
  maxConnections = DEFAULTS.maxConnections,
  idleTimeoutMs = DEFAULTS.idleTimeoutMs,
} = {}) {
  if (!dataDir) throw new Error('createLeaseBroker: dataDir is required');
  const getCredential = typeof provider === 'function'
    ? provider
    : (provider && typeof provider.getCredential === 'function' ? provider.getCredential.bind(provider) : null);
  if (!getCredential) {
    throw new Error('createLeaseBroker: provider must be an async getCredential() function or a { getCredential } object');
  }

  const runDir = _ensurePrivateDir(path.join(dataDir, 'run'));
  const endpoint = endpointPathFor(dataDir, { namespace });
  const capability = newCapability();
  const capabilityPath = path.join(runDir, `${PROTOCOL_VERSION}${namespace ? `-${namespace}` : ''}.cap`);
  const endpointPath = path.join(runDir, `${PROTOCOL_VERSION}${namespace ? `-${namespace}` : ''}.endpoint`);

  let generation = 1;
  let activeConnections = 0;
  let cached = null; // { token, expiresAt }
  let inflight = null; // single-flight promise for the provider call
  let closed = false;

  // Reuse the cached credential while it still outlives the refresh lead;
  // concurrent misses share one in-flight provider call.
  async function _acquire() {
    if (cached && cached.expiresAt - Date.now() > refreshLeadMs) return cached;
    if (!inflight) {
      inflight = (async () => {
        try {
          const cred = await getCredential();
          if (!cred || typeof cred.token !== 'string' || !Number.isFinite(cred.expiresAt)) {
            throw Object.assign(new Error('provider returned an unusable credential'), { code: 'bad-provider-result' });
          }
          cached = cred;
          return cred;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  }

  async function _handle(request) {
    if (!request || !verifyCapability(capability, request.capability)) {
      return { ok: false, code: 'unauthorized', fatal: true };
    }
    const op = request.op;
    if (op === 'status') {
      return { ok: true, op, protocol: PROTOCOL_VERSION, generation, cachedUntil: cached ? cached.expiresAt : null };
    }
    if (op === 'lease') {
      const minValidityMs = Number.isFinite(request.minValidityMs)
        ? Math.max(DEFAULTS.minValidityMs, request.minValidityMs)
        : DEFAULTS.minValidityMs;
      const cred = await _acquire();
      if (cred.expiresAt - Date.now() < minValidityMs) {
        return { ok: false, code: 'lease-window-too-small', generation };
      }
      return { ok: true, op, token: cred.token, expiresAt: cred.expiresAt, generation };
    }
    return { ok: false, code: 'unknown-op', generation };
  }

  const server = net.createServer((socket) => {
    if (activeConnections >= maxConnections || closed) {
      socket.destroy();
      return;
    }
    activeConnections += 1;
    socket.on('close', () => { activeConnections -= 1; });
    const decoder = createFrameDecoder();
    // net.Socket idle timeout: resets on traffic, only kills stalled connections.
    socket.setTimeout(idleTimeoutMs, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk) => decoder.push(chunk));
    decoder.on('error', () => socket.destroy());
    decoder.on('frame', async (frame) => {
      let response;
      try {
        response = await _handle(frame);
      } catch (error) {
        response = { ok: false, code: error && error.code ? error.code : 'lease-unavailable' };
      }
      if (response.fatal) {
        try { socket.write(encodeFrame({ ok: false, code: 'unauthorized' })); } catch { /* dying socket */ }
        socket.destroy();
        return;
      }
      try {
        socket.write(encodeFrame(response));
      } catch { /* client already gone */ }
      socket.destroy();
    });
  });

  server.on('error', (error) => {
    if (!closed) {
      // Surface startup failures (e.g. stale socket file) to the host, not silence.
      // eslint-disable-next-line no-console
      console.error(`credential-lease 监听失败 (${endpoint})：${error.message}`);
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(endpoint, () => {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(endpoint, 0o600); } catch { /* best effort */ }
      }
      _writePrivateFile(capabilityPath, capability);
      fs.writeFileSync(endpointPath, endpoint);
      resolve({
        endpoint,
        capability,
        capabilityPath,
        namespace,
        get generation() { return generation; },
        revoke() {
          generation += 1;
          cached = null;
          return generation;
        },
        close() {
          if (closed) return Promise.resolve();
          closed = true;
          return new Promise((done) => {
            server.close(() => {
              for (const f of [capabilityPath, endpointPath]) {
                try { fs.unlinkSync(f); } catch { /* already gone */ }
              }
              if (process.platform !== 'win32') {
                try { fs.unlinkSync(endpoint); } catch { /* already gone */ }
              }
              done();
            });
            server.unref();
          });
        },
      });
    });
    server.once('error', reject);
  });
}

module.exports = { createLeaseBroker, DEFAULTS };
