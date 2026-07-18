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
import os from 'node:os';
import path from 'node:path';

// Loopback last-resort default. Frontend is a separate browser package and
// cannot import backend code, so this MIRRORS serviceDefaults.AI_BACKEND_DEFAULT_URL
// (services/backend/src/constants/serviceDefaults.js) — keep the port in lock-step.
// Env-overridable so a non-default daemon port needs no code edit here.
const DEFAULT_BACKEND_PORT = process.env.KHY_DAEMON_PORT || '9090';
export const DEFAULT_BACKEND_TARGET = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;

function readApiPortFromRuntime(dataHome, fsImpl) {
  if (!dataHome) return null;
  try {
    const file = path.join(dataHome, 'ai_manage_runtime.json');
    const raw = JSON.parse(fsImpl.readFileSync(file, 'utf-8'));
    const apiPort = parseInt(String(raw?.apiPort ?? ''), 10);
    if (Number.isFinite(apiPort) && apiPort > 0 && apiPort <= 65535) return apiPort;
  } catch { /* missing/corrupt → try next candidate */ }
  return null;
}

function readPointerDataHome(fsImpl, env, homedir) {
  try {
    const pointerFile = env.KHY_LOCATION_FILE
      || path.join(homedir, '.khy', '.location.json');
    const obj = JSON.parse(fsImpl.readFileSync(pointerFile, 'utf-8'));
    if (obj && typeof obj === 'object' && obj.dataHome) return String(obj.dataHome);
  } catch { /* no/corrupt pointer → ignore */ }
  return null;
}

export function resolveBackendTarget(env = process.env, opts = {}) {
  // 1. Explicit override always wins (preserves prior behavior).
  const explicit = env.VITE_AI_PROXY_TARGET || env.VITE_AI_API_BASE_URL;
  if (explicit) return explicit;

  const fsImpl = opts.fs || fs;
  const homedir = opts.homedir || os.homedir();

  // 2. Discover the actual backend apiPort from the runtime file, honoring the
  //    same data-home precedence the backend uses (explicit → pinned pointer →
  //    default ~/.khy → legacy ~/.khyquant).
  const dataHomes = [];
  if (env.KHY_DATA_HOME) dataHomes.push(env.KHY_DATA_HOME);
  const pointerHome = readPointerDataHome(fsImpl, env, homedir);
  if (pointerHome) dataHomes.push(pointerHome);
  dataHomes.push(path.join(homedir, '.khy'));
  dataHomes.push(path.join(homedir, '.khyquant'));

  for (const dataHome of dataHomes) {
    const port = readApiPortFromRuntime(dataHome, fsImpl);
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
