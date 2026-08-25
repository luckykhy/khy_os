'use strict';

/**
 * `khy mobile app` pairing helpers.
 *
 * Run: node --test tests/cli/mobilePairing.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect the data home to a scratch dir BEFORE anything resolves it, so the
// test never touches the developer's real backend_runtime.json.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-pairing-'));
process.env.KHY_DATA_HOME = scratch;
require('../../src/utils/dataHome')._resetStorageCaches();

const backendRuntime = require('../../src/utils/backendRuntime');
const { resolveBackendPort, buildPairingPayload } = require('../../src/cli/handlers/mobile');
const { BACKEND_PORT } = require('../../src/constants/serviceDefaults');

test('resolveBackendPort: prefers the port the backend actually listens on', () => {
  const actual = BACKEND_PORT + 7;
  assert.equal(backendRuntime.writeBackendRuntime(actual), true);
  try {
    assert.deepEqual(resolveBackendPort(), { port: actual, source: 'runtime' });
  } finally {
    backendRuntime.clearBackendRuntime();
  }
});

test('resolveBackendPort: falls back to the configured port when no runtime record exists', () => {
  backendRuntime.clearBackendRuntime();
  assert.deepEqual(resolveBackendPort(), { port: BACKEND_PORT, source: 'config' });
});

test('buildPairingPayload: encodes the API root as JSON, not a bare URL', () => {
  const { payload, apiBaseUrl } = buildPairingPayload('192.168.1.9', BACKEND_PORT);
  assert.equal(apiBaseUrl, `http://192.168.1.9:${BACKEND_PORT}`);
  assert.deepEqual(JSON.parse(payload), { apiBaseUrl });
  // The App treats a path-carrying base as the management-page QR and refuses it.
  assert.equal(new URL(apiBaseUrl).pathname, '/');
});
