'use strict';

/**
 * aiBackendModuleResolve.test.js — proves the NODE_PATH fallback makes a sibling
 * `services/ai-backend/` tree resolve backend's node_modules in a *bundle* layout
 * (node:test). This is the mechanism that stops the daemon 500s
 * ("Cannot find module '../../../ai-backend/src/middleware/auth'") on pip installs.
 *
 * We cannot run the real Windows pip install here, so we reconstruct the exact
 * bundle directory shape in a temp dir and drive resolution through a child
 * `node` process (NODE_PATH + Module._initPaths mutate global process state, so a
 * child gives a clean, isolated assertion each time).
 *
 * jest ignores node:test files (see jest.config.js); run via `npm run test:node`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BOOTSTRAP = path.resolve(__dirname, '../../src/bootstrap/aiBackendModuleResolve.js');

// Build a throwaway bundle-shaped tree:
//   <root>/services/backend/node_modules/<fakeDep>/index.js
//   <root>/services/backend/node_modules/@khy/shared/{package.json,models.js}
//   <root>/services/ai-backend/probe.js   (sibling — no ancestor node_modules)
function makeBundleLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-aibkres-'));
  const backendNM = path.join(root, 'services', 'backend', 'node_modules');
  fs.mkdirSync(path.join(backendNM, 'fakedep'), { recursive: true });
  fs.writeFileSync(
    path.join(backendNM, 'fakedep', 'package.json'),
    JSON.stringify({ name: 'fakedep', version: '1.0.0', main: 'index.js' }),
  );
  fs.writeFileSync(
    path.join(backendNM, 'fakedep', 'index.js'),
    'module.exports = { ok: true };\n',
  );

  // @khy/shared with an exports map exposing a subpath (mirrors the real shared
  // package: bare `@khy/shared/models` must resolve via exports, not main).
  const sharedDir = path.join(backendNM, '@khy', 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(
    path.join(sharedDir, 'package.json'),
    JSON.stringify({
      name: '@khy/shared',
      version: '1.6.5',
      exports: { '.': './index.js', './models': './models.js' },
    }),
  );
  fs.writeFileSync(path.join(sharedDir, 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(sharedDir, 'models.js'), 'module.exports = { User: "stub" };\n');

  const aiBackendDir = path.join(root, 'services', 'ai-backend');
  fs.mkdirSync(aiBackendDir, { recursive: true });

  return { root, backendNM, aiBackendDir };
}

// Run a snippet from inside the ai-backend dir via a child node process.
// Returns { code, stdout, stderr }.
function runFromAiBackend(aiBackendDir, backendNM, snippet, { withBootstrap }) {
  const pre = withBootstrap
    ? `require(${JSON.stringify(BOOTSTRAP)}).ensureAiBackendResolvable(` +
      `{ backendNodeModulesDir: ${JSON.stringify(backendNM)} });`
    : '';
  const code = `${pre}\n${snippet}`;
  try {
    const stdout = execFileSync(process.execPath, ['-e', code], {
      cwd: aiBackendDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Isolate: do not inherit an ambient NODE_PATH from the harness.
      env: { ...process.env, NODE_PATH: '' },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status == null ? 1 : err.status,
      stdout: (err.stdout || '').toString(),
      stderr: (err.stderr || '').toString(),
    };
  }
}

const _cleanup = [];
test.after(() => {
  for (const d of _cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('aiBackendModuleResolve.ensureAiBackendResolvable — bundle layout', () => {
  test('WITHOUT bootstrap: sibling ai-backend cannot resolve backend dep (MODULE_NOT_FOUND)', () => {
    const { root, backendNM, aiBackendDir } = makeBundleLayout();
    _cleanup.push(root);
    const r = runFromAiBackend(
      aiBackendDir, backendNM,
      "require('fakedep'); console.log('RESOLVED');",
      { withBootstrap: false },
    );
    assert.notEqual(r.code, 0, 'baseline must fail — proves the layout reproduces the bug');
    assert.match(r.stderr, /Cannot find module 'fakedep'|MODULE_NOT_FOUND/);
  });

  test('WITH bootstrap: sibling ai-backend resolves the backend dep', () => {
    const { root, backendNM, aiBackendDir } = makeBundleLayout();
    _cleanup.push(root);
    const r = runFromAiBackend(
      aiBackendDir, backendNM,
      "const m = require('fakedep'); if (!m.ok) throw new Error('bad'); console.log('RESOLVED');",
      { withBootstrap: true },
    );
    assert.equal(r.code, 0, `should resolve after bootstrap; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /RESOLVED/);
  });

  test('WITH bootstrap: @khy/shared subpath resolves via its exports map', () => {
    const { root, backendNM, aiBackendDir } = makeBundleLayout();
    _cleanup.push(root);
    const r = runFromAiBackend(
      aiBackendDir, backendNM,
      "const models = require('@khy/shared/models'); " +
      "if (models.User !== 'stub') throw new Error('bad subpath'); console.log('RESOLVED');",
      { withBootstrap: true },
    );
    assert.equal(r.code, 0, `@khy/shared/models should resolve via exports; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /RESOLVED/);
  });

  test('idempotent: a second call does not grow NODE_PATH', () => {
    const { root, backendNM, aiBackendDir } = makeBundleLayout();
    _cleanup.push(root);
    const snippet =
      `const b = require(${JSON.stringify(BOOTSTRAP)});` +
      `const first = b.ensureAiBackendResolvable({ backendNodeModulesDir: ${JSON.stringify(backendNM)} });` +
      `const before = process.env.NODE_PATH;` +
      `const second = b.ensureAiBackendResolvable({ backendNodeModulesDir: ${JSON.stringify(backendNM)} });` +
      `if (first !== true) throw new Error('first call should mutate');` +
      `if (second !== false) throw new Error('second call should be no-op');` +
      `if (process.env.NODE_PATH !== before) throw new Error('NODE_PATH grew on repeat');` +
      `console.log('OK');`;
    const r = runFromAiBackend(aiBackendDir, backendNM, snippet, { withBootstrap: false });
    assert.equal(r.code, 0, `idempotency failed; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /OK/);
  });

  test('fail-soft: non-existent node_modules dir → returns false, does not throw', () => {
    const b = require('../../src/bootstrap/aiBackendModuleResolve');
    const missing = path.join(os.tmpdir(), 'khy-does-not-exist-xyz', 'node_modules');
    assert.equal(b.ensureAiBackendResolvable({ backendNodeModulesDir: missing }), false);
  });

  test('_backendNodeModulesDir points at services/backend/node_modules', () => {
    const b = require('../../src/bootstrap/aiBackendModuleResolve');
    const dir = b.__test__._backendNodeModulesDir();
    assert.match(dir.replace(/\\/g, '/'), /services\/backend\/node_modules$/);
  });
});
