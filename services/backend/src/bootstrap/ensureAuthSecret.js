'use strict';

/**
 * ensureJwtSecret() — single source of truth for the JWT signing secret.
 *
 * Every auth path (ai-backend `auth.js` sign, shared `middleware/auth` verify,
 * `aiManagementServer` username/password login) reads `process.env.JWT_SECRET`
 * directly. When that variable is absent the daemon's login handler returns
 * "JWT_SECRET is not configured", which the frontend surfaces as
 * "后端认证配置缺失（JWT_SECRET）". The root cause is that the canonical env
 * file (`services/backend/.env`, i.e. `$KHY_ENV_FILE`) may not carry the key.
 *
 * Resolution order — never hardcode a secret:
 *   1. process.env.JWT_SECRET (already loaded by dotenv) — use as-is.
 *   2. The canonical .env file on disk — load it into process.env.
 *   3. Self-provision: generate a strong random secret, persist it to the
 *      canonical .env (so it is STABLE across restarts — issued tokens keep
 *      working — and shared by every process that loads that file), and set
 *      process.env.
 *
 * Persistence reuses gatewayEnvFile.writeEnvMap so the secret is written the
 * same single-source way as every other managed env var (canonical + mirror),
 * and process.env is updated in the same call.
 *
 * State transparency: when a secret is generated, the provided `log` callback
 * is invoked once so the operator knows what happened. This is a one-time
 * event — subsequent starts read the persisted value (source 'file'/'env').
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// jsonwebtoken accepts any non-empty secret, but the shared env validator
// (config/env.js) requires >= 32 chars; align with it so a provisioned secret
// never trips that gate.
const MIN_SECRET_LEN = 32;

function _canonicalEnvPath() {
  if (process.env.KHY_ENV_FILE) return path.resolve(process.env.KHY_ENV_FILE);
  return path.resolve(
    process.env.KHYQUANT_ROOT || path.resolve(__dirname, '../..'),
    '.env'
  );
}

function _readEnvValueFromFile(file, key) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
  // Match `KEY=value` on its own line; tolerate surrounding whitespace.
  const m = content.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, 'm'));
  if (!m) return '';
  // Strip optional surrounding quotes, mirroring dotenv parsing.
  return m[1].trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Ensure process.env.JWT_SECRET is set to a usable value.
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {{ secret: string, source: 'env'|'file'|'generated' }}
 */
function ensureJwtSecret(opts = {}) {
  const emit = typeof opts.log === 'function' ? opts.log : () => {};

  const current = String(process.env.JWT_SECRET || '').trim();
  if (current.length >= MIN_SECRET_LEN) {
    return { secret: current, source: 'env' };
  }

  const envPath = _canonicalEnvPath();

  const fromFile = _readEnvValueFromFile(envPath, 'JWT_SECRET');
  if (fromFile.length >= MIN_SECRET_LEN) {
    process.env.JWT_SECRET = fromFile;
    return { secret: fromFile, source: 'file' };
  }

  // Nothing usable anywhere — provision a strong secret (64 hex chars).
  const generated = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = generated;

  try {
    // writeEnvMap persists to the canonical (+ mirror) env file AND updates
    // process.env for each key — single-source env mutation.
    const gatewayEnvFile = require('../services/gatewayEnvFile');
    gatewayEnvFile.writeEnvMap({ JWT_SECRET: generated }, { envPath });
    emit(`JWT_SECRET 缺失，已自动生成强随机密钥并写入 ${envPath}（重启后保持，登录态不失效）`);
  } catch (err) {
    // Could not persist (read-only fs, etc.). The in-memory secret still lets
    // this process serve logins; warn that it will rotate on restart.
    emit(`JWT_SECRET 缺失，已生成临时密钥但写入 .env 失败（${err.message}）；重启后密钥会变化、已签发的登录态将失效`);
  }

  return { secret: generated, source: 'generated' };
}

module.exports = { ensureJwtSecret, _canonicalEnvPath, _readEnvValueFromFile };
