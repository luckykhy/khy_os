#!/usr/bin/env node
/**
 * @pattern Command
 */

/**
 * Detached runner for AI management stack.
 * - Starts AI management backend server
 * - Optionally starts ai-frontend dev server on an available port
 * - Exposes a tiny control API for page lifecycle heartbeat
 * - Auto-shuts down on idle to release occupied ports
 */

// Windows: hide the console window of every child process this daemon (and its
// large dependency tree) spawns — otherwise each git/node/port-probe spawn pops
// and destroys a console window, causing the "black box flicker" on `khychat`
// startup. Must run BEFORE any `require('child_process')` below (and before the
// aiManagementServer require, whose tree captures child_process). Reuses the
// central patch installed at bin/khy.js — win32-only, gated KHY_WINDOWS_SPAWN_HIDE
// (default-on), idempotent, fail-soft.
try {
  require('../src/bootstrap/windowsSpawnHardening').installWindowsSpawnHardening();
} catch {
  /* best effort */
}

// Make the sibling ai-backend tree resolve its bare npm deps (+ @khy/shared) in
// a bundled pip install by adding services/backend/node_modules as a NODE_PATH
// fallback. Must run BEFORE the aiManagementServer / workflowRunWorker requires
// below (their subtrees cross-require ../../../ai-backend/src/...). Fallback-only
// + idempotent + fail-soft — a no-op in dev where hoisting already resolves.
try {
  require('../src/bootstrap/aiBackendModuleResolve').ensureAiBackendResolvable();
} catch {
  /* best effort */
}

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const aiManagementServer = require('../src/services/aiManagementServer');
// Workflow run worker: this daemon is the long-lived serving process that also
// enqueues `workflow_runs` (via ai-backend's router mounted in the management
// server). Without a worker in-process nothing claims those rows, so runs sit
// in `queued` forever. The atomic claim makes co-running with server.js safe.
const { workflowRunWorker } = require('../src/services/workflow');
const { getDataHome, getLegacyDataHome } = require('../src/utils/dataHome');

// Ensure the JWT signing secret exists before the management server handles any
// login. This daemon does not load dotenv; ensureJwtSecret reads the canonical
// .env from disk and self-provisions + persists a strong secret if it is absent
// (otherwise username/password login fails with "JWT_SECRET is not configured").
try {
  require('../src/bootstrap/ensureAuthSecret').ensureJwtSecret({
    log: (m) => {
      try {
        process.stdout.write(`[daemon] ${m}\n`);
      } catch {
        /* ignore */
      }
    },
  });
} catch {
  /* helper unavailable — login will surface a clear error itself */
}

const KHY_DIR = getDataHome();
const RUNTIME_FILE = path.join(KHY_DIR, 'ai_manage_runtime.json');
const LEGACY_RUNTIME_FILE = path.join(getLegacyDataHome(), 'ai_manage_runtime.json');
const LOG_DIR = path.join(KHY_DIR, 'logs');

const DEFAULT_API_PORT = 9090;
const DEFAULT_FRONTEND_PORT = 8090;
const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_SESSION_TTL_MS = 35_000;
const DEFAULT_STARTUP_GRACE_MS = 10 * 60_000;
const DEFAULT_FRONTEND_WAIT_MS = 30_000;

let controlServer = null;
let controlPort = 0;
const controlToken = crypto.randomBytes(18).toString('hex');

let apiPort = 0;
let frontendPort = 0;
let frontendHost = '127.0.0.1';
let frontendUrl = '';
let frontendAvailable = false;
let frontendManaged = false;
let frontendProc = null;

const sessions = new Map(); // sid -> lastSeenAt
let startupAt = Date.now();
let lastActiveAt = Date.now();
let seenAnySession = false;
let gcTimer = null;
let shuttingDown = false;

// Bootstrap auth pushed by the CLI (`khy chat` → POST /auth/bootstrap) and
// fetched by the manage page (`main.js` → GET /auth/bootstrap) to auto-login
// the browser tab. The control token alone only proves the tab was opened by
// the launcher; this payload carries the actual API session token.
let authBootstrap = null;

function parseIntArg(argv, name, fallback) {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  const raw = argv[idx + 1];
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function parsePortArg(argv, name, fallback) {
  const n = parseIntArg(argv, name, fallback);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

function parseStringArg(argv, name, fallback = '') {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  const raw = argv[idx + 1];
  if (!raw || raw.startsWith('--')) return fallback;
  return String(raw).trim() || fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeRuntime(extra = {}) {
  const payload = {
    pid: process.pid,
    controlPort,
    controlToken,
    apiPort,
    frontendPort,
    frontendHost,
    frontendUrl,
    frontendAvailable,
    frontendManaged,
    frontendPid: frontendProc && frontendProc.pid ? frontendProc.pid : null,
    sessions: sessions.size,
    startupAt,
    updatedAt: Date.now(),
    ...extra,
  };
  const json = JSON.stringify(payload, null, 2);
  for (const filePath of [RUNTIME_FILE, LEGACY_RUNTIME_FILE]) {
    try {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, json, 'utf-8');
    } catch {
      // best effort
    }
  }
}

function clearRuntime() {
  for (const filePath of [RUNTIME_FILE, LEGACY_RUNTIME_FILE]) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // best effort
    }
  }
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // On Windows, process.kill(pid, 0) throws EPERM when the caller has a
    // different integrity level (e.g. elevated vs non-elevated). Treat EPERM
    // as "alive" to avoid false negatives.
    if (e && e.code === 'EPERM') return true;
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const started = Date.now();
  let attempts = 0;
  const maxAttempts = 20;
  while (Date.now() - started < timeoutMs && attempts < maxAttempts) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
    attempts++;
  }
  return !isPidAlive(pid);
}

async function terminatePid(pid) {
  if (!isPidAlive(pid)) return;
  // Reuse the shared cross-platform tree-kill primitive (taskkill /T /F on Windows,
  // process-group signal + SIGKILL escalation on Unix) so this daemon and the CLI
  // reaper share one behavior; keep the local wait-for-exit semantics on top.
  const { safeKill } = require('../src/tools/platformUtils');
  try {
    safeKill(pid, 'SIGTERM', 3000);
  } catch {
    /* best effort */
  }
  const exited = await waitForExit(pid, 4000);
  if (!exited) {
    try {
      safeKill(pid, 'SIGKILL', 0);
    } catch {
      /* best effort */
    }
    await waitForExit(pid, 1500);
  }
}

function canBindPort(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function isPortOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(900);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function findAvailablePort(host, startPort, maxScan = 60) {
  for (let p = startPort; p < startPort + maxScan; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await canBindPort(host, p)) return p;
  }
  return null;
}

async function waitPortOpen(host, port, timeoutMs = DEFAULT_FRONTEND_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortOpen(host, port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function sendJson(res, code, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Khy-Token',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
    });
    req.on('end', () => resolve(raw));
    req.on('error', () => resolve(''));
  });
}

function readAuthToken(req, urlObj) {
  const headerToken = String(req.headers['x-khy-token'] || '').trim();
  if (headerToken) return headerToken;
  return String(urlObj.searchParams.get('token') || '').trim();
}

// Quote a token for cmd.exe when spawning with shell:true on Windows. Tokens that are empty
// or contain whitespace / cmd metacharacters are wrapped in double quotes (inner quotes
// escaped); simple tokens are passed through to keep the command line readable.
function quoteForCmd(token) {
  const s = String(token);
  if (s !== '' && !/[\s"&|<>^()%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

async function startFrontendProcess({ host, basePort, frontendDir, apiPort: backendPort }) {
  const pkgPath = path.join(frontendDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, reason: `未找到 package.json: ${pkgPath}` };
  }

  const port = await findAvailablePort(host, basePort);
  if (!port) {
    return { ok: false, reason: `未找到可用端口 (起始 ${basePort})` };
  }

  const isWin = process.platform === 'win32';
  const npmCmd = isWin ? 'npm.cmd' : 'npm';
  const args = [
    '--prefix',
    frontendDir,
    'run',
    'dev',
    '--',
    '--host',
    host,
    '--port',
    String(port),
  ];

  ensureDir(LOG_DIR);
  const logFile = path.join(LOG_DIR, 'ai_frontend_dev.log');
  const fd = fs.openSync(logFile, 'a');

  // Node hardening (CVE-2024-27980) makes spawning a .cmd/.bat shim such as npm.cmd without a
  // shell throw `spawn EINVAL` on Windows. Run through a shell on Windows and quote each token
  // defensively — the frontend dir may contain spaces (e.g. C:\Users\Some Name\...).
  const useShell = isWin;
  const command = useShell ? [npmCmd, ...args].map(quoteForCmd).join(' ') : npmCmd;
  const spawnArgs = useShell ? [] : args;

  let child;
  try {
    child = spawn(command, spawnArgs, {
      cwd: path.resolve(frontendDir, '..'),
      detached: !isWin,
      shell: useShell,
      env: {
        ...process.env,
        AI_FRONTEND_PORT: String(port),
        VITE_AI_API_BASE_URL: '',
        // Browser should call same-origin "/api" to avoid CORS when host is not localhost.
        // Vite dev server proxies these paths to the management backend target.
        VITE_AI_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
        BROWSER: 'none',
      },
      stdio: ['ignore', fd, fd],
    });
  } catch (err) {
    // A dev-server spawn failure must never crash the daemon — degrade to static dist upstream.
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      reason: `启动前端 dev server (端口 ${port}) 失败: ${describeSystemError(err)}`,
      logFile,
    };
  }
  // Async spawn errors are emitted, not thrown; absorb them so they don't become an
  // uncaughtException. The port-wait below turns a dead child into a clean fallback.
  child.on('error', () => {
    /* surfaced via port-wait timeout + ai_frontend_dev.log */
  });
  fs.closeSync(fd);

  const ready = await waitPortOpen(host, port);
  if (!ready) {
    if (child.pid) await terminatePid(child.pid);
    return { ok: false, reason: `前端端口 ${port} 启动超时`, logFile };
  }

  return { ok: true, child, port, logFile };
}

async function resolveFrontend({
  host,
  requestedPort,
  autoFrontend,
  noFrontend,
  frontendDir,
  apiPort: backendPort,
}) {
  if (noFrontend) {
    return { available: false, managed: false, port: requestedPort, reason: 'disabled' };
  }

  // Prefer managed frontend with auto port fallback.
  if (autoFrontend && frontendDir) {
    const started = await startFrontendProcess({
      host,
      basePort: requestedPort,
      frontendDir,
      apiPort: backendPort,
    });
    if (started.ok) {
      return {
        available: true,
        managed: true,
        port: started.port,
        child: started.child,
        logFile: started.logFile,
      };
    }
    // Fall through to external frontend probe.
  }

  const externalOpen = await isPortOpen(host, requestedPort);
  if (externalOpen) {
    return { available: true, managed: false, port: requestedPort, reason: 'external' };
  }

  return {
    available: false,
    managed: false,
    port: requestedPort,
    reason: 'unavailable',
  };
}

function buildStatusPayload() {
  return {
    ok: true,
    runtime: {
      pid: process.pid,
      apiPort,
      frontendPort,
      frontendHost,
      frontendUrl,
      frontendAvailable,
      frontendManaged,
      frontendPid: frontendProc && frontendProc.pid ? frontendProc.pid : null,
      controlPort,
      sessions: sessions.size,
      seenAnySession,
      startupAt,
      lastActiveAt,
    },
  };
}

function upsertSession(sid) {
  if (!sid) return;
  sessions.set(sid, Date.now());
  lastActiveAt = Date.now();
  seenAnySession = true;
}

function removeSession(sid) {
  if (!sid) return;
  sessions.delete(sid);
}

async function shutdown(reason = 'unknown') {
  if (shuttingDown) return;
  shuttingDown = true;

  if (gcTimer) {
    clearInterval(gcTimer);
    gcTimer = null;
  }

  try {
    if (controlServer) {
      await new Promise((resolve) => controlServer.close(() => resolve()));
      controlServer = null;
    }
  } catch {
    // best effort
  }

  try {
    await aiManagementServer.stop();
  } catch {
    // best effort
  }

  try {
    workflowRunWorker.stop();
  } catch {
    // best effort
  }

  if (frontendManaged && frontendProc && frontendProc.pid) {
    await terminatePid(frontendProc.pid);
  }

  clearRuntime();

  // eslint-disable-next-line no-console
  console.log(`[ai-manage-daemon] shutdown: ${reason}`);
  process.exit(0);
}

function startGcLoop({ idleMs, sessionTtlMs, startupGraceMs }) {
  gcTimer = setInterval(() => {
    const now = Date.now();

    for (const [sid, lastSeen] of sessions) {
      if (now - lastSeen > sessionTtlMs) sessions.delete(sid);
    }

    writeRuntime({ sessions: sessions.size });

    if (sessions.size > 0) {
      lastActiveAt = now;
      return;
    }

    const limit = seenAnySession ? idleMs : startupGraceMs;
    const inactiveMs = now - lastActiveAt;
    if (inactiveMs >= limit) {
      const reason = seenAnySession ? 'idle' : 'startup-timeout';
      // Diagnostic context for restart analysis: which watchdog fired
      // (idle vs startup grace), how long we were inactive vs the threshold,
      // and whether any session was ever seen during this daemon lifetime.
      // eslint-disable-next-line no-console
      console.log(
        `[ai-manage-daemon] 正在关闭守护进程: 原因=${reason} 无活动=${inactiveMs}ms 阈值=${limit}ms 曾见会话=${seenAnySession}`
      );
      shutdown(reason).catch(() => process.exit(1));
    }
  }, 5000);
  gcTimer.unref();
}

function createControlServer() {
  controlServer = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      return sendJson(res, 204, {});
    }

    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    const token = readAuthToken(req, urlObj);
    if (token !== controlToken) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }

    if (req.method === 'GET' && pathname === '/status') {
      return sendJson(res, 200, buildStatusPayload());
    }

    if (req.method === 'POST' && pathname === '/shutdown') {
      sendJson(res, 200, { ok: true });
      shutdown('requested').catch(() => process.exit(1));
      return;
    }

    // CLI pushes the current session auth token here at manage startup
    // (gatewayManageDaemon._syncManageAuthBootstrapFromCli), so the page opened
    // afterwards can auto-login without the user typing credentials.
    if (req.method === 'POST' && pathname === '/auth/bootstrap') {
      const bodyRaw = await readBody(req);
      const body = safeJsonParse(bodyRaw || '{}');
      const bootstrapToken = String(body.token || '').trim();
      const ttlMs = Math.max(30_000, parseInt(body.ttlMs, 10) || 30 * 60_000);
      authBootstrap = {
        enabled: body.enabled === true && !!bootstrapToken,
        token: bootstrapToken,
        username: String(body.username || '').trim(),
        role: String(body.role || 'user').trim() || 'user',
        expiresAt: Date.now() + ttlMs,
      };
      return sendJson(res, 200, { ok: true, enabled: authBootstrap.enabled });
    }

    // Manage page fetches the bootstrap payload (expects { data: { token } });
    // an absent/expired bootstrap answers ok with a null data instead of an
    // error so the page just falls back to the normal login form.
    if (req.method === 'GET' && pathname === '/auth/bootstrap') {
      const valid =
        authBootstrap &&
        authBootstrap.enabled &&
        authBootstrap.token &&
        Date.now() < authBootstrap.expiresAt;
      return sendJson(
        res,
        200,
        valid
          ? {
              ok: true,
              data: {
                token: authBootstrap.token,
                username: authBootstrap.username,
                role: authBootstrap.role,
              },
            }
          : { ok: true, data: null }
      );
    }

    if (
      req.method === 'POST' &&
      (pathname === '/open' || pathname === '/ping' || pathname === '/close')
    ) {
      const bodyRaw = await readBody(req);
      const body = safeJsonParse(bodyRaw || '{}');
      const sid = String(body.sid || '').trim();
      if (!sid) return sendJson(res, 400, { ok: false, error: 'missing sid' });

      if (pathname === '/close') {
        removeSession(sid);
      } else {
        upsertSession(sid);
      }
      return sendJson(res, 200, { ok: true, sessions: sessions.size });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  });
}

async function listenControlServer() {
  await new Promise((resolve, reject) => {
    controlServer.once('error', reject);
    controlServer.listen(0, '127.0.0.1', () => {
      const addr = controlServer.address();
      controlPort = addr && typeof addr === 'object' ? addr.port : 0;
      resolve();
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const requestedApiPort = parsePortArg(argv, '--api-port', DEFAULT_API_PORT);
  const requestedFrontendPort = parsePortArg(argv, '--frontend-port', DEFAULT_FRONTEND_PORT);
  const idleMs = Math.max(10_000, parseIntArg(argv, '--idle-ms', DEFAULT_IDLE_MS));
  const sessionTtlMs = Math.max(
    10_000,
    parseIntArg(argv, '--session-ttl-ms', DEFAULT_SESSION_TTL_MS)
  );
  const startupGraceMs = Math.max(
    20_000,
    parseIntArg(argv, '--startup-grace-ms', DEFAULT_STARTUP_GRACE_MS)
  );
  const autoFrontend = !hasFlag(argv, '--no-auto-frontend');
  const noFrontend = hasFlag(argv, '--no-frontend');
  const frontendDir = parseStringArg(argv, '--frontend-dir', '');
  const frontendDistDir = parseStringArg(argv, '--frontend-dist-dir', '');
  frontendHost = parseStringArg(argv, '--frontend-host', '127.0.0.1');

  apiPort = await aiManagementServer.start(requestedApiPort);

  // Claim/execute queued workflow runs in this serving process (see require note).
  try {
    workflowRunWorker.start();
  } catch (err) {
    // A worker failure must never prevent the management stack from serving.
    // eslint-disable-next-line no-console
    console.error(
      '[ai-manage-daemon] workflow worker start failed:',
      err && err.message ? err.message : String(err)
    );
  }

  const frontend = await resolveFrontend({
    host: frontendHost,
    requestedPort: requestedFrontendPort,
    autoFrontend,
    noFrontend,
    frontendDir,
    apiPort,
  });

  // 回退：dev server 不可用时，用 API 端口托管预构建 dist/。
  // 显式 --no-frontend 时必须保持无前端，不得被预构建 dist 复活。
  if (!noFrontend && !frontend.available && frontendDistDir) {
    const staticResult = aiManagementServer.configureFrontendStatic({
      distDir: frontendDistDir,
    });
    if (staticResult.enabled) {
      frontend.available = true;
      frontend.managed = true;
      frontend.port = apiPort;
      frontend.reason = 'static-dist';
    }
  }

  frontendPort = frontend.port;
  frontendAvailable = !!frontend.available;
  frontendManaged = !!frontend.managed;
  frontendUrl = `http://${frontendHost}:${frontendPort}`;
  if (frontend.child) {
    frontendProc = frontend.child;
    frontendProc.on('exit', () => {
      frontendProc = null;
      if (frontendManaged) {
        frontendAvailable = false;
        writeRuntime({ frontendAvailable: false, frontendPid: null });
      }
    });
  }

  createControlServer();
  await listenControlServer();
  startupAt = Date.now();
  lastActiveAt = Date.now();

  writeRuntime({
    idleMs,
    sessionTtlMs,
    startupGraceMs,
    frontendLogFile: frontend.logFile || null,
    frontendReason: frontend.reason || '',
  });

  startGcLoop({ idleMs, sessionTtlMs, startupGraceMs });
}

// Map common OS-level failure codes to actionable Chinese advice so a resource
// crash (e.g. spawn ENOMEM in a constrained environment) never surfaces as a
// vague message. Returns "message [CODE] — advice" or the plain message.
function describeSystemError(err) {
  const code = err && err.code ? String(err.code) : '';
  const advice = {
    ENOMEM: '系统内存不足，请关闭占用内存较多的程序后重试',
    EACCES: '权限不足，请检查当前用户对相关文件/端口的访问权限',
    EPERM: '操作被系统拒绝，请检查权限或安全软件拦截',
    EMFILE: '进程可打开的文件句柄已耗尽，请关闭部分程序后重试',
    ENFILE: '系统文件句柄已耗尽，请关闭部分程序后重试',
    EAGAIN: '系统资源暂时不足（无法创建进程），请稍后重试',
  }[code];
  const msg = err && err.message ? err.message : String(err);
  return advice ? `${msg} [${code}] — ${advice}` : msg;
}

process.on('SIGTERM', () => {
  shutdown('sigterm').catch(() => process.exit(1));
});
process.on('SIGINT', () => {
  shutdown('sigint').catch(() => process.exit(1));
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error(
    '[ai-manage-daemon] uncaughtException: 守护进程发生未捕获异常，即将关闭 AI 管理会话:',
    describeSystemError(err)
  );
  shutdown('uncaught-exception').catch(() => process.exit(1));
});
process.on('unhandledRejection', (err) => {
  // eslint-disable-next-line no-console
  console.error(
    '[ai-manage-daemon] unhandledRejection: 守护进程发生未处理的 Promise 拒绝，即将关闭 AI 管理会话:',
    describeSystemError(err)
  );
  shutdown('unhandled-rejection').catch(() => process.exit(1));
});

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(
    '[ai-manage-daemon] start failed: 启动 AI 管理守护进程失败:',
    describeSystemError(err)
  );
  clearRuntime();
  process.exit(1);
});
