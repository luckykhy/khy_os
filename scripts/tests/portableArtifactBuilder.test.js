'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  resolveInputs,
  isExcludedSource,
  runtimeSourceFilter,
  copyTree,
  writeLaunchers,
} = require('../portable/build-portable-artifact');

function dirent(name, kind) {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
  };
}

test('parses each supported artifact kind and target', () => {
  const runtime = parseArgs([
    '--kind', 'portable-runtime', '--platform', 'macos', '--arch', 'arm64', '--plan',
  ]);
  assert.equal(runtime.kind, 'portable-runtime');
  assert.equal(runtime.platform, 'darwin');
  assert.equal(runtime.arch, 'arm64');
  assert.equal(runtime.plan, true);

  const inputs = resolveInputs(runtime);
  assert.match(inputs.artifactName, /^portable-runtime-.+-macos-arm64$/);
  assert.equal(Object.hasOwn(inputs, 'executable'), false);
});

test('source filter excludes state, secrets and generated databases', () => {
  assert.equal(isExcludedSource('.khy', dirent('.khy', 'dir')), true);
  assert.equal(isExcludedSource('dist', dirent('dist', 'dir')), true);
  assert.equal(isExcludedSource('services/backend/.env.local', dirent('.env.local', 'file')), true);
  assert.equal(isExcludedSource('services/backend/data/live.db-wal', dirent('live.db-wal', 'file')), true);
  assert.equal(isExcludedSource('services/backend/src/server.js', dirent('server.js', 'file')), false);
  assert.equal(isExcludedSource('node_modules/pkg/index.js', dirent('index.js', 'file')), false);
});

test('runtime source filter keeps application dependencies and excludes developer trees', () => {
  assert.equal(runtimeSourceFilter('node_modules/express/index.js', dirent('index.js', 'file')), true);
  assert.equal(runtimeSourceFilter('services/backend/bin/khy.js', dirent('khy.js', 'file')), true);
  assert.equal(runtimeSourceFilter('platform/packages/shared/src/index.js', dirent('index.js', 'file')), true);
  assert.equal(runtimeSourceFilter('software/khyquant/services/market.js', dirent('market.js', 'file')), true);
  assert.equal(runtimeSourceFilter('software/khyquant/frontend/node_modules/vue/index.js', dirent('index.js', 'file')), false);
  assert.equal(runtimeSourceFilter('services/backend/node_modules/express/index.js', dirent('index.js', 'file')), false);
  assert.equal(runtimeSourceFilter('services/backend/tests/cli.test.js', dirent('cli.test.js', 'file')), false);
  assert.equal(runtimeSourceFilter('apps', dirent('apps', 'dir')), false);
  assert.equal(runtimeSourceFilter('docs', dirent('docs', 'dir')), false);
  assert.equal(runtimeSourceFilter('services/backend/data/live.db', dirent('live.db', 'file')), false);
});

test('copyTree handles relocated paths with spaces and Chinese characters', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy artifact copy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, '源 目录');
  const destination = path.join(base, '目标 目录');
  fs.mkdirSync(path.join(source, '子目录'), { recursive: true });
  fs.writeFileSync(path.join(source, '子目录', '文件.txt'), 'portable');

  const result = copyTree(source, destination, { skipSymlinks: true });
  assert.equal(result.copiedFiles, 1);
  assert.equal(fs.readFileSync(path.join(destination, '子目录', '文件.txt'), 'utf8'), 'portable');
});

test('launchers derive all state from their own artifact directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeLaunchers(root, 'portable-runtime', { platform: 'win32', arch: 'x64' });
  const batch = fs.readFileSync(path.join(root, 'launch.bat'), 'utf8');
  assert.match(batch, /set "ROOT=%~dp0"/);
  assert.match(batch, /set "KHY_DATA_HOME=%ROOT%state\\\.khy"/);
  assert.match(batch, /set "KHYOS_HOME=%ROOT%state\\\.khy"/);
  assert.match(batch, /set "KHY_CACHE_HOME=%ROOT%state\\\.khy\\cache"/);
  assert.match(batch, /set "PATH=%ROOT%runtime\\node;%ROOT%runtime\\python;%PATH%"/);
  assert.match(batch, /set "PYTHONNOUSERSITE=1"/);
  assert.match(batch, /set "PYTHONUSERBASE=%ROOT%state\\\.khy\\python-user"/);
  assert.match(batch, /set "PIP_CACHE_DIR=%ROOT%state\\\.khy\\cache\\pip"/);
  assert.match(batch, /"%ROOT%runtime\\node\\node\.exe" "%ROOT%services\\backend\\bin\\khy\.js" %\*/);
  assert.doesNotMatch(batch, /C:\\/);

  writeLaunchers(root, 'portable-dev', { platform: 'linux', arch: 'x64' });
  const shell = fs.readFileSync(path.join(root, 'launch.sh'), 'utf8');
  assert.match(shell, /ROOT=\$\(CDPATH= cd/);
  assert.match(shell, /KHY_DATA_HOME="\$ROOT\/state\/\.khy"/);
  assert.match(shell, /KHYOS_HOME="\$KHY_DATA_HOME"/);
  assert.match(shell, /KHY_CACHE_HOME="\$KHY_DATA_HOME\/cache"/);
  assert.match(shell, /runtime\/python\/bin\/python3/);
  assert.match(shell, /runtime\/node\/bin/);
  assert.match(shell, /if \[ "\$\{1:-\}" = "shell" \]/);
  assert.doesNotMatch(shell, /[\r\0]/);
});

test('backend skips host data junction initialization in portable mode', () => {
  const backendEntry = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'services', 'backend', 'bin', 'khy.js'),
    'utf8',
  );
  assert.match(
    backendEntry,
    /process\.env\.KHY_PORTABLE_ROOT \|\| process\.env\.KHYQUANT_PORTABLE_ROOT/,
  );
  assert.match(
    backendEntry,
    /process\.platform === 'win32' && !isPortableDeployment/,
  );
});
