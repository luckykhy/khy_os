'use strict';

/**
 * Regression: ai-backend must resolve its data home to the SAME root as the main
 * backend, so a single daemon never writes to both ~/.khy (backend, via
 * getAppHome) AND ~/.khyquant (ai-backend's old bare `os.homedir()+'.khyquant'`)
 * on a fresh HOME.
 *
 * Root cause (P0): every ai-backend service hardcoded
 *   const KHY_DIR = path.join(os.homedir(), '.khyquant');
 * while the main backend converges to getAppHome() (legacy-established-wins, else
 * ~/.khy). On a brand-new machine the two diverged → dual-write. The fix routes
 * ai-backend through services/ai-backend/src/utils/dataHome.js, a thin forward to
 * the backend's getAppHome()/getAppDataDir() single source of truth.
 *
 * node:test (NOT jest — jest tears down before async bodies run; see jest.config.js
 * which auto-ignores `require('node:test')` suites). Run: `node --test`.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backendDataHome = require('../src/utils/dataHome');
const aiBackendDataHome = require('../../ai-backend/src/utils/dataHome');

// Env that steers dataHome resolution — neutralized so the test exercises the
// pure HOME-derived path. getDataHome() also WRITES process.env.KHY_DATA_HOME as
// a memoization side effect, so we snapshot/restore the whole set.
const STEERING_ENV = [
  'HOME', 'USERPROFILE',
  'KHY_DATA_HOME', 'KHY_APP_HOME', 'KHY_OS_ROOT',
  'KHY_PROJECT_DATA_HOME', 'KHYOS_HOME', 'KHY_LOCATION_FILE',
];

let saved;
let freshHome;

beforeEach(() => {
  saved = {};
  for (const k of STEERING_ENV) saved[k] = process.env[k];
  freshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-fresh-home-'));
  // Brand-new machine: only HOME is set, no legacy dir established, no overrides.
  for (const k of STEERING_ENV) delete process.env[k];
  process.env.HOME = freshHome;
  process.env.USERPROFILE = freshHome; // win32 parity
  backendDataHome._resetStorageCaches();
});

afterEach(() => {
  for (const k of STEERING_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  backendDataHome._resetStorageCaches();
  try { fs.rmSync(freshHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('ai-backend ↔ backend data-home convergence', () => {
  test('ai-backend forwards the backend single source of truth (same object/fns)', () => {
    for (const fn of ['getAppHome', 'getAppDataDir', 'getLegacyDataHome']) {
      assert.equal(
        typeof aiBackendDataHome[fn], 'function',
        `ai-backend dataHome must expose ${fn}`,
      );
      assert.equal(
        aiBackendDataHome[fn], backendDataHome[fn],
        `${fn} must be the very same backend implementation (thin forward)`,
      );
    }
  });

  test('fresh HOME: backend getAppHome() === root of ai-backend persistence files', () => {
    const appHome = backendDataHome.getAppHome();
    const poolFile = aiBackendDataHome.getAppDataDir('api_keys.json');

    assert.equal(
      path.dirname(poolFile), appHome,
      'ai-backend key file must live directly under backend getAppHome()',
    );
    // On a brand-new HOME the converged root is ~/.khy (no legacy ~/.khyquant).
    assert.equal(appHome, path.join(freshHome, '.khy'));
    assert.ok(
      !appHome.endsWith('.khyquant'),
      'fresh HOME must not resolve to the legacy .khyquant root',
    );
  });

  test('fresh HOME: no .khy / .khyquant dual-write — every key file shares one root', () => {
    const roots = new Set([
      path.dirname(aiBackendDataHome.getAppDataDir('api_keys.json')),
      path.dirname(aiBackendDataHome.getAppDataDir('ai_gateway_pricing.json')),
      path.dirname(aiBackendDataHome.getAppDataDir('ai_gateway_customer_usage.json')),
      path.dirname(aiBackendDataHome.getAppDataDir('tool_permissions.json')),
      path.dirname(aiBackendDataHome.getAppDataDir('skills_cache.json')),
      backendDataHome.getAppHome(),
    ]);
    assert.equal(roots.size, 1, `all data must converge to one root, got: ${[...roots].join(', ')}`);
  });
});
