const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const OWNER_CONTROL_FILE = path.join(os.homedir(), '.khyquant', 'owner-control.json');
const ITERATIONS = 120000;
const KEY_LENGTH = 64;
const DIGEST = 'sha512';
const MIN_SECRET_LENGTH = 8;

// Built-in study mode secret — users must obtain this from the administrator.
// This ensures study mode cannot be self-provisioned after a bare pip install.
// Keep both forms for backward compatibility.
const _extraSecret = process.env.KHY_STUDY_SECRET || '';
const BUILTIN_STUDY_SECRETS = new Set(['khy2026', 'khy-2026', ...(_extraSecret ? [_extraSecret] : [])]);

function _ensureDir() {
  const dir = path.dirname(OWNER_CONTROL_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function _readConfig() {
  try {
    if (!fs.existsSync(OWNER_CONTROL_FILE)) return null;
    const raw = fs.readFileSync(OWNER_CONTROL_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _writeConfig(data) {
  _ensureDir();
  fs.writeFileSync(OWNER_CONTROL_FILE, JSON.stringify(data, null, 2), 'utf-8');
  try { fs.chmodSync(OWNER_CONTROL_FILE, 0o600); } catch { /* Windows/no-op */ }
}

function _hashSecret(secret, salt) {
  const normalized = String(secret || '');
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(normalized, s, ITERATIONS, KEY_LENGTH, DIGEST).toString('hex');
  return { hash, salt: s };
}

function _validateSecret(secret) {
  const normalized = String(secret || '').trim();
  if (normalized.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      error: `Owner secret must be at least ${MIN_SECRET_LENGTH} characters.`,
    };
  }
  return { ok: true, value: normalized };
}

function isOwnerControlConfigured() {
  const cfg = _readConfig();
  return !!(cfg && cfg.ownerSecretHash && cfg.ownerSecretSalt);
}

function getOwnerControlStatus() {
  const cfg = _readConfig();
  return {
    configured: !!(cfg && cfg.ownerSecretHash && cfg.ownerSecretSalt),
    updatedAt: cfg?.updatedAt || null,
    version: cfg?.version || 1,
  };
}

function initializeOwnerControl(secret) {
  const check = _validateSecret(secret);
  if (!check.ok) return check;

  if (isOwnerControlConfigured()) {
    return {
      ok: false,
      error: 'Owner control is already initialized. Use ai owner rotate to change the secret.',
    };
  }

  const { hash, salt } = _hashSecret(check.value);
  _writeConfig({
    version: 1,
    ownerSecretHash: hash,
    ownerSecretSalt: salt,
    updatedAt: new Date().toISOString(),
  });

  return { ok: true };
}

function verifyOwnerSecret(secret) {
  const normalized = String(secret || '').trim();

  // Built-in secret is always accepted — it is the admin-distributed study
  // mode password and must work regardless of custom owner-control config.
  if (BUILTIN_STUDY_SECRETS.has(normalized)) {
    const cfg = _readConfig();
    return { ok: true, configured: !!(cfg && cfg.ownerSecretHash) };
  }

  // Check against custom owner secret if one has been configured.
  const cfg = _readConfig();
  if (cfg && cfg.ownerSecretHash && cfg.ownerSecretSalt) {
    const { hash } = _hashSecret(normalized, cfg.ownerSecretSalt);
    if (hash !== cfg.ownerSecretHash) {
      return { ok: false, configured: true, error: 'Owner secret verification failed.' };
    }
    return { ok: true, configured: true };
  }

  return {
    ok: false,
    configured: false,
    error: 'Secret 不正确。请联系管理员获取学习模式密码。',
  };
}

function rotateOwnerSecret(currentSecret, nextSecret) {
  const current = verifyOwnerSecret(currentSecret);
  if (!current.ok) return current;

  const next = _validateSecret(nextSecret);
  if (!next.ok) return next;

  const { hash, salt } = _hashSecret(next.value);
  _writeConfig({
    version: 1,
    ownerSecretHash: hash,
    ownerSecretSalt: salt,
    updatedAt: new Date().toISOString(),
  });

  return { ok: true };
}

module.exports = {
  isOwnerControlConfigured,
  getOwnerControlStatus,
  initializeOwnerControl,
  verifyOwnerSecret,
  rotateOwnerSecret,
};
