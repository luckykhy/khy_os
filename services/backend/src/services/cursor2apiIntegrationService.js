/**
 * Cursor2API integration service.
 *
 * Responsibilities:
 * - Extract a local cursor2api ZIP package into user data directory
 * - Install/build the extracted Node project
 * - Start/stop/status management for the Cursor2API process
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const StreamZip = require('node-stream-zip');
const { getDataHome } = require('../utils/dataHome');

const APP_NAME = 'cursor2api';
const DEFAULT_PORT = 3010;
const DEFAULT_ZIP_PATH = path.join(os.homedir(), 'Downloads', 'cursor2api-main.zip');

function dataHome() {
  return getDataHome();
}

function defaultInstallDir() {
  return path.join(dataHome(), 'integrations', APP_NAME);
}

function configPath() {
  return path.join(dataHome(), 'cursor2api_service.json');
}

function pidPath() {
  return path.join(dataHome(), 'cursor2api.pid');
}

function logPath() {
  return path.join(dataHome(), 'logs', 'cursor2api.log');
}

// 收敛到 utils/mkdirpSync 单一真源(逐字节委托,调用点不变)
const ensureDir = require('../utils/mkdirpSync');

function normalizePort(raw, fallback = DEFAULT_PORT) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

function normalizeBool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

const normalizeAuthToken = require('../utils/normalizeAuthToken');

function generateAuthToken() {
  return `khy-${crypto.randomBytes(24).toString('hex')}`;
}

function maskToken(token) {
  const t = String(token || '').trim();
  if (!t) return '(empty)';
  if (t.length <= 10) return `${t.slice(0, 3)}***`;
  return `${t.slice(0, 6)}***${t.slice(-4)}`;
}

function loadConfig() {
  const defaults = {
    zipPath: DEFAULT_ZIP_PATH,
    installDir: defaultInstallDir(),
    port: DEFAULT_PORT,
    authToken: '',
    requireToken: true,
  };
  try {
    if (!fs.existsSync(configPath())) return defaults;
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    return {
      ...defaults,
      ...raw,
      port: normalizePort(raw.port, defaults.port),
      authToken: normalizeAuthToken(raw.authToken, { allowEmpty: true }),
      requireToken: normalizeBool(raw.requireToken, defaults.requireToken),
    };
  } catch {
    return defaults;
  }
}

function saveConfig(nextConfig = {}) {
  const current = loadConfig();
  const merged = {
    ...current,
    ...nextConfig,
    port: normalizePort(nextConfig.port, current.port),
    authToken: normalizeAuthToken(
      nextConfig.authToken !== undefined ? nextConfig.authToken : current.authToken,
      { allowEmpty: true }
    ),
    requireToken: normalizeBool(nextConfig.requireToken, current.requireToken),
    updatedAt: new Date().toISOString(),
  };
  ensureDir(path.dirname(configPath()));
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

function readPid() {
  try {
    if (!fs.existsSync(pidPath())) return null;
    const pid = parseInt(fs.readFileSync(pidPath(), 'utf-8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writePid(pid) {
  ensureDir(path.dirname(pidPath()));
  fs.writeFileSync(pidPath(), String(pid), 'utf-8');
}

function clearPid() {
  try {
    if (fs.existsSync(pidPath())) fs.unlinkSync(pidPath());
  } catch {
    // best effort
  }
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPortState(port, expectOpen, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const open = await isPortOpen(port);
    if (open === expectOpen) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function waitForProcessExit(pid, timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return !isPidAlive(pid);
}

function tailProcessError(result) {
  const joined = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  if (!joined) return 'no process output';
  return joined.split('\n').slice(-10).join('\n');
}

function readPackageInfo(installDir) {
  const pkgPath = path.join(installDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpm(installDir, args, label) {
  const result = spawnSync(npmBin(), args, {
    cwd: installDir,
    env: { ...process.env },
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 20 * 60 * 1000,
  });
  if (result.error) {
    throw new Error(`${label} 执行失败: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} 失败: ${tailProcessError(result)}`);
  }
}

async function extractZip(zipFilePath, installDir) {
  const zipPathResolved = path.resolve(zipFilePath);
  if (!fs.existsSync(zipPathResolved)) {
    throw new Error(`ZIP 文件不存在: ${zipPathResolved}`);
  }

  const tmpDir = path.join(path.dirname(installDir), `.cursor2api_tmp_${Date.now()}`);
  ensureDir(tmpDir);
  let zip = null;

  try {
    zip = new StreamZip.async({ file: zipPathResolved });
    await zip.extract(null, tmpDir);
  } catch (err) {
    throw new Error(`解压失败: ${err.message}`);
  } finally {
    if (zip) {
      try { await zip.close(); } catch { /* ignore */ }
    }
  }

  try {
    const entries = fs.readdirSync(tmpDir, { withFileTypes: true })
      .filter(d => d.name !== '__MACOSX');
    let sourceDir = tmpDir;

    if (entries.length === 1 && entries[0].isDirectory()) {
      sourceDir = path.join(tmpDir, entries[0].name);
    } else {
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const maybe = path.join(tmpDir, e.name);
        if (fs.existsSync(path.join(maybe, 'package.json'))) {
          sourceDir = maybe;
          break;
        }
      }
    }

    if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
      throw new Error('未在 ZIP 中检测到有效 Node 项目 (缺少 package.json)');
    }

    fs.rmSync(installDir, { recursive: true, force: true });
    ensureDir(path.dirname(installDir));
    fs.cpSync(sourceDir, installDir, { recursive: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function setupFromZip(options = {}) {
  const current = loadConfig();
  const installDir = path.resolve(options.installDir || current.installDir || defaultInstallDir());
  const zipPath = path.resolve(options.zipPath || current.zipPath || DEFAULT_ZIP_PATH);
  const port = normalizePort(options.port, current.port);
  const requireToken = normalizeBool(options.requireToken, current.requireToken);
  let authToken = normalizeAuthToken(
    options.authToken != null ? options.authToken : current.authToken,
    { allowEmpty: true }
  );
  let generatedToken = false;
  if (requireToken && !authToken) {
    authToken = generateAuthToken();
    generatedToken = true;
  }
  const skipInstall = options.skipInstall === true;
  const skipBuild = options.skipBuild === true;

  await extractZip(zipPath, installDir);

  if (!skipInstall) {
    runNpm(installDir, ['install', '--no-audit', '--no-fund'], 'npm install');
  }
  if (!skipBuild) {
    runNpm(installDir, ['run', 'build'], 'npm run build');
  }

  const pkg = readPackageInfo(installDir);
  saveConfig({
    zipPath,
    installDir,
    port,
    authToken,
    requireToken,
    version: pkg?.version || null,
    preparedAt: new Date().toISOString(),
  });

  return {
    installDir,
    zipPath,
    port,
    authEnabled: !!authToken,
    requireToken,
    generatedToken,
    authToken,
    version: pkg?.version || null,
    entry: path.join(installDir, 'dist', 'index.js'),
  };
}

async function prepareProject(options = {}) {
  const current = loadConfig();
  const installDir = path.resolve(options.installDir || current.installDir || defaultInstallDir());
  const port = normalizePort(options.port, current.port);
  const requireToken = normalizeBool(options.requireToken, current.requireToken);
  let authToken = normalizeAuthToken(
    options.authToken != null ? options.authToken : current.authToken,
    { allowEmpty: true }
  );
  let generatedToken = false;
  if (requireToken && !authToken) {
    authToken = generateAuthToken();
    generatedToken = true;
  }

  if (!fs.existsSync(path.join(installDir, 'package.json'))) {
    throw new Error(`未发现 cursor2api 项目目录: ${installDir}`);
  }

  const needInstall = options.forceInstall === true || !fs.existsSync(path.join(installDir, 'node_modules'));
  const needBuild = options.forceBuild === true || !fs.existsSync(path.join(installDir, 'dist', 'index.js'));

  if (needInstall) {
    runNpm(installDir, ['install', '--no-audit', '--no-fund'], 'npm install');
  }
  if (needBuild) {
    runNpm(installDir, ['run', 'build'], 'npm run build');
  }

  const pkg = readPackageInfo(installDir);
  saveConfig({
    installDir,
    port,
    authToken,
    requireToken,
    version: pkg?.version || null,
    preparedAt: new Date().toISOString(),
  });

  return {
    installDir,
    port,
    authEnabled: !!authToken,
    requireToken,
    generatedToken,
    authToken,
    version: pkg?.version || null,
    built: fs.existsSync(path.join(installDir, 'dist', 'index.js')),
  };
}

async function start(options = {}) {
  const current = loadConfig();
  const installDir = path.resolve(options.installDir || current.installDir || defaultInstallDir());
  const port = normalizePort(options.port, current.port);
  const requireToken = normalizeBool(options.requireToken, current.requireToken);
  let authToken = normalizeAuthToken(
    options.authToken != null ? options.authToken : current.authToken,
    { allowEmpty: true }
  );
  let generatedToken = false;
  if (requireToken && !authToken) {
    authToken = generateAuthToken();
    generatedToken = true;
  }
  const entryFile = path.join(installDir, 'dist', 'index.js');

  if (!fs.existsSync(path.join(installDir, 'package.json'))) {
    throw new Error(`未安装 cursor2api。请先执行: proxy cursor2api setup <zip路径>`);
  }
  if (!fs.existsSync(entryFile)) {
    throw new Error('未检测到 dist/index.js，请先执行: proxy cursor2api prepare');
  }

  const existingPid = readPid();
  if (isPidAlive(existingPid)) {
    return {
      alreadyRunning: true,
      pid: existingPid,
      port,
      installDir,
      authEnabled: !!authToken,
      requireToken,
      generatedToken,
      authToken,
      logPath: logPath(),
    };
  }
  clearPid();

  if (await isPortOpen(port)) {
    throw new Error(`端口 ${port} 已被占用，请更换 --port`);
  }

  ensureDir(path.dirname(logPath()));
  const fd = fs.openSync(logPath(), 'a');
  const child = spawn(process.execPath, [entryFile], {
    cwd: installDir,
    env: {
      ...process.env,
      PORT: String(port),
      ...(requireToken ? { AUTH_TOKEN: authToken } : {}),
      NODE_ENV: process.env.NODE_ENV || 'production',
    },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.on('error', () => { /* detached service — best effort */ });
  fs.closeSync(fd);

  if (!child.pid) {
    throw new Error('子进程启动失败（未获取 PID）');
  }

  child.unref();
  writePid(child.pid);

  const online = await waitForPortState(port, true, 15000);
  if (!online) {
    try { safeKill(child.pid); } catch { /* ignore */ }
    clearPid();
    throw new Error('启动超时：15 秒内端口未就绪，请检查日志');
  }

  saveConfig({
    installDir,
    port,
    authToken,
    requireToken,
    lastStartedAt: new Date().toISOString(),
    pid: child.pid,
  });

  return {
    alreadyRunning: false,
    pid: child.pid,
    port,
    installDir,
    authEnabled: !!authToken,
    requireToken,
    generatedToken,
    authToken,
    logPath: logPath(),
  };
}

async function stop() {
  const pid = readPid();
  if (!pid || !isPidAlive(pid)) {
    clearPid();
    return { stopped: false, alreadyStopped: true };
  }

  try { safeKill(pid); } catch { /* ignore */ }

  let exited = await waitForProcessExit(pid, 5000);
  if (!exited) {
    try { safeKill(pid, 'SIGKILL', 0); } catch { /* ignore */ }
    exited = await waitForProcessExit(pid, 2000);
  }

  clearPid();
  return { stopped: true, forced: !exited, pid };
}

async function getStatus() {
  const cfg = loadConfig();
  const pid = readPid();
  const pidAlive = isPidAlive(pid);
  const portOpen = await isPortOpen(cfg.port);
  const installDir = path.resolve(cfg.installDir || defaultInstallDir());
  const packageExists = fs.existsSync(path.join(installDir, 'package.json'));
  const built = fs.existsSync(path.join(installDir, 'dist', 'index.js'));
  const pkg = readPackageInfo(installDir);

  return {
    appName: APP_NAME,
    configured: packageExists,
    built,
    running: pidAlive || portOpen,
    managedProcess: pidAlive,
    portOpen,
    pid: pidAlive ? pid : null,
    port: normalizePort(cfg.port, DEFAULT_PORT),
    installDir,
    zipPath: cfg.zipPath || DEFAULT_ZIP_PATH,
    logPath: logPath(),
    authEnabled: !!String(cfg.authToken || '').trim(),
    requireToken: normalizeBool(cfg.requireToken, true),
    authTokenMasked: maskToken(cfg.authToken),
    version: pkg?.version || null,
  };
}

function setAuthToken(rawToken, options = {}) {
  const token = normalizeAuthToken(rawToken, { allowEmpty: true });
  const requireToken = normalizeBool(options.requireToken, true);
  if (requireToken && !token) {
    throw new Error('token 不能为空');
  }
  const next = saveConfig({
    authToken: token,
    requireToken,
  });
  return {
    requireToken: next.requireToken,
    authEnabled: !!String(next.authToken || '').trim(),
    authTokenMasked: maskToken(next.authToken),
  };
}

function rotateAuthToken() {
  const token = generateAuthToken();
  saveConfig({
    authToken: token,
    requireToken: true,
  });
  return {
    authToken: token,
    authTokenMasked: maskToken(token),
    requireToken: true,
  };
}

module.exports = {
  APP_NAME,
  DEFAULT_ZIP_PATH,
  loadConfig,
  saveConfig,
  generateAuthToken,
  maskToken,
  setAuthToken,
  rotateAuthToken,
  setupFromZip,
  prepareProject,
  start,
  stop,
  getStatus,
};
