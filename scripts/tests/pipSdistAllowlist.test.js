'use strict';

/**
 * Guards the post-build sdist allowlist in scripts/release/pip_packaging_rules.py.
 *
 * The rules module is Python (setup.py and MANIFEST.in generation consume it),
 * so the test drives it through a short Python probe and asserts on the JSON it
 * prints. Keeping the assertions here rather than in a lone .py file means they
 * run inside `npm run test:scripts`, which the PR quality gate already calls.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { searchExecutable } = require('../../services/backend/src/tools/platformUtils');

const RULES_DIR = path.join(__dirname, '..', 'release');
const CANDIDATES = process.platform === 'win32'
  ? ['python', 'py', 'python3']
  : ['python3', 'python'];

function pythonCommand() {
  for (const candidate of CANDIDATES) {
    if (searchExecutable(candidate)) return candidate;
  }
  return null;
}

const PROBE = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'from pip_packaging_rules import sdist_allowlist_violations',
  'members = [(item[0], item[1]) for item in json.loads(sys.argv[2])]',
  'print(json.dumps(sdist_allowlist_violations(members)))',
].join('\n');

/** Run the allowlist over `[relpath, size]` pairs; returns violating paths. */
function violations(python, members) {
  const result = spawnSync(python, ['-c', PROBE, RULES_DIR, JSON.stringify(members)], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `probe failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout).map((entry) => entry[0]);
}

test('sdist allowlist', async (t) => {
  const python = pythonCommand();
  if (!python) {
    t.skip('Python 3 not on PATH');
    return;
  }

  await t.test('accepts ordinary first-party source', () => {
    assert.deepEqual(violations(python, [
      ['services/backend/server.js', 1024],
      ['services/backend/src/models/index.js', 2048],
      ['platform/khy_platform/cli.py', 4096],
      ['docs/00_INDEX_文档索引.md', 8192],
      ['software/khyquant/frontend/src/App.vue', 4096],
      ['kernel/src/main.c', 2048],
      ['services/backend/wasm-indicators/moon.pkg', 256],
      ['Makefile', 512],
      ['Dockerfile.iso-builder', 1024],
      ['services/backend/.gitignore', 64],
      ['PKG-INFO', 15000],
    ]), []);
  });

  await t.test('rejects every leak class the 1.1.11 sdist shipped', () => {
    const leaked = violations(python, [
      ['services/backend/.khy/logs/heal-audit.jsonl', 523719],
      ['services/backend/.khy_quant_bootstrapped', 14],
      ['services/backend/test-wal-recovery.db-shm', 32768],
      ['services/backend/wasm-indicators/indicators.mbt.ast', 28362],
      ['services/backend/pack/khy-os-khy-os-1.2.3.tgz', 3],
      ['services/backend/src/skills/built-in/commit/prompt.html', 4964],
      ['docs/_assets/mermaid.min.js', 3271915],
    ]);
    assert.equal(leaked.length, 7, `expected all 7 flagged, got ${JSON.stringify(leaked)}`);
  });

  await t.test('the mermaid bundle is caught by size, not by suffix', () => {
    // Its suffix is .js, which the allowlist must keep allowing everywhere;
    // the single-file ceiling is what makes a regenerable 3 MB blob visible.
    assert.deepEqual(violations(python, [['docs/_assets/mermaid.min.js', 800000]]), []);
    assert.deepEqual(violations(python, [['docs/_assets/mermaid.min.js', 3271915]]),
      ['docs/_assets/mermaid.min.js']);
  });

  await t.test('the offline runtime bundle is exempt from the ceiling', () => {
    assert.deepEqual(
      violations(python, [['platform/khy_platform/bundled/runtime/khy/bundle.mjs', 17466501]]),
      [],
    );
  });

  await t.test('the five real HTML entry points survive the *.html ban', () => {
    assert.deepEqual(violations(python, [
      ['apps/ai-frontend/index.html', 325],
      ['software/khyquant/frontend/index.html', 1484],
      ['software/khyquant/frontend/ml-test.html', 14343],
      ['software/khyquant/frontend/public/offline.html', 2448],
      ['extensions/tools/khy-markdown/khyosMarkdown.html', 173895],
    ]), []);
  });

  await t.test('named binaries pass by pattern so a version bump does not break the build', () => {
    assert.deepEqual(violations(python, [
      ['extensions/bridges/khy-trae-bridge/khy-trae-bridge-0.2.1.vsix', 8053],
      ['extensions/bridges/khy-trae-bridge/khy-trae-bridge-9.9.9.vsix', 8053],
      ['extensions/tools/khy-markdown/KhyosMarkdown.exe', 4608],
      ['software/khyquant/frontend/public/wasm/khy-math-demo.wasm', 41],
    ]), []);
    // Same suffixes anywhere else stay rejected.
    assert.deepEqual(violations(python, [['services/backend/bin/helper.exe', 4608]]),
      ['services/backend/bin/helper.exe']);
  });
});
