'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_HOME_MODULE = path.join(ROOT, 'services', 'backend', 'src', 'utils', 'dataHome.js');
const BRIDGE_AUTH_MODULE = path.join(ROOT, 'services', 'backend', 'src', 'bridge', 'bridgeAuth.js');
const SHARED_DATABASE_MODULE = path.join(ROOT, 'platform', 'packages', 'shared', 'src', 'config', 'database.js');
const STORAGE_PATHS_MODULE = path.join(ROOT, 'platform', 'packages', 'shared', 'src', 'utils', 'storagePaths.js');
const BACKEND_ENTRY = path.join(ROOT, 'services', 'backend', 'bin', 'khy.js');
const WINDOWS_LAUNCHER = path.join(ROOT, 'khy.bat');
const POSIX_LAUNCHER = path.join(ROOT, 'khy.sh');
const PORTABLE_EXT = path.join(ROOT, 'extensions', 'scripts', 'khy-portable');
const POWERSHELL_LAUNCHER = path.join(PORTABLE_EXT, 'run.ps1');
const WINDOWS_SETUP = path.join(ROOT, 'portable-setup.bat');
const POSIX_SETUP = path.join(ROOT, 'portable-setup.sh');
// 2026-08-15 根目录收容（MGMT-STD-001 §1.3 白名单）把这个薄壳从仓库根搬到 extensions/scripts/khy-installer/setup/，
// 那里离根 4 级，壳里的相对调用是 %~dp0..\..\..\..\portable-setup.bat。
// 真入口仍是根上的 portable-setup.bat。
const LEGACY_WINDOWS_SETUP = path.join(
  ROOT, 'extensions', 'scripts', 'khy-installer', 'setup', 'setup-khy.bat'
);
const WINDOWS_WRAPPER_INSTALLER = path.join(PORTABLE_EXT, 'install-path-wrappers.bat');
const POSIX_WRAPPER_INSTALLER = path.join(PORTABLE_EXT, 'install-path-wrappers.sh');
const PYTHON_PORTABLE_MODULE = path.join(ROOT, 'platform', 'khy_platform', 'portable.py');

function listTree(root) {
  if (!fs.existsSync(root)) return [];
  const entries = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      entries.push(path.relative(root, absolute));
      if (entry.isDirectory()) walk(absolute);
    }
  }
  walk(root);
  return entries.sort();
}

test('source launchers derive the project root from their own location', () => {
  const batch = fs.readFileSync(WINDOWS_LAUNCHER, 'utf8');
  const shell = fs.readFileSync(POSIX_LAUNCHER, 'utf8');
  const powershell = fs.readFileSync(POWERSHELL_LAUNCHER, 'utf8');

  assert.match(batch, /%~dp0/);
  assert.match(batch, /set "KHY_PORTABLE_ROOT=%~dp0"/);
  assert.match(batch, /Programs\\Python\\Python3\*/);
  assert.match(shell, /SCRIPT_DIR="\$\(cd "\$\(dirname "\$0"\)" && pwd\)"/);
  assert.match(shell, /KHY_PORTABLE_ROOT="\$SCRIPT_DIR"/);
  // 三级而不是两级：脚本住在 extensions/scripts/khy-portable/，比原来的
  // scripts/portable/ 深一级，少爬一级就会把 extensions/ 当成项目根。
  assert.match(
    powershell,
    /\$ProjectRoot = Split-Path -Parent \(Split-Path -Parent \(Split-Path -Parent \$PSScriptRoot\)\)/
  );
  assert.match(powershell, /\$env:KHY_PORTABLE_ROOT = \$ProjectRoot/);

  for (const content of [batch, shell, powershell]) {
    assert.doesNotMatch(content, /C:\\khy-os/i);
  }
});

test('Python portable module derives moved source roots from its file location', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy python source move-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, '移动 后 源码');
  const moduleDir = path.join(sourceRoot, 'platform', 'khy_platform');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.copyFileSync(PYTHON_PORTABLE_MODULE, path.join(moduleDir, 'portable.py'));
  fs.writeFileSync(path.join(sourceRoot, '.portable'), 'source fixture');

  const candidates = process.platform === 'win32'
    ? [
        process.env.PYTHON,
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'),
        'py',
        'python',
      ]
    : [process.env.PYTHON, 'python3', 'python'];
  let result = null;
  for (const command of candidates.filter(Boolean)) {
    const args = path.basename(command).toLowerCase() === 'py'
      ? ['-3', '-c']
      : ['-c'];
    const script = [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location("portable_fixture", ${JSON.stringify(path.join(moduleDir, 'portable.py'))})`,
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'print(json.dumps({"root": str(module.get_portable_root()), "data": str(module.get_portable_data_home())}))',
    ].join('; ');
    const attempt = spawnSync(command, [...args, script], {
      cwd: path.join(base),
      env: {
        ...process.env,
        KHY_PORTABLE_ROOT: '',
        KHYQUANT_PORTABLE_ROOT: '',
        KHY_DATA_HOME: '',
      },
      encoding: 'utf8',
      windowsHide: true,
    });
    if (attempt.status === 0) {
      result = JSON.parse(attempt.stdout.trim());
      break;
    }
  }
  if (!result) {
    t.skip('Python 3 is not available for the source relocation probe');
    return;
  }

  assert.equal(result.root, sourceRoot);
  assert.equal(result.data, path.join(sourceRoot, '.khy'));
});

test('portable storage resolution leaves fake host homes untouched', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy host isolation-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const portableRoot = path.join(base, '便携 根目录');
  const dataHome = path.join(portableRoot, 'state', '.khy');
  const fakeHost = path.join(base, 'fake host');
  for (const name of ['home', 'appdata', 'localappdata']) {
    fs.mkdirSync(path.join(fakeHost, name), { recursive: true });
  }
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(portableRoot, '.portable'), 'fixture');

  const childScript = `
    const path = require('path');
    const dataHome = require(${JSON.stringify(DATA_HOME_MODULE)});
    const bridge = require(${JSON.stringify(BRIDGE_AUTH_MODULE)});
    const database = require(${JSON.stringify(SHARED_DATABASE_MODULE)});
    const storage = require(${JSON.stringify(STORAGE_PATHS_MODULE)});
    const result = {
      portable: dataHome.isPortableDeployment(),
      dataHome: dataHome.getDataHome(),
      projectDataHome: dataHome.getProjectDataHome(),
      appHome: dataHome.getAppHome(),
      baseHome: dataHome.getBaseHome(),
      bridge: bridge.resolveBridgePaths(),
      sqlite: database.getSQLitePath(),
      logs: storage.resolveLogDir(),
      pointerWrite: dataHome._writePointer({ dataHome: 'should-not-write' }),
    };
    process.stdout.write(JSON.stringify(result));
  `;
  const env = {
    ...process.env,
    HOME: path.join(fakeHost, 'home'),
    USERPROFILE: path.join(fakeHost, 'home'),
    APPDATA: path.join(fakeHost, 'appdata'),
    LOCALAPPDATA: path.join(fakeHost, 'localappdata'),
    KHY_PORTABLE_ROOT: portableRoot,
    KHYQUANT_PORTABLE_ROOT: portableRoot,
    KHY_OS_ROOT: portableRoot,
    KHY_DATA_HOME: dataHome,
    KHY_PROJECT_DATA_HOME: dataHome,
    KHYQUANT_DATA_HOME: dataHome,
    KHYOS_HOME: dataHome,
    KHY_LOG_HOME: path.join(dataHome, 'logs'),
    KHY_TEMP_HOME: path.join(dataHome, 'tmp'),
  };
  delete env.KHY_APP_HOME;
  delete env.BRIDGE_DATA_DIR;
  delete env.SQLITE_DB_PATH;
  delete env.DB_PATH;
  delete env.KHY_LOCATION_FILE;

  const child = spawnSync(process.execPath, ['-e', childScript], {
    cwd: path.join(base, 'fake host'),
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.portable, true);
  assert.equal(result.dataHome, dataHome);
  assert.equal(result.projectDataHome, dataHome);
  assert.equal(result.appHome, dataHome);
  assert.equal(result.baseHome, dataHome);
  assert.equal(result.bridge.dataDir, path.join(dataHome, 'bridge'));
  assert.equal(result.sqlite, path.join(dataHome, 'khyquant', 'data', 'khy-quant.db'));
  assert.equal(result.logs, path.join(dataHome, 'logs'));
  assert.equal(result.pointerWrite, null);

  assert.deepEqual(listTree(path.join(fakeHost, 'home')), []);
  assert.deepEqual(listTree(path.join(fakeHost, 'appdata')), []);
  assert.deepEqual(listTree(path.join(fakeHost, 'localappdata')), []);
});

test('portable CLI startup does not initialize host data directories', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy cli isolation-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const portableRoot = path.join(base, '便携 CLI');
  const dataHome = path.join(portableRoot, 'state', '.khy');
  const fakeHost = path.join(base, 'fake host');
  for (const name of ['home', 'appdata', 'localappdata']) {
    fs.mkdirSync(path.join(fakeHost, name), { recursive: true });
  }
  fs.mkdirSync(dataHome, { recursive: true });
  fs.writeFileSync(path.join(portableRoot, '.portable'), 'fixture');

  const env = {
    ...process.env,
    HOME: path.join(fakeHost, 'home'),
    USERPROFILE: path.join(fakeHost, 'home'),
    APPDATA: path.join(fakeHost, 'appdata'),
    LOCALAPPDATA: path.join(fakeHost, 'localappdata'),
    KHY_PORTABLE_ROOT: portableRoot,
    KHYQUANT_PORTABLE_ROOT: portableRoot,
    KHY_OS_ROOT: portableRoot,
    KHY_DATA_HOME: dataHome,
    KHY_PROJECT_DATA_HOME: dataHome,
    KHYQUANT_DATA_HOME: dataHome,
    KHYOS_HOME: dataHome,
    KHY_LOG_HOME: path.join(dataHome, 'logs'),
    KHY_TEMP_HOME: path.join(dataHome, 'tmp'),
  };
  const child = spawnSync(process.execPath, [BACKEND_ENTRY, '--help'], {
    cwd: portableRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /khy OS v/);
  assert.deepEqual(listTree(path.join(fakeHost, 'home')), []);
  assert.deepEqual(listTree(path.join(fakeHost, 'appdata')), []);
  assert.deepEqual(listTree(path.join(fakeHost, 'localappdata')), []);
});

test('command setup scripts remain relocatable and use the portable launchers', () => {
  const windowsSetup = fs.readFileSync(WINDOWS_SETUP, 'utf8');
  const posixSetup = fs.readFileSync(POSIX_SETUP, 'utf8');
  const legacySetup = fs.readFileSync(LEGACY_WINDOWS_SETUP, 'utf8');
  const windowsInstaller = fs.readFileSync(WINDOWS_WRAPPER_INSTALLER, 'utf8');
  const posixInstaller = fs.readFileSync(POSIX_WRAPPER_INSTALLER, 'utf8');

  assert.match(windowsSetup, /%~dp0/);
  assert.match(windowsSetup, /install-path-wrappers\.bat" --force --add-to-path/);
  assert.match(posixSetup, /dirname "\$0"/);
  assert.match(posixSetup, /install-path-wrappers\.sh/);
  assert.match(
    legacySetup,
    /%~dp0\.\.\\\.\.\\\.\.\\\.\.\\portable-setup\.bat/
  );
  assert.doesNotMatch(legacySetup, /\$PROFILE|C:\\khy-os/i);
  // 精确到级数：迁入拓展后是三级，写成宽松匹配的话少爬一级也照样绿。
  assert.match(windowsInstaller, /%~dp0\.\.\\\.\.\\\.\./);
  assert.match(windowsInstaller, /call "%PROJECT_ROOT%\\khy\.bat"/);
  assert.match(windowsInstaller, /GetEnvironmentVariable\('Path','User'\)/);
  assert.match(windowsInstaller, /SetEnvironmentVariable\('Path', \(\$items -join ';'\), 'User'\)/);
  assert.doesNotMatch(windowsInstaller, /\bsetx\b/i);
  assert.match(posixInstaller, /PROJECT_ROOT=.*SCRIPT_DIR\/\.\.\/\.\.\/\.\./);
  assert.match(posixInstaller, /RUNNER="\$PROJECT_ROOT\/khy\.sh"/);

  for (const content of [windowsSetup, posixSetup, legacySetup, windowsInstaller, posixInstaller]) {
    assert.doesNotMatch(content, /C:\\khy-os/i);
  }
});

test('Windows command wrappers forward arguments and exit codes from a moved source tree', { skip: process.platform !== 'win32' }, t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy windows setup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, '移动 后 源码');
  const installerDir = path.join(sourceRoot, 'extensions', 'scripts', 'khy-portable');
  const localAppData = path.join(base, 'local app data');
  const capture = path.join(base, 'arguments.txt');
  fs.mkdirSync(installerDir, { recursive: true });
  fs.copyFileSync(WINDOWS_WRAPPER_INSTALLER, path.join(installerDir, 'install-path-wrappers.bat'));
  fs.writeFileSync(path.join(sourceRoot, 'khy.bat'), [
    '@echo off',
    '> "%CAPTURE_FILE%" echo %~1^|%~2',
    'exit /b 37',
    '',
  ].join('\r\n'));

  const env = { ...process.env, LOCALAPPDATA: localAppData, CAPTURE_FILE: capture };
  const install = spawnSync('cmd.exe', ['/d', '/c', path.join(installerDir, 'install-path-wrappers.bat'), '--force'], {
    cwd: base,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(install.status, 0, install.stderr || install.stdout);

  const binDir = path.join(localAppData, 'khy-os', 'bin');
  for (const name of ['khy.bat', 'khy-os.bat', 'khyquant.bat']) {
    const wrapper = path.join(binDir, name);
    assert.equal(fs.existsSync(wrapper), true);
    assert.match(fs.readFileSync(wrapper, 'utf8'), new RegExp(sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  const invokeScript = path.join(base, 'invoke-wrapper.bat');
  fs.writeFileSync(invokeScript, [
    '@echo off',
    'chcp 65001 >nul',
    `call "${path.join(binDir, 'khy.bat')}" "hello world" "中文"`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n'));
  const invoke = spawnSync('cmd.exe', ['/d', '/c', 'call', invokeScript], {
    cwd: base,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(invoke.status, 37, invoke.stderr || invoke.stdout);
  assert.equal(fs.readFileSync(capture, 'utf8').trim(), 'hello world|中文');
});

test('Unix command setup updates one PATH block and keeps wrappers relocatable', t => {
  const probe = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('bash is not available');
    return;
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'khy unix setup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, '移动 后 源码');
  const installerDir = path.join(sourceRoot, 'extensions', 'scripts', 'khy-portable');
  const home = path.join(base, 'home');
  const binDir = path.join(home, 'custom bin');
  const profile = path.join(home, '.bashrc');
  const capture = path.join(base, 'arguments.txt');
  fs.mkdirSync(installerDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(POSIX_WRAPPER_INSTALLER, path.join(installerDir, 'install-path-wrappers.sh'));
  fs.writeFileSync(path.join(sourceRoot, 'khy.sh'), [
    '#!/usr/bin/env bash',
    'printf "%s|%s" "$1" "$2" > "$CAPTURE_FILE"',
    'exit 23',
    '',
  ].join('\n'), { mode: 0o755 });

  const env = { ...process.env, HOME: home, SHELL: '/bin/bash', CAPTURE_FILE: capture };
  const args = [path.join(installerDir, 'install-path-wrappers.sh'), '--bin-dir', binDir, '--profile', profile, '--force', '--add-to-path'];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const install = spawnSync('bash', args, { cwd: base, env, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr || install.stdout);
  }

  const profileContent = fs.readFileSync(profile, 'utf8');
  assert.equal((profileContent.match(/# >>> khy-os portable command >>>/g) || []).length, 1);
  assert.equal((profileContent.match(/# <<< khy-os portable command <<</g) || []).length, 1);
  const toShellPath = value => process.platform === 'win32'
    ? spawnSync('cygpath', ['-u', value], { encoding: 'utf8' }).stdout.trim()
    : value;
  const shellBinDir = toShellPath(binDir);
  const shellSourceRoot = toShellPath(sourceRoot);
  const escapedShellBinDir = shellBinDir.replace(/ /g, '\\ ');
  assert.match(profileContent, new RegExp(escapedShellBinDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const name of ['khy', 'khy-os', 'khyquant']) {
    const wrapperPath = path.join(binDir, name);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(wrapperPath).mode & 0o111, 0o111);
    }
    const wrapperContent = fs.readFileSync(wrapperPath, 'utf8');
    if (process.platform === 'win32') {
      assert.match(wrapperContent, /\/khy\.sh['"]?\s+"\$@"/);
    } else {
      const escapedSourceRoot = shellSourceRoot.replace(/ /g, '\\ ');
      assert.match(wrapperContent, new RegExp(escapedSourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
  const invoke = spawnSync('bash', [path.join(binDir, 'khy'), 'hello world', '中文'], {
    cwd: base,
    env,
    encoding: 'utf8',
  });
  assert.equal(invoke.status, 23, invoke.stderr || invoke.stdout);
  assert.equal(fs.readFileSync(capture, 'utf8'), 'hello world|中文');
});
