'use strict';

/**
 * gatewayManageDaemon.js — AI 管理后台守护进程生命周期子系统（从 handlers/gateway.js 抽出）。
 *
 * 覆盖：运行时文件读写、守护进程 spawn/停止、健康探测、管理台 URL 组装与浏览器打开、
 * WSL/Windows 访问提示。刻意 **不自称纯零 IO 叶子**：读写 runtime 文件、spawn 子进程、
 * 发起 HTTP 探测、打开浏览器。宿主 handlers/gateway.js 单向 require 本叶子并按同名 re-export，
 * 保持 handleGatewayManage/handleAiServer 契约字节不变（零反向依赖，无需 DI）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printSuccess, printError, printInfo } = require('../formatters');
const { getDataHome, getLegacyDataHome } = require('../../utils/dataHome');
const { getAiBackendUrl } = require('../../constants/serviceDefaults');
const {
  buildGatewayManageFeatureLabel,
  getFeatureFamilyPrefix,
  joinFeatureKey,
} = require('../../services/featureKeyBuilder');

// AI-manage 运行时常量（镜像自 handlers/gateway.js 头部；同目录叶子 → __dirname 一致 → 路径逐字节相同）。
const AI_MANAGE_RUNTIME_FILE = path.join(getDataHome(), 'ai_manage_runtime.json');
const AI_MANAGE_RUNTIME_FILE_LEGACY = path.join(getLegacyDataHome(), 'ai_manage_runtime.json');
const AI_MANAGE_READY_TIMEOUT_MS = Math.max(
  20000,
  parseInt(process.env.AI_MANAGE_READY_TIMEOUT_MS || '65000', 10) || 65000
);
const AI_MANAGE_HEALTH_WAIT_MS = Math.max(
  5000,
  parseInt(process.env.AI_MANAGE_HEALTH_WAIT_MS || '18000', 10) || 18000
);
const AI_MANAGE_HEALTH_POLL_MS = Math.max(
  200,
  parseInt(process.env.AI_MANAGE_HEALTH_POLL_MS || '600', 10) || 600
);
const AI_MANAGE_DAEMON_SCRIPT = path.resolve(__dirname, '../../../scripts/ai-manage-daemon.js');
function _parsePort(value, fallback) {
  const n = parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

function _parseIntWithMin(value, fallback, min = 1) {
  const n = parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

function _isPidAlive(pid) {
  const p = parseInt(pid, 10);
  if (!Number.isFinite(p) || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}

function _loadAiManageRuntime() {
  const files = [AI_MANAGE_RUNTIME_FILE, AI_MANAGE_RUNTIME_FILE_LEGACY];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!raw || typeof raw !== 'object') continue;
      return raw;
    } catch {
      // try next
    }
  }
  return null;
}

function _clearAiManageRuntime() {
  for (const file of [AI_MANAGE_RUNTIME_FILE, AI_MANAGE_RUNTIME_FILE_LEGACY]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      // best effort
    }
  }
}

function _resolveAiFrontendDir(options = {}) {
  const candidates = [];
  const explicit = String(
    options['frontend-dir']
    || options.frontendDir
    || process.env.AI_FRONTEND_DIR
    || process.env.KHY_AI_FRONTEND_DIR
    || ''
  ).trim();
  if (explicit) {
    candidates.push(path.resolve(explicit));
  }
  if (process.env.KHYQUANT_ROOT) {
    // forest layout: KHYQUANT_ROOT = services/backend, apps/ai-frontend is two levels up
    candidates.push(path.resolve(process.env.KHYQUANT_ROOT, '..', '..', 'apps', 'ai-frontend'));
    candidates.push(path.resolve(process.env.KHYQUANT_ROOT, '..', 'apps', 'ai-frontend'));
    candidates.push(path.resolve(process.env.KHYQUANT_ROOT, 'apps', 'ai-frontend'));
  }
  candidates.push(path.resolve(process.cwd(), 'apps', 'ai-frontend'));
  candidates.push(path.resolve(process.cwd(), 'ai-frontend'));
  // forest layout (source + mirrored bundle): apps/ai-frontend is two levels above services/backend
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', '..', 'apps', 'ai-frontend'));

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch {
      // try next
    }
  }
  return null;
}

function _resolveAiFrontendDistDir(options = {}, frontendDir = null) {
  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const resolved = path.resolve(text);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };

  push(
    options['frontend-dist-dir']
    || options.frontendDistDir
    || process.env.AI_FRONTEND_DIST_DIR
    || process.env.KHY_AI_FRONTEND_DIST_DIR
    || ''
  );

  if (frontendDir) {
    push(path.join(frontendDir, 'dist'));
    push(path.join(frontendDir, 'build'));
  }

  if (process.env.KHYQUANT_ROOT) {
    const root = path.resolve(process.env.KHYQUANT_ROOT);
    const parent = path.resolve(root, '..');
    const grandParent = path.resolve(root, '..', '..');
    // forest layout: KHYQUANT_ROOT = services/backend, apps/ai-frontend is two levels up
    const roots = [grandParent, parent, root];
    for (const base of roots) {
      push(path.join(base, 'apps', 'ai-frontend', 'dist'));
    }
  }

  push(path.resolve(process.cwd(), 'apps', 'ai-frontend', 'dist'));
  push(path.resolve(process.cwd(), 'ai-frontend', 'dist'));
  // forest layout (source + mirrored bundle): apps/ai-frontend is two levels above services/backend
  push(path.resolve(__dirname, '..', '..', '..', '..', '..', 'apps', 'ai-frontend', 'dist'));

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    } catch {
      // try next
    }
  }
  return null;
}

const _sleep = require('../../utils/sleep'); // single-source sleep ([MGMT-RPT-020] REQ-2026-010)

function _requestAiManageControl(runtime, method = 'GET', endpoint = '/status', body = null, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    if (!runtime || !runtime.controlPort || !runtime.controlToken) {
      reject(new Error('runtime control 信息缺失'));
      return;
    }

    const queryJoiner = endpoint.includes('?') ? '&' : '?';
    const endpointWithToken = `${endpoint}${queryJoiner}token=${encodeURIComponent(runtime.controlToken)}`;
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1',
      port: runtime.controlPort,
      path: endpointWithToken,
      method,
      timeout: timeoutMs,
      headers: {
        'X-Khy-Token': runtime.controlToken,
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk.toString(); });
      res.on('end', () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('control request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function _syncManageAuthBootstrapFromCli(runtime, options = {}) {
  const cliAuth = require('../../services/cliAuthService');
  const session = (typeof cliAuth.checkSession === 'function')
    ? (cliAuth.checkSession() || { loggedIn: false })
    : { loggedIn: false };
  const token = (typeof cliAuth.getSessionAuthToken === 'function')
    ? String(cliAuth.getSessionAuthToken() || '').trim()
    : '';
  const username = String(session.username || '').trim();
  const role = session.role || 'user';
  const ttlMs = _parseIntWithMin(
    options['auth-ttl-ms'] ?? options.authTtlMs ?? process.env.AI_MANAGE_AUTH_BOOTSTRAP_TTL_MS,
    30 * 60 * 1000,
    30_000
  );
  const enabled = !!token || session.loggedIn;

  try {
    await _requestAiManageControl(runtime, 'POST', '/auth/bootstrap', {
      enabled,
      token,
      username,
      role,
      ttlMs,
    }, 3000);
    return {
      ok: true,
      enabled,
      username,
      loggedIn: !!session.loggedIn,
      hasServerToken: !!token,
    };
  } catch (err) {
    return {
      ok: false,
      enabled: false,
      username,
      loggedIn: !!session.loggedIn,
      hasServerToken: !!token,
      error: err && err.message ? err.message : String(err || ''),
    };
  }
}

async function _waitAiManageRuntimeReady(timeoutMs = 15000) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    const runtime = _loadAiManageRuntime();
    if (runtime?.pid && _isPidAlive(runtime.pid) && runtime.controlPort && runtime.controlToken) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const status = await _requestAiManageControl(runtime, 'GET', '/status');
        if (status?.ok) return { runtime, status };
      } catch {
        // still starting
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await _sleep(250);
  }
  return null;
}

function _openUrlInBrowser(url) {
  const { openDefault } = require('../../tools/platformUtils');
  try {
    openDefault(url);
    return true;
  } catch {
    return false;
  }
}

function _buildManageOpenUrl(runtime) {
  const base = String(runtime?.frontendUrl || `http://127.0.0.1:${runtime?.frontendPort || 8090}`).trim();
  if (!base) return '';
  if (!runtime?.controlPort || !runtime?.controlToken) return base;
  const ctl = `http://127.0.0.1:${runtime.controlPort}`;
  const joiner = base.includes('?') ? '&' : '?';
  return `${base}${joiner}khy_manage_ctl=${encodeURIComponent(ctl)}&khy_manage_token=${encodeURIComponent(runtime.controlToken)}`;
}

function _isLoopbackHost(host = '') {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

function _isLikelyWslRuntime() {
  return !!(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME);
}

function _pickFirstExternalIPv4() {
  try {
    const os = require('os');
    const nets = os.networkInterfaces ? os.networkInterfaces() : {};
    for (const group of Object.values(nets || {})) {
      for (const row of (group || [])) {
        if (!row || row.internal) continue;
        if ((row.family === 'IPv4' || row.family === 4) && row.address) {
          const ip = String(row.address || '').trim();
          if (ip && ip !== '0.0.0.0' && !ip.startsWith('169.254.')) return ip;
        }
      }
    }
  } catch {
    // ignore
  }
  return '';
}

function _printWindowsAccessHint(runtimeForOpen = {}) {
  if (!_isLikelyWslRuntime()) return;
  if (!_isLoopbackHost(runtimeForOpen.frontendHost)) return;
  const port = Number(runtimeForOpen.frontendPort || 0) || 8090;
  const ip = _pickFirstExternalIPv4();
  printInfo('检测到 WSL 环境：Windows 浏览器可能无法直接访问 127.0.0.1 管理页。');
  printInfo('可执行: khy gateway manage stop && khy gateway manage open --daemon --frontend-host 0.0.0.0');
  printInfo('跨设备访问请优先使用“前端地址”（不要使用带 khy_manage_ctl 的保活直链）。');
  if (ip) {
    printInfo(`Windows 建议打开: http://${ip}:${port}`);
  } else {
    printInfo(`Windows 建议打开: http://<Linux_IP>:${port}`);
  }
}

function _truthyFlag(value) {
  if (value === true) return true;
  const raw = String(value || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function _normalizePath(pathname = '/admin/ai-gateway') {
  const raw = String(pathname || '').trim();
  if (!raw) return '/admin/ai-gateway';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function _toValidPort(raw) {
  const n = parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return 0;
  return n;
}

function _appendPath(baseUrl, pathname = '/admin/ai-gateway') {
  const pathValue = _normalizePath(pathname);
  try {
    const parsed = new URL(String(baseUrl || '').trim());
    parsed.pathname = pathValue;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function _buildMainAdminUrlCandidates(options = {}) {
  const candidates = [];
  const seen = new Set();
  const push = (url) => {
    const text = String(url || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    candidates.push(text);
  };

  const adminPath = _normalizePath(
    options['admin-path']
    || process.env.KHY_ADMIN_PATH
    || '/admin/ai-gateway'
  );

  const explicitFull = String(
    options['admin-url']
    || process.env.KHY_ADMIN_URL
    || ''
  ).trim();
  if (explicitFull) {
    if (/^https?:\/\//i.test(explicitFull)) {
      push(_appendPath(explicitFull, adminPath));
    } else {
      push(_appendPath(`http://${explicitFull}`, adminPath));
    }
  }

  const explicitBase = String(
    options['web-url']
    || options['web-base']
    || process.env.KHY_WEB_URL
    || process.env.KHY_WEB_BASE_URL
    || ''
  ).trim();
  if (explicitBase) {
    if (/^https?:\/\//i.test(explicitBase)) {
      push(_appendPath(explicitBase, adminPath));
    } else {
      push(_appendPath(`http://${explicitBase}`, adminPath));
    }
  }

  const host = String(options['web-host'] || process.env.KHY_WEB_HOST || '127.0.0.1').trim() || '127.0.0.1';
  const portCandidates = [];
  const portValues = [
    options['web-port'],
    options.port,
    process.env.KHY_WEB_PORT,
    process.env.FRONTEND_PORT,
    process.env.VITE_PORT,
    process.env.PORT,
    // Common local dev/prod ports; values can still be overridden by env/flags.
    5173,
    3000,
  ];
  for (const value of portValues) {
    const p = _toValidPort(value);
    if (!p) continue;
    if (!portCandidates.includes(p)) portCandidates.push(p);
  }

  for (const port of portCandidates) {
    push(`http://${host}:${port}${adminPath}`);
    if (host === '127.0.0.1') push(`http://localhost:${port}${adminPath}`);
  }
  return candidates;
}

function _probeUrlReachable(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let parsed = null;
    try {
      parsed = new URL(String(url || '').trim());
    } catch {
      resolve({ ok: false, statusCode: 0 });
      return;
    }
    const transport = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search || ''}`,
      method: 'GET',
      timeout: timeoutMs,
      headers: { Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      if (statusCode < 200 || statusCode >= 400) {
        res.resume();
        resolve({ ok: false, statusCode });
        return;
      }
      const isApiPath = /^\/api(?:\/|$)/i.test(String(parsed.pathname || ''));
      if (isApiPath) {
        res.resume();
        resolve({ ok: true, statusCode });
        return;
      }
      // 读取响应体前 2KB，验证是否是 KHY 管理页
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2048) res.destroy();
      });
      res.on('end', () => {
        // 检查特征标记：KHY 管理页 HTML 中应包含 khy 或 ai-gateway 关键字
        const isKhy = /khy|ai-gateway|khyquant|ai.manage/i.test(body);
        resolve({ ok: isKhy || !body, statusCode });
      });
      res.on('error', () => resolve({ ok: false, statusCode }));
    });
    req.on('error', () => resolve({ ok: false, statusCode: 0 }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function _buildRuntimeForOpen(statusRuntime = {}, runtime = {}) {
  return {
    ...(statusRuntime || {}),
    controlPort: statusRuntime?.controlPort || runtime?.controlPort || 0,
    controlToken: runtime?.controlToken || statusRuntime?.controlToken || '',
    frontendHost: statusRuntime?.frontendHost || runtime?.frontendHost || '127.0.0.1',
    frontendPort: statusRuntime?.frontendPort || runtime?.frontendPort || 8090,
    frontendUrl: statusRuntime?.frontendUrl || runtime?.frontendUrl || '',
  };
}

function _resolveAiManageApiBaseUrl(statusRuntime = {}, runtime = {}) {
  const apiPort = _toValidPort(statusRuntime?.apiPort || runtime?.apiPort || 0);
  if (apiPort) return `http://127.0.0.1:${apiPort}`;

  return String(getAiBackendUrl({
    ...process.env,
    AI_BACKEND_URL: '',
  }) || '').trim();
}

function _printManageKeepaliveStatus({ chalk, keepaliveUrl, frontendAvailable, frontendReachable }) {
  const hasUrl = !!String(keepaliveUrl || '').trim();
  if (frontendAvailable && frontendReachable && hasUrl) {
    console.log(`  ${chalk.gray('保活直链:')} ${chalk.dim('已生成（复制下一行）')}`);
    console.log(`    ${chalk.dim(keepaliveUrl)}`);
    return;
  }

  if (frontendAvailable && hasUrl) {
    console.log(`  ${chalk.gray('保活直链:')} ${chalk.yellow('暂不可用（前端地址当前不可达）')}`);
    return;
  }

  console.log(`  ${chalk.gray('保活直链:')} ${chalk.yellow('未生成（前端未就绪）')}`);
}

function _formatManageRecommendedEntry({ frontendAvailable, frontendReachable, apiReachable }) {
  if (frontendAvailable && frontendReachable) {
    return 'khychat  或  khy gateway manage open';
  }
  if (frontendAvailable) {
    return '前端地址（当前不可达，请先恢复 Web 入口）';
  }
  if (apiReachable) {
    return 'API 直管（当前无可用前端）';
  }
  return 'khy gateway manage status（先确认 API/前端状态）';
}

async function _collectManageHealth(runtime = {}, liveStatus = null, probeTimeoutMs = 1200) {
  const statusRuntime = liveStatus?.runtime || runtime;
  const runtimeForOpen = _buildRuntimeForOpen(statusRuntime, runtime);
  const frontendAvailable = !!statusRuntime?.frontendAvailable;
  const frontendReason = String(statusRuntime?.frontendReason || runtime?.frontendReason || '').trim();
  const frontendLogFile = String(statusRuntime?.frontendLogFile || runtime?.frontendLogFile || '').trim();
  const apiDisplay = _resolveAiManageApiBaseUrl(statusRuntime, runtime);
  const frontendDisplay = String(runtimeForOpen.frontendUrl || `http://${runtimeForOpen.frontendHost}:${runtimeForOpen.frontendPort}`).trim()
    || `http://${runtimeForOpen.frontendHost}:${runtimeForOpen.frontendPort}`;
  const keepaliveUrl = _buildManageOpenUrl(runtimeForOpen);
  const apiHealthUrl = `${apiDisplay}/api/health`;
  let apiReachable = false;
  let frontendReachable = false;
  try {
    const apiProbe = await _probeUrlReachable(apiHealthUrl, probeTimeoutMs);
    apiReachable = !!apiProbe.ok;
  } catch {
    apiReachable = false;
  }
  try {
    const frontendProbe = await _probeUrlReachable(frontendDisplay, probeTimeoutMs);
    frontendReachable = !!frontendProbe.ok;
  } catch {
    frontendReachable = false;
  }

  return {
    runtimeForOpen,
    statusRuntime,
    frontendAvailable,
    frontendReason,
    frontendLogFile,
    apiDisplay,
    frontendDisplay,
    keepaliveUrl,
    apiHealthUrl,
    apiReachable,
    frontendReachable,
  };
}

async function _waitManageHealthReady(runtime = {}, options = {}) {
  const timeoutMs = _parseIntWithMin(
    options.timeoutMs ?? AI_MANAGE_HEALTH_WAIT_MS,
    AI_MANAGE_HEALTH_WAIT_MS,
    1000
  );
  const requireFrontend = options.requireFrontend !== false;
  const probeTimeoutMs = _parseIntWithMin(options.probeTimeoutMs ?? 1200, 1200, 300);
  const startedAt = Date.now();
  let latestRuntime = { ...(runtime || {}) };
  let latestStatus = null;
  let lastHealth = null;

  while ((Date.now() - startedAt) < timeoutMs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      latestStatus = await _requestAiManageControl(latestRuntime, 'GET', '/status', null, Math.max(2200, probeTimeoutMs + 800));
      if (latestStatus?.runtime) {
        latestRuntime = {
          ...latestRuntime,
          ...latestStatus.runtime,
          controlPort: latestRuntime.controlPort || latestStatus.runtime.controlPort || 0,
          controlToken: latestRuntime.controlToken || latestStatus.runtime.controlToken || '',
        };
      }
    } catch {
      // ignore transient control request failures and continue probing
    }

    // eslint-disable-next-line no-await-in-loop
    lastHealth = await _collectManageHealth(latestRuntime, latestStatus, probeTimeoutMs);
    const frontendReady = !requireFrontend || (lastHealth.frontendAvailable && lastHealth.frontendReachable);
    if (lastHealth.apiReachable && frontendReady) {
      return { ok: true, health: lastHealth, runtime: latestRuntime, status: latestStatus };
    }
    if (requireFrontend && String(lastHealth.frontendReason || '').trim().toLowerCase() === 'disabled') {
      return { ok: false, health: lastHealth, runtime: latestRuntime, status: latestStatus, reason: 'frontend-disabled' };
    }
    // eslint-disable-next-line no-await-in-loop
    await _sleep(AI_MANAGE_HEALTH_POLL_MS);
  }

  return { ok: false, health: lastHealth, runtime: latestRuntime, status: latestStatus, reason: 'wait-timeout' };
}

async function _openMainAdminIfAvailable(options = {}) {
  const candidates = _buildMainAdminUrlCandidates(options);
  for (const url of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await _probeUrlReachable(url, 1200);
    if (!probe.ok) continue;
    const opened = _openUrlInBrowser(url);
    return { success: true, url, opened };
  }
  return { success: false, candidates };
}

async function _waitPidExit(pid, timeoutMs = 6000) {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    if (!_isPidAlive(pid)) return true;
    // eslint-disable-next-line no-await-in-loop
    await _sleep(150);
  }
  return !_isPidAlive(pid);
}

function _spawnAiManageDaemon({
  apiPort,
  frontendPort,
  idleMs,
  frontendHost,
  frontendDir,
  frontendDistDir,
  noFrontend = false,
  noAutoFrontend = false,
}) {
  if (!fs.existsSync(AI_MANAGE_DAEMON_SCRIPT)) {
    throw new Error(`未找到守护脚本: ${AI_MANAGE_DAEMON_SCRIPT}`);
  }

  const args = [
    AI_MANAGE_DAEMON_SCRIPT,
    '--api-port', String(apiPort),
    '--frontend-port', String(frontendPort),
    '--idle-ms', String(idleMs),
    '--frontend-host', String(frontendHost || '127.0.0.1'),
  ];

  if (frontendDir) {
    args.push('--frontend-dir', frontendDir);
  }
  if (frontendDistDir) {
    args.push('--frontend-dist-dir', frontendDistDir);
  }
  if (noFrontend) {
    args.push('--no-frontend');
  }
  if (noAutoFrontend) {
    args.push('--no-auto-frontend');
  }

  let fd = null;
  let stdio = 'ignore';
  try {
    const logDir = path.join(path.dirname(AI_MANAGE_RUNTIME_FILE), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const daemonLogFile = path.join(logDir, 'ai_manage_daemon.log');
    fd = fs.openSync(daemonLogFile, 'a');
    stdio = ['ignore', fd, fd];
  } catch {
    stdio = 'ignore';
  }

  let child;
  // Decide the daemon's cwd so it does NOT lock the site-packages bundle on
  // Windows. The old cwd (KHYQUANT_ROOT || __dirname/../..) resolves inside the
  // pip bundle, and a running process's cwd locks that dir against pip's
  // rename/delete on upgrade → WinError 32 → corruption. On win32 we relocate
  // cwd to ~/.khy and pin KHYQUANT_ROOT (path resolution never uses cwd), so pip
  // can overwrite the bundle even while khy runs. Gated + fail-soft; on any
  // non-qualifying case the current behavior is preserved byte-for-byte.
  const resolvedRoot = process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..');
  let daemonCwd = resolvedRoot;
  const daemonEnv = { ...process.env };
  try {
    const { resolveDaemonSpawnLocation } = require('../../services/daemonSpawnLocation');
    const gateRaw = String(process.env.KHY_DAEMON_SITEPKG_UNLOCK ?? '').trim().toLowerCase();
    const gateEnabled = !['0', 'false', 'off', 'no'].includes(gateRaw);
    let dataHome = null;
    try { const h = getDataHome(); if (h && fs.existsSync(h)) dataHome = h; } catch { /* fail-soft */ }
    const loc = resolveDaemonSpawnLocation({
      platform: process.platform, resolvedRoot, dataHome, gateEnabled,
    });
    daemonCwd = loc.cwd;
    Object.assign(daemonEnv, loc.envPatch);
  } catch { /* keep resolvedRoot / process.env */ }
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio,
      env: daemonEnv,
      cwd: daemonCwd,
      windowsHide: true,
    });
  } catch (err) {
    if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    throw err;
  }
  child.on('error', () => { /* detached daemon — best effort */ });
  if (fd != null) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  child.unref();
  return child.pid || 0;
}

async function handleGatewayManage(args = [], options = {}) {
  const action = String(args[0] || 'open').trim().toLowerCase();
  const { requireFeatureAccess } = require('../../services/authGuard');
  const auth = requireFeatureAccess(
    joinFeatureKey(getFeatureFamilyPrefix('gateway', 'manage'), action || 'open'),
    buildGatewayManageFeatureLabel()
  );
  if (!auth.ok) {
    printError(auth.error);
    return;
  }
  const validActions = new Set(['open', 'start', 'status', 'stop']);
  if (!validActions.has(action)) {
    printError(`未知 manage 操作: ${action}`);
    printInfo('用法: gateway manage [open|start|status|stop] [--daemon] [--frontend-host 127.0.0.1] [--frontend-port 8090] [--api-port 9090] [--idle-ms 600000] [--wait-ms 18000] [--frontend-dir <path>] [--frontend-dist-dir <path>]');
    return;
  }

  const forceDaemon = _truthyFlag(options.daemon);
  // WSL: auto-adjust to 0.0.0.0 + external IP so Windows browser can reach the page
  if (_isLikelyWslRuntime() && !options['frontend-host'] && !process.env.KHY_MANAGE_FRONTEND_HOST) {
    options['frontend-host'] = '0.0.0.0';
  }

  if (action === 'open' && !forceDaemon) {
    printInfo('正在检测主站管理页...');
    const webOpen = await _openMainAdminIfAvailable(options);
    if (webOpen.success) {
      if (webOpen.opened) {
        printSuccess(`已打开管理页面: ${webOpen.url}`);
      } else {
        printInfo(`请手动打开管理页面: ${webOpen.url}`);
      }
      printInfo('如需使用独立守护会话入口，可运行: khy gateway manage open --daemon');
      return;
    }
    const previewList = (webOpen.candidates || []).slice(0, 2);
    if (previewList.length > 0) {
      printInfo('主站管理页未就绪，已回退独立会话模式。');
      for (const url of previewList) {
        printInfo(`探测地址: ${url}`);
      }
    } else {
      printInfo('主站管理页未就绪，已回退独立会话模式。');
    }
  }

  let runtime = _loadAiManageRuntime();
  let liveStatus = null;
  if (runtime?.pid && _isPidAlive(runtime.pid)) {
    try {
      liveStatus = await _requestAiManageControl(runtime, 'GET', '/status');
      if (!liveStatus?.ok) throw new Error('status not ok');
    } catch {
      runtime = null;
      liveStatus = null;
      _clearAiManageRuntime();
    }
  } else if (runtime) {
    _clearAiManageRuntime();
    runtime = null;
  }

  if (action === 'stop') {
    if (!runtime) {
      printInfo('AI 管理会话未运行');
      return;
    }

    try {
      await _requestAiManageControl(runtime, 'POST', '/shutdown', {});
    } catch {
      // fallback to signal
      const { safeSignal: _sig } = require('../../tools/platformUtils');
      try { _sig(runtime.pid, 'SIGTERM'); } catch { /* ignore */ }
    }

    const exited = await _waitPidExit(runtime.pid, 8000);
    if (!exited) {
      const { safeSignal: _sigKill } = require('../../tools/platformUtils');
      try { _sigKill(runtime.pid, 'SIGKILL'); } catch { /* ignore */ }
      await _waitPidExit(runtime.pid, 2000);
    }
    _clearAiManageRuntime();
    printSuccess('AI 管理会话已停止，端口已释放');
    return;
  }

  if (action === 'status' && !runtime) {
    printInfo('AI 管理会话未运行');
    printInfo('启动命令: khy gateway manage');
    printInfo('主站入口: khy guanli');
    return;
  }

  if (!runtime) {
    const frontendPort = _parsePort(
      options['frontend-port'] ?? options.port ?? process.env.AI_FRONTEND_PORT ?? process.env.VITE_AI_FRONTEND_PORT,
      8090
    );
    const apiPort = _parsePort(
      options['api-port'] ?? process.env.AI_MGMT_PORT,
      9090
    );
    const idleMs = _parseIntWithMin(
      options['idle-ms'] ?? process.env.AI_MANAGE_IDLE_MS,
      10 * 60 * 1000,
      10000
    );
    const frontendHost = String(options['frontend-host'] || process.env.AI_FRONTEND_HOST || '127.0.0.1').trim() || '127.0.0.1';
    const frontendDir = _resolveAiFrontendDir(options);
    const frontendDistDir = _resolveAiFrontendDistDir(options, frontendDir);
    const noFrontend = _truthyFlag(options['no-frontend']) || _truthyFlag(options.noFrontend);
    // pip 安装包含 ai-frontend 源码但没有 node_modules（或仅空目录壳），
    // 无法启动 dev server，自动跳过避免 spawn EINVAL / 启动超时
    let noAutoFrontend = _truthyFlag(options['no-auto-frontend']) || _truthyFlag(options.noAutoFrontend);
    if (!noAutoFrontend && frontendDir) {
      const nmDir = path.join(frontendDir, 'node_modules');
      const nmUsable = fs.existsSync(nmDir)
        && fs.existsSync(path.join(nmDir, '.package-lock.json'));
      if (!nmUsable) noAutoFrontend = true;
    }

    if (!frontendDir && !frontendDistDir && !noFrontend) {
      printInfo('未检测到 ai-frontend 目录或预构建 dist。管理页将以纯 API 模式启动。');
      printInfo('如需完整管理页：cd ai-frontend && npm install && npm run build');
    } else if (noAutoFrontend && !frontendDistDir) {
      printInfo('ai-frontend/node_modules 未就绪，前端 dev server 已跳过。');
      printInfo('如需前端：cd ai-frontend && npm install && npm run build');
    }
    printInfo(`正在启动 AI 管理会话 (API:${apiPort}, 前端:${frontendPort})...`);
    _spawnAiManageDaemon({
      apiPort,
      frontendPort,
      idleMs,
      frontendHost,
      frontendDir,
      frontendDistDir,
      noFrontend,
      noAutoFrontend,
    });
    const ready = await _waitAiManageRuntimeReady(AI_MANAGE_READY_TIMEOUT_MS);
    if (!ready) {
      printError('AI 管理会话启动失败或超时');
      printInfo('可检查日志: ~/.khy/logs/ai_manage_daemon.log 与 ~/.khy/logs/ai_frontend_dev.log');
      // Surface last few lines of daemon log if available
      try {
        const logFile = path.join(getDataHome(), 'logs', 'ai_manage_daemon.log');
        if (fs.existsSync(logFile)) {
          const tail = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(-5).join('\n');
          if (tail) printInfo(`最近日志:\n${tail}`);
        }
      } catch { /* best-effort */ }
      return;
    }
    runtime = ready.runtime;
    liveStatus = ready.status;
  }

  if (!liveStatus) {
    try {
      liveStatus = await _requestAiManageControl(runtime, 'GET', '/status');
    } catch {
      liveStatus = null;
    }
  }

  if (action === 'open' || action === 'start') {
    const authSync = await _syncManageAuthBootstrapFromCli(runtime, options);
    if (authSync.ok && authSync.enabled) {
      printInfo(`已同步 CLI 登录态到管理页（用户: ${authSync.username || 'cli-user'}）`);
    } else if (authSync.ok && authSync.loggedIn && !authSync.hasServerToken) {
      printInfo('检测到 CLI 为本地离线登录态，管理页将进入登录页（可在页面登录）。');
      printInfo('诊断: 当前 CLI 会话缺少服务端 token，无法桥接管理页自动免登录。');
      printInfo('下一步 1/2: 在 CLI 执行 `/login`，完成服务端账号登录。');
      printInfo('下一步 2/2: 重新执行 `khychat` 或 `khy gateway manage open`。');
    } else if (authSync.ok && !authSync.loggedIn) {
      printInfo('CLI 当前未登录，管理页将进入登录页。可先执行 `/login`。');
    }
  }

  let health = await _collectManageHealth(runtime, liveStatus, 1200);
  if (action !== 'status') {
    const waitMs = _parseIntWithMin(
      options['wait-ms'] ?? options.waitMs ?? process.env.AI_MANAGE_HEALTH_WAIT_MS,
      AI_MANAGE_HEALTH_WAIT_MS,
      1000
    );
    const initiallyReady = health.apiReachable && health.frontendAvailable && health.frontendReachable;
    if (!initiallyReady) {
      printInfo(`正在确认管理页可达（API+前端，最长 ${Math.round(waitMs / 1000)}s）...`);
      const waited = await _waitManageHealthReady(runtime, {
        timeoutMs: waitMs,
        requireFrontend: true,
        probeTimeoutMs: 1200,
      });
      if (waited?.runtime) runtime = waited.runtime;
      if (waited?.status) liveStatus = waited.status;
      if (waited?.health) health = waited.health;
    }
  }

  const statusRuntime = health.statusRuntime || liveStatus?.runtime || runtime;
  const runtimeForOpen = health.runtimeForOpen || _buildRuntimeForOpen(statusRuntime, runtime);
  const frontendAvailable = !!health.frontendAvailable;
  const frontendReason = String(health.frontendReason || '').trim();
  const frontendLogFile = String(health.frontendLogFile || '').trim();
  const apiDisplay = String(health.apiDisplay || '').trim() || _resolveAiManageApiBaseUrl(statusRuntime, runtime);
  const frontendDisplay = String(health.frontendDisplay || '').trim() || `http://${runtimeForOpen.frontendHost}:${runtimeForOpen.frontendPort}`;
  const keepaliveUrl = String(health.keepaliveUrl || _buildManageOpenUrl(runtimeForOpen)).trim();
  const apiHealthUrl = String(health.apiHealthUrl || `${apiDisplay}/api/health`).trim();
  const apiReachable = !!health.apiReachable;
  const frontendReachable = !!health.frontendReachable;
  const recommendedEntry = _formatManageRecommendedEntry({ frontendAvailable, frontendReachable, apiReachable });

  if (action === 'status') {
    const runningHealthy = apiReachable && frontendAvailable && frontendReachable;
    console.log('');
    console.log(`  ${chalk.cyan.bold('AI 管理会话状态')}`);
    console.log('');
    console.log(`  ${chalk.gray('运行状态:')} ${runningHealthy ? chalk.green('● 运行中') : chalk.yellow('● 运行中（服务未完全就绪）')}`);
    console.log(`  ${chalk.gray('守护进程 PID:')} ${statusRuntime.pid || runtime.pid}`);
    console.log(`  ${chalk.gray('API:')} ${apiReachable ? chalk.cyan(apiHealthUrl) : chalk.yellow(`${apiHealthUrl} (不可达)`)}`);
    if (!frontendAvailable) {
      console.log(`  ${chalk.gray('前端:')} ${chalk.yellow('未就绪')}`);
      if (frontendReason) {
        console.log(`  ${chalk.gray('前端原因:')} ${chalk.yellow(frontendReason)}`);
      }
      if (frontendLogFile) {
        console.log(`  ${chalk.gray('前端日志:')} ${chalk.dim(frontendLogFile)}`);
      }
    } else {
      console.log(`  ${chalk.gray('前端:')} ${frontendReachable ? chalk.cyan(frontendDisplay) : chalk.yellow(`${frontendDisplay} (不可达)`)}`);
    }
    console.log(`  ${chalk.gray('推荐入口:')} ${chalk.cyan(recommendedEntry)}`);
    _printManageKeepaliveStatus({ chalk, keepaliveUrl, frontendAvailable, frontendReachable });
    console.log(`  ${chalk.gray('自动关闭:')} ${chalk.cyan('页面关闭后空闲自动释放端口')}`);
    console.log(`  ${chalk.gray('活跃页面:')} ${String(statusRuntime.sessions || 0)}`);
    if (!runningHealthy) {
      printInfo('检测到管理会话未完全就绪。可先运行: khy gateway manage stop && khy gateway manage start --daemon');
      printInfo('若仍失败，请检查日志: ~/.khy/logs/ai_manage_daemon.log 与 ~/.khy/logs/ai_frontend_dev.log');
    }
    _printWindowsAccessHint(runtimeForOpen);
    console.log('');
    return;
  }

  let openUrl = _buildManageOpenUrl(runtimeForOpen);
  // WSL: replace loopback with external IP so Windows browser can reach it
  if (_isLikelyWslRuntime()) {
    const extIp = _pickFirstExternalIPv4();
    if (extIp) {
      openUrl = openUrl.replace(/127\.0\.0\.1|localhost/gi, extIp);
    }
  }
  if (action === 'start') {
    printSuccess('AI 管理会话已启动');
  } else {
    if (frontendAvailable && frontendReachable) {
      const opened = _openUrlInBrowser(openUrl);
      if (opened) {
        printSuccess(`已打开管理页面: ${frontendDisplay}`);
      } else {
        printInfo(`请手动打开管理页面: ${openUrl}`);
      }
    } else {
      printInfo('管理前端未就绪。');
      if (apiReachable) {
        printInfo(`API 已启动，可通过 API 直接管理: ${apiHealthUrl.replace('/api/health', '')}`);
      }
      if (frontendReason) {
        printInfo(`原因: ${frontendReason}`);
      }
    }
  }

  console.log('');
  console.log(`  ${chalk.gray('API:')} ${apiReachable ? chalk.cyan(apiHealthUrl) : chalk.yellow(`${apiHealthUrl} (不可达)`)}`);
  if (!frontendAvailable) {
    console.log(`  ${chalk.gray('前端:')} ${chalk.yellow('未就绪')}`);
    if (frontendReason) {
      console.log(`  ${chalk.gray('前端原因:')} ${chalk.yellow(frontendReason)}`);
    }
    if (frontendLogFile) {
      console.log(`  ${chalk.gray('前端日志:')} ${chalk.dim(frontendLogFile)}`);
    }
  } else {
    console.log(`  ${chalk.gray('前端:')} ${frontendReachable ? chalk.cyan(frontendDisplay) : chalk.yellow(`${frontendDisplay} (不可达)`)}`);
  }
  console.log(`  ${chalk.gray('推荐入口:')} ${chalk.cyan(recommendedEntry)}`);
  _printManageKeepaliveStatus({ chalk, keepaliveUrl: openUrl, frontendAvailable, frontendReachable });
  console.log(`  ${chalk.gray('状态:')} ${chalk.dim('khychat status')}`);
  console.log(`  ${chalk.gray('停止:')} ${chalk.dim('khychat stop')}`);
  if (frontendAvailable && frontendReachable) {
    console.log(`  ${chalk.gray('登录提示:')} ${chalk.dim('admin / admin123 (旧安装兼容 admin123.)')}`);
    console.log(`  ${chalk.gray('重置账号:')} ${chalk.dim('node backend/scripts/seed.js')}`);
  }
  console.log('');

  _printWindowsAccessHint(runtimeForOpen);

  if (!frontendAvailable || !frontendReachable || !apiReachable) {
    printInfo('管理服务未完全就绪。可先运行: khy gateway manage stop && khy gateway manage start --daemon');
    printInfo('可选：显式指定前端目录 `--frontend-dir <ai-frontend绝对路径>`，或静态目录 `--frontend-dist-dir <dist绝对路径>`。');
    printInfo('若使用源码前端开发模式，请先在 ai-frontend 目录执行 `npm install`。');
    printInfo('若仍失败，请检查日志: ~/.khy/logs/ai_manage_daemon.log 与 ~/.khy/logs/ai_frontend_dev.log');
  }
}

/**
 * Start/stop/status the AI management backend server.
 * @param {string} action - 'start' | 'stop' | 'status'
 */
async function handleAiServer(action) {
  const server = require('../../services/aiManagementServer');

  if (action === 'stop') {
    if (!server.isRunning()) {
      printInfo('AI 管理服务未运行');
      return;
    }
    await server.stop();
    printSuccess('AI 管理服务已停止');
    return;
  }

  if (action === 'status') {
    if (server.isRunning()) {
      printSuccess(`AI 管理服务运行中: http://localhost:${server.getPort()}`);
    } else {
      printInfo('AI 管理服务未运行');
    }
    return;
  }

  // Default: start
  if (server.isRunning()) {
    printInfo(`AI 管理服务已在运行: http://localhost:${server.getPort()}`);
    return;
  }

  const port = await server.start();
  console.log('');
  printSuccess('AI 管理服务已启动');
  console.log('');
  console.log(chalk.bold(`  🌐 API:       ${chalk.cyan(`http://localhost:${port}/api/health`)}`));
  console.log(chalk.bold(`  🔌 WebSocket: ${chalk.cyan(`ws://localhost:${port}/ws`)}`));
  console.log('');
  console.log(chalk.dim('  REST 端点:'));
  console.log(chalk.dim('    GET  /api/status          — 适配器状态'));
  console.log(chalk.dim('    GET  /api/models          — 模型列表 (含健康指标)'));
  console.log(chalk.dim('    POST /api/test/:adapter   — 两步连通测试'));
  console.log(chalk.dim('    GET  /api/config          — 网关配置'));
  console.log(chalk.dim('    PUT  /api/config          — 更新配置'));
  console.log(chalk.dim('    GET  /api/conversations   — 会话列表'));
  console.log(chalk.dim('    GET  /api/usage           — Token 用量'));
  console.log(chalk.dim('    GET  /api/tools           — 工具列表'));
  console.log(chalk.dim('    POST /api/tools/:name     — 执行工具'));
  console.log('');
}

module.exports = {
  handleGatewayManage,
  handleAiServer,
  _resolveAiManageApiBaseUrl,
  _parseIntWithMin,
};
