'use strict';

/**
 * deploy.detector.test.js — signal-driven project detection.
 *
 * Verifies that detectProject derives install/build/start commands purely from
 * on-disk signals (manifests, lockfiles, declared scripts) with zero hardcoded
 * application knowledge, is cross-platform, and never fabricates a start
 * command when it cannot determine one.
 *
 * All filesystem access goes through an in-memory fs stub — zero real I/O.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { detectProject } = require('../src/services/deploy/projectDetector');

/** Build an in-memory fs from a { relPath: contents } map rooted at `root`. */
function makeFs(root, files) {
  const abs = (rel) => path.resolve(root, rel);
  const table = new Map();
  for (const [rel, val] of Object.entries(files)) table.set(abs(rel), val);
  return {
    existsSync: (p) => table.has(path.resolve(p)),
    readFileSync: (p) => {
      const v = table.get(path.resolve(p));
      if (v == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return typeof v === 'string' ? v : JSON.stringify(v);
    },
  };
}

const ROOT = '/proj';

describe('detectProject — Node', () => {
  test('npm + lockfile → npm ci, build + start scripts', () => {
    const fs = makeFs(ROOT, {
      'package.json': { scripts: { build: 'tsc', start: 'node dist/index.js' } },
      'package-lock.json': '{}',
    });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.equal(plan.type, 'node');
    assert.equal(plan.packageManager, 'npm');
    assert.deepEqual(plan.install.args, ['ci']);
    assert.deepEqual(plan.build.args, ['run', 'build']);
    assert.deepEqual(plan.start.args, ['run', 'start']);
  });

  test('no lockfile → npm install', () => {
    const fs = makeFs(ROOT, { 'package.json': { scripts: { start: 'x' } } });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.deepEqual(plan.install.args, ['install']);
  });

  test('pnpm lockfile → pnpm install/run', () => {
    const fs = makeFs(ROOT, {
      'package.json': { scripts: { start: 'x', build: 'y' } },
      'pnpm-lock.yaml': '',
    });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.equal(plan.packageManager, 'pnpm');
    assert.equal(plan.install.exe, 'pnpm');
    assert.deepEqual(plan.start.args, ['run', 'start']);
  });

  test('no start script → falls back to package.json main when present', () => {
    const fs = makeFs(ROOT, {
      'package.json': { main: 'server.js' },
      'server.js': '',
    });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.equal(plan.start.exe, 'node');
    assert.deepEqual(plan.start.args, ['server.js']);
    assert.ok(plan.notes.some((n) => n.includes('main')));
  });

  test('no start/main → probes common entry files', () => {
    const fs = makeFs(ROOT, { 'package.json': {}, 'index.js': '' });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.deepEqual(plan.start.args, ['index.js']);
  });

  test('no start signal at all → start is null, note recorded (no fabrication)', () => {
    const fs = makeFs(ROOT, { 'package.json': {} });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.equal(plan.start, null);
    assert.ok(plan.notes.some((n) => n.includes('无法确定')));
  });

  test('Windows resolves npm to npm.cmd', () => {
    const fs = makeFs(ROOT, { 'package.json': { scripts: { start: 'x' } } });
    const plan = detectProject(ROOT, { fs, platform: 'win32' });
    assert.equal(plan.install.exe, 'npm.cmd');
  });
});

describe('detectProject — Python', () => {
  test('requirements.txt → pip install -r', () => {
    const fs = makeFs(ROOT, { 'requirements.txt': 'flask\n', 'app.py': '' });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.equal(plan.type, 'python');
    assert.deepEqual(plan.install.args, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
    assert.deepEqual(plan.start.args, ['app.py']);
  });

  test('Django manage.py → runserver + default port', () => {
    const fs = makeFs(ROOT, { 'requirements.txt': '', 'manage.py': '' });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.deepEqual(plan.start.args, ['manage.py', 'runserver']);
    assert.equal(plan.port, 8000);
  });

  test('Procfile web line wins over entry-file probing', () => {
    const fs = makeFs(ROOT, {
      'requirements.txt': '',
      'Procfile': 'web: gunicorn app:app\n',
      'app.py': '',
    });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.equal(plan.start.exe, 'gunicorn');
    assert.deepEqual(plan.start.args, ['app:app']);
  });

  test('pyproject without requirements → pip install .', () => {
    const fs = makeFs(ROOT, { 'pyproject.toml': '[project]\n', 'main.py': '' });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.deepEqual(plan.install.args, ['-m', 'pip', 'install', '.']);
  });
});

describe('detectProject — other ecosystems', () => {
  test('go.mod → go build/run', () => {
    const plan = detectProject(ROOT, { fs: makeFs(ROOT, { 'go.mod': 'module x\n' }), platform: 'linux' });
    assert.equal(plan.type, 'go');
    assert.deepEqual(plan.start.args, ['run', '.']);
  });

  test('Cargo.toml → cargo build --release', () => {
    const plan = detectProject(ROOT, { fs: makeFs(ROOT, { 'Cargo.toml': '' }), platform: 'linux' });
    assert.equal(plan.type, 'rust');
    assert.deepEqual(plan.build.args, ['build', '--release']);
  });

  test('static index.html → http.server', () => {
    const plan = detectProject(ROOT, { fs: makeFs(ROOT, { 'index.html': '<html>' }), platform: 'linux' });
    assert.equal(plan.type, 'static');
    assert.equal(plan.port, 8080);
  });

  test('Makefile with run target → make run', () => {
    const mk = 'build:\n\tgcc\nrun:\n\t./a.out\n';
    const plan = detectProject(ROOT, { fs: makeFs(ROOT, { 'Makefile': mk }), platform: 'linux' });
    assert.equal(plan.type, 'make');
    assert.deepEqual(plan.build.args, ['build']);
    assert.deepEqual(plan.start.args, ['run']);
  });

  test('unknown project → type unknown, honest note', () => {
    const plan = detectProject(ROOT, { fs: makeFs(ROOT, { 'README.md': '' }), platform: 'linux' });
    assert.equal(plan.type, 'unknown');
    assert.equal(plan.start, null);
    assert.ok(plan.notes.length > 0);
  });

  test('Node manifest takes precedence over Python when both present', () => {
    const fs = makeFs(ROOT, { 'package.json': { scripts: { start: 'x' } }, 'requirements.txt': '' });
    const plan = detectProject(ROOT, { fs, platform: 'linux' });
    assert.equal(plan.type, 'node');
  });
});
