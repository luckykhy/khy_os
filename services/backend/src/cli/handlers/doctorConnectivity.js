/**
 * doctorConnectivity.js — async connectivity checks for `khy doctor`
 *
 * Two checks appended to the doctor report:
 *   1. Backend WebSocket reachability: discover the daemon port dynamically
 *      (runtime JSON / env vars — never hardcoded), open a WS connection to
 *      the loopback address, send the same auth message the frontend sends
 *      and wait for `auth_ok`.
 *   2. Proxy connectivity: reuse proxyConfigService's loadConfig/testProxy
 *      to probe the configured proxy endpoint (skipped when not configured).
 *
 * These probes are async, so they live outside the synchronous
 * runDoctorChecks() and are merged into the report by handleDoctor().
 * All timeouts are ≤10s (connect/probe exemption).
 *
 * @module handlers/doctorConnectivity
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Category shown in the doctor report for both checks.
const CATEGORY = '连接诊断';

// Connect/probe timeout budget (≤10s exemption for handshake probes).
const PROBE_TIMEOUT_MS = 10000;

// ── Backend port discovery ───────────────────────────────────────────────────
// Mirrors apps/ai-frontend/backendDiscovery.mjs precedence:
//   1. apiPort from ai_manage_runtime.json across known data homes
//      (KHY_DATA_HOME → pinned pointer → ~/.khy → ~/.khyquant)
//   2. env port hints (KHY_DAEMON_PORT / AI_MGMT_PORT)
// No hardcoded fallback port: when nothing is found the check reports a
// "backend not running" warning instead of probing a guessed port.

function _parsePort(raw) {
  const port = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
}

function _readApiPortFromRuntime(dataHome) {
  if (!dataHome) {
    return null;
  }
  try {
    const file = path.join(dataHome, 'ai_manage_runtime.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return _parsePort(raw?.apiPort);
  } catch {
    /* missing/corrupt → try next candidate */
  }
  return null;
}

function _readPointerDataHome(env, homedir) {
  try {
    const pointerFile = env.KHY_LOCATION_FILE || path.join(homedir, '.khy', '.location.json');
    const obj = JSON.parse(fs.readFileSync(pointerFile, 'utf-8'));
    if (obj && typeof obj === 'object' && obj.dataHome) {
      return String(obj.dataHome);
    }
  } catch {
    /* no/corrupt pointer → ignore */
  }
  return null;
}

/**
 * Resolve the backend loopback endpoint from dynamic sources only.
 * @returns {{ port: number, source: string } | null}
 */
function resolveBackendEndpoint(env = process.env) {
  const homedir = os.homedir();
  const dataHomes = [];
  if (env.KHY_DATA_HOME) {
    dataHomes.push(env.KHY_DATA_HOME);
  }
  const pointerHome = _readPointerDataHome(env, homedir);
  if (pointerHome) {
    dataHomes.push(pointerHome);
  }
  dataHomes.push(path.join(homedir, '.khy'));
  dataHomes.push(path.join(homedir, '.khyquant'));

  for (const dataHome of dataHomes) {
    const port = _readApiPortFromRuntime(dataHome);
    if (port) {
      return { port, source: `ai_manage_runtime.json (${dataHome})` };
    }
  }

  const envPort = _parsePort(env.KHY_DAEMON_PORT || env.AI_MGMT_PORT);
  if (envPort) {
    const sourceVar = env.KHY_DAEMON_PORT ? 'KHY_DAEMON_PORT' : 'AI_MGMT_PORT';
    return { port: envPort, source: `环境变量 ${sourceVar}` };
  }
  return null;
}

// ── Check 1: backend WebSocket connectivity ──────────────────────────────────

// Minimal TCP reachability probe — used only when the `ws` package cannot be
// loaded (degraded mode); a full WS handshake needs frame codecs we must not
// reimplement here.
function _probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function checkBackendWebSocket({ onProgress } = {}) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};
  const label = '后端 WebSocket 连通性';

  const endpoint = resolveBackendEndpoint(process.env);
  if (!endpoint) {
    return {
      category: CATEGORY,
      label,
      ok: false,
      detail:
        '后端服务未运行（未发现 ai_manage_runtime.json，且未设置 KHY_DAEMON_PORT / AI_MGMT_PORT），请先执行 khy start',
      level: 'warn',
    };
  }

  const { port, source } = endpoint;
  const target = `127.0.0.1:${port}`;
  notify(`连接后端 WebSocket (${target})，等待 auth_ok（第 1/1 次）...`);

  let WebSocketCtor = null;
  try {
    WebSocketCtor = require('ws');
  } catch {
    /* ws unavailable → degraded TCP probe below */
  }

  if (!WebSocketCtor) {
    const reachable = await _probeTcp('127.0.0.1', port, PROBE_TIMEOUT_MS);
    return {
      category: CATEGORY,
      label,
      ok: reachable,
      detail: reachable
        ? `端口可达 (${target}，来源: ${source})，但 ws 依赖缺失，仅完成 TCP 探测（未验证 auth_ok），可运行 npm install 补齐`
        : `后端服务未运行（端口 ${port} 不可达，来源: ${source}），请先执行 khy start`,
      level: 'warn',
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let ws = null;
    let timer = null;

    const finish = (check) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      try {
        if (ws) {
          ws.close();
        }
      } catch {
        /* best effort */
      }
      try {
        if (ws) {
          ws.terminate();
        }
      } catch {
        /* best effort */
      }
      resolve({ category: CATEGORY, label, ...check });
    };

    timer = setTimeout(() => {
      finish({
        ok: false,
        detail: `连接后端 WebSocket 超时 (${target}，>${Math.round(PROBE_TIMEOUT_MS / 1000)}s，来源: ${source})，请确认后端状态或执行 khy start`,
        level: 'warn',
      });
    }, PROBE_TIMEOUT_MS);

    try {
      ws = new WebSocketCtor(`ws://${target}/ws`);
    } catch (err) {
      finish({
        ok: false,
        detail: `无法创建 WebSocket 连接 (${target}): ${String(err?.message || err).slice(0, 120)}`,
        level: 'warn',
      });
      return;
    }

    ws.on('open', () => {
      // Same auth flow as the frontend: send { type: 'auth', token } and
      // wait for the server's auth_ok / auth_error verdict.
      try {
        ws.send(
          JSON.stringify({
            type: 'auth',
            token: String(process.env.AI_MGMT_AUTH_TOKEN || ''),
          })
        );
      } catch (err) {
        finish({
          ok: false,
          detail: `WebSocket 已连接 (${target}) 但发送认证消息失败: ${String(err?.message || err).slice(0, 120)}`,
          level: 'warn',
        });
      }
    });

    ws.on('message', (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(String(raw || '{}'));
      } catch {
        return;
      }
      const type = String(msg?.type || '');
      if (type === 'auth_ok') {
        finish({
          ok: true,
          detail: `已连接 ${target} 并收到 auth_ok（端口来源: ${source}）`,
          level: 'info',
        });
      } else if (type === 'auth_error' || type === 'auth_failed') {
        finish({
          ok: false,
          detail: `WebSocket 可达 (${target}) 但认证被拒（${String(msg?.message || '未提供有效 token').slice(0, 80)}），可设置 AI_MGMT_AUTH_TOKEN 后重试`,
          level: 'warn',
        });
      }
      // Other message types: keep waiting until auth verdict or timeout.
    });

    ws.on('error', (err) => {
      const code = String(err?.code || '');
      const refused = code === 'ECONNREFUSED';
      finish({
        ok: false,
        detail: refused
          ? `后端服务未运行（端口 ${port} 不可达，来源: ${source}），请先执行 khy start`
          : `连接后端 WebSocket 失败 (${target}): ${String(err?.message || err).slice(0, 120)}`,
        level: 'warn',
      });
    });
  });
}

// ── Check 2: proxy connectivity ──────────────────────────────────────────────

async function checkProxyConnectivity({ onProgress } = {}) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};
  const label = '代理连接测试';

  // Reuse proxyConfigService for both config loading and TCP probing —
  // no duplicated proxy.json parsing here.
  let proxyService = null;
  try {
    proxyService = require('../../services/proxyConfigService');
  } catch (err) {
    return {
      category: CATEGORY,
      label,
      ok: false,
      detail: `无法加载代理配置服务: ${String(err?.message || err).slice(0, 120)}`,
      level: 'warn',
    };
  }

  const config = proxyService.loadConfig();
  if (!config || config.enabled !== true) {
    return {
      category: CATEGORY,
      label,
      ok: true,
      detail: '已跳过（未配置代理）',
      level: 'info',
    };
  }

  const target = `${config.host}:${config.port}`;
  notify(`测试代理连接 (${config.type} ${target})，执行 TCP 可达性探测（第 1/1 次）...`);
  const reachable = await proxyService.testProxy(config.host, config.port, PROBE_TIMEOUT_MS);
  return {
    category: CATEGORY,
    label,
    ok: reachable,
    detail: reachable
      ? `代理可达 (${config.type} ${target})`
      : `代理不可达 (${config.type} ${target})，请确认代理服务已启动，或执行 khy proxy status 查看配置`,
    level: reachable ? 'info' : 'warn',
  };
}

// ── Entry: run both checks ───────────────────────────────────────────────────

/**
 * Run all connectivity checks in parallel; each item matches the shape of
 * runDoctorChecks() entries: { category, label, ok, detail, level }.
 */
async function runConnectivityChecks({ onProgress } = {}) {
  const [wsCheck, proxyCheck] = await Promise.all([
    checkBackendWebSocket({ onProgress }),
    checkProxyConnectivity({ onProgress }),
  ]);
  return [wsCheck, proxyCheck];
}

module.exports = {
  runConnectivityChecks,
  checkBackendWebSocket,
  checkProxyConnectivity,
  resolveBackendEndpoint,
};
