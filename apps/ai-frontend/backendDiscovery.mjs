// Resolve the dev-proxy target for the AI backend.
//
// Why this exists: the backend daemon self-heals its listen port when the
// requested one is occupied (port drift), and records the actual port in
// `ai_manage_runtime.json` (field `apiPort`). A hardcoded `127.0.0.1:9090`
// proxy target means "backend healed, frontend did not follow". This helper
// discovers the real port from the runtime file so the dev proxy tracks the
// backend automatically.
//
// Precedence mirrors the backend's serviceDefaults._discoverAiBackendUrl:
//   1. explicit env override (VITE_AI_PROXY_TARGET / VITE_AI_API_BASE_URL)
//   2. apiPort from ai_manage_runtime.json across known data homes
//   3. env port hints (KHY_DAEMON_PORT / AI_MGMT_PORT)
//   4. last-resort default 127.0.0.1:9090
//
// This is a separate ESM module (frontend is its own package and cannot import
// backend code) and is read-only: it never creates directories or files.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Loopback last-resort default. Frontend is a separate browser package and
// cannot import backend code, so this MIRRORS serviceDefaults.AI_BACKEND_DEFAULT_URL
// (services/backend/src/constants/serviceDefaults.js) — keep the port in lock-step.
// Env-overridable so a non-default daemon port needs no code edit here.
const DEFAULT_BACKEND_PORT = process.env.KHY_DAEMON_PORT || '9090';
export const DEFAULT_BACKEND_TARGET = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;

// Web backend (services/backend/server.js) last-resort default — mirrors
// serviceDefaults.BACKEND_PORT (`PORT || 3000`). Only used when no live
// backend_runtime.json exists AND the default port answers.
const DEFAULT_WEB_PORT = process.env.PORT || '3000';
export const DEFAULT_WEB_BACKEND_TARGET = `http://127.0.0.1:${DEFAULT_WEB_PORT}`;

// The web backend (services/backend/server.js) writes `backend_runtime.json`;
// the local AI daemon writes `ai_manage_runtime.json`.
const WEB_RUNTIME_FILENAMES = ['backend_runtime.json'];
const ANY_RUNTIME_FILENAMES = ['backend_runtime.json', 'ai_manage_runtime.json'];

// A runtime file outlives an ungraceful kill (SIGKILL / TaskStop does not run
// the exit hook that would clear it), so a stale file can point at a dead port
// forever — that is how the dev proxy once locked onto a dead 3001 while both
// real backends were up. The `pid` field exists precisely to detect this.
function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return true; // not recorded → don't block on it
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but belongs to another user → alive.
    return !!err && err.code === 'EPERM';
  }
}

function portOf(target) {
  const m = String(target || '').match(/:(\d+)(?:\/|$)/);
  return m ? parseInt(m[1], 10) : null;
}

// Cheap liveness probe so the proxy target is a server that is actually up.
// Read-only TCP connect to loopback; `timeoutMs` bounds the wait at config load.
export function isTargetReachable(target, timeoutMs = 400) {
  const port = portOf(target);
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function readApiPortFromRuntime(dataHome, fsImpl, filenames) {
  if (!dataHome) return null;
  for (const filename of filenames) {
    try {
      const file = path.join(dataHome, filename);
      const raw = JSON.parse(fsImpl.readFileSync(file, 'utf-8'));
      // Stale-file guard: a recorded pid that is no longer alive means this
      // entry describes a dead server — skip it and try the next candidate.
      if (raw?.pid && !isPidAlive(raw.pid)) continue;
      const apiPort = parseInt(String(raw?.apiPort ?? ''), 10);
      if (Number.isFinite(apiPort) && apiPort > 0 && apiPort <= 65535) return apiPort;
    } catch { /* missing/corrupt → try next candidate */ }
  }
  return null;
}

function readPointerDataHomes(fsImpl, env, homedir) {
  try {
    const pointerFile = env.KHY_LOCATION_FILE
      || path.join(homedir, '.khy', '.location.json');
    const obj = JSON.parse(fsImpl.readFileSync(pointerFile, 'utf-8'));
    if (!obj || typeof obj !== 'object') return [];
    // The backend may pin its data home under the portable/app root and write
    // the pointer as `~PORTABLE~/<rel>` (see services/backend dataHome.js).
    // Resolve that against this package's app root (two levels up from
    // apps/ai-frontend), mirroring the backend's read direction.
    const resolvePortable = (value) => {
      if (typeof value !== 'string') return null;
      const PREFIX = '~PORTABLE~/';
      if (value === '~PORTABLE~') return path.resolve(__dirname, '../..');
      if (value.startsWith(PREFIX) || value.startsWith('~PORTABLE~\\')) {
        return path.resolve(__dirname, '../..', value.slice(PREFIX.length));
      }
      return value;
    };
    const homes = [];
    for (const key of ['projectDataHome', 'dataHome']) {
      const home = resolvePortable(obj[key]);
      if (home) homes.push(home);
    }
    return homes;
  } catch { /* no/corrupt pointer → ignore */ }
  return [];
}

export function resolveBackendTarget(env = process.env, opts = {}) {
  // 1. Explicit override always wins (preserves prior behavior).
  const explicit = env.VITE_AI_PROXY_TARGET || env.VITE_AI_API_BASE_URL;
  if (explicit) return explicit;

  const fsImpl = opts.fs || fs;
  const homedir = opts.homedir || os.homedir();

  // 2. Discover the actual backend apiPort from the runtime file, honoring the
  //    same data-home precedence the backend uses (explicit → pinned pointer →
  //    default ~/.khy → legacy ~/.khyquant). Entries whose recorded pid is dead
  //    are skipped (stale-file guard above), so a killed backend's file can no
  //    longer pin the proxy to a port nobody listens on.
  const dataHomes = [];
  if (env.KHY_DATA_HOME) dataHomes.push(env.KHY_DATA_HOME);
  const pointerHomes = readPointerDataHomes(fsImpl, env, homedir);
  dataHomes.push(...pointerHomes);
  dataHomes.push(path.join(homedir, '.khy'));
  dataHomes.push(path.join(homedir, '.khyquant'));

  for (const dataHome of dataHomes) {
    const port = readApiPortFromRuntime(dataHome, fsImpl, ANY_RUNTIME_FILENAMES);
    if (port) return `http://127.0.0.1:${port}`;
  }

  // 3. Env port hints (when no runtime file exists yet).
  const envPort = parseInt(String(env.KHY_DAEMON_PORT || env.AI_MGMT_PORT || ''), 10);
  if (Number.isFinite(envPort) && envPort > 0 && envPort <= 65535) {
    return `http://127.0.0.1:${envPort}`;
  }

  // 4. Last-resort default.
  return DEFAULT_BACKEND_TARGET;
}

// Resolve the WEB backend (services/backend/server.js) target — the server that
// owns auth, api-keys, the user-scoped ai-gateway/payments route and the
// cross-platform WebSocket. Only `backend_runtime.json` counts here: the
// daemon's `ai_manage_runtime.json` describes a different server that does NOT
// serve those routes.
//
// Precedence: explicit env → live backend_runtime.json → default port (mirrors
// serviceDefaults.BACKEND_PORT) when it answers → daemon (keeps daemon-only
// setups working, matching the documented single-backend fallback).
export async function resolveWebBackendTarget(env = process.env, opts = {}) {
  const explicit = env.VITE_API_TARGET || env.VITE_MONOLITH_TARGET;
  if (explicit) return explicit;

  const fsImpl = opts.fs || fs;
  const homedir = opts.homedir || os.homedir();
  const dataHomes = [];
  if (env.KHY_DATA_HOME) dataHomes.push(env.KHY_DATA_HOME);
  dataHomes.push(...readPointerDataHomes(fsImpl, env, homedir));
  dataHomes.push(path.join(homedir, '.khy'));
  dataHomes.push(path.join(homedir, '.khyquant'));

  for (const dataHome of dataHomes) {
    const port = readApiPortFromRuntime(dataHome, fsImpl, WEB_RUNTIME_FILENAMES);
    if (port) return `http://127.0.0.1:${port}`;
  }

  if (await isTargetReachable(DEFAULT_WEB_BACKEND_TARGET, 400)) {
    return DEFAULT_WEB_BACKEND_TARGET;
  }
  return resolveBackendTarget(env, opts);
}
