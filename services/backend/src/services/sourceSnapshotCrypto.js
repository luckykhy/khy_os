'use strict';

/**
 * sourceSnapshotCrypto — single source of truth for the encrypted full-source
 * snapshot format shipped inside the pip wheel / npm package.
 *
 * Both the build-time generator (scripts/makeSourceSnapshot.js) and the
 * restore command (cli/handlers/publish.js :: _restoreFromSnapshot) use THIS
 * module so encrypt and decrypt can never drift apart.
 *
 * Format on disk (under a `_source/` directory):
 *   - khy-os-source.tar.gz.enc   ciphertext (AES-256-GCM of a `git archive` tar.gz)
 *   - snapshot.json              metadata + crypto params (see makeHeader)
 *
 * Key derivation: scrypt(secret, salt) → 32-byte key. The secret is the owner /
 * source-release passphrase (KHY_SOURCE_PUBLISH_SECRET / --secret); it is NEVER
 * written into the package. Only salt/iv/authTag/params travel in snapshot.json,
 * which are useless without the secret.
 *
 * Pure Node built-ins (`crypto`) — no third-party dependency.
 */

const crypto = require('crypto');

const SNAPSHOT_ENC_NAME = 'khy-os-source.tar.gz.enc';
const SNAPSHOT_META_NAME = 'snapshot.json';
const RESTORE_DOC_NAME = 'RESTORE_WINDOWS.md';

// Default passphrase used when no explicit secret is supplied. Source publishing
// and restore are no longer password-gated: the build embeds the snapshot under
// this fixed key and `khy restore` decrypts with it automatically, so real source
// always ships and always restores without any user input. An explicit
// KHY_SOURCE_PUBLISH_SECRET / --secret still overrides it. The value matches the
// historical built-in study secret so snapshots produced before this change
// (encrypted with `khy2026`) keep restoring with no extra step.
const DEFAULT_SOURCE_SECRET = 'khy2026';

/** Resolve an effective secret, falling back to the password-free default. */
function resolveSourceSecret(secret) {
  const s = secret == null ? '' : String(secret).trim();
  return s || DEFAULT_SOURCE_SECRET;
}

const ALGO = 'aes-256-gcm';
// scrypt cost: N=2^14 keeps memory ≈16MB, safely under Node's default 32MB
// maxmem so scryptSync never throws on constrained machines. Params are stored
// in the header so decrypt always uses the same cost as encrypt.
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 });

function _normalizeSecret(secret) {
  const s = secret == null ? '' : String(secret);
  if (!s) throw new Error('source snapshot secret is empty');
  return s;
}

/** Derive the 32-byte AES key from the passphrase + salt using stored params. */
function deriveKey(secret, salt, params = SCRYPT) {
  return crypto.scryptSync(_normalizeSecret(secret), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
}

/**
 * Encrypt a plaintext buffer. Returns { ciphertext: Buffer, crypto: {...} } where
 * the `crypto` object is meant to be embedded into snapshot.json (base64 fields).
 */
function encrypt(plaintext, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12); // 96-bit nonce, GCM standard
  const key = deriveKey(secret, salt, SCRYPT);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext,
    crypto: {
      algo: ALGO,
      kdf: 'scrypt',
      scrypt: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen },
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    },
  };
}

/**
 * Decrypt ciphertext using the crypto params stored in the snapshot header.
 * Throws on a wrong secret / tampering (GCM auth failure).
 *
 * @param {Buffer} ciphertext
 * @param {object} header  the parsed snapshot.json (must contain `.crypto`)
 * @param {string} secret
 * @returns {Buffer} plaintext (a tar.gz buffer)
 */
function decrypt(ciphertext, header, secret) {
  const c = header && header.crypto;
  if (!c || c.algo !== ALGO) {
    throw new Error('unsupported or missing snapshot crypto header');
  }
  const params = {
    N: (c.scrypt && c.scrypt.N) || SCRYPT.N,
    r: (c.scrypt && c.scrypt.r) || SCRYPT.r,
    p: (c.scrypt && c.scrypt.p) || SCRYPT.p,
    keylen: (c.scrypt && c.scrypt.keylen) || SCRYPT.keylen,
    maxmem: SCRYPT.maxmem,
  };
  const salt = Buffer.from(c.salt, 'base64');
  const iv = Buffer.from(c.iv, 'base64');
  const authTag = Buffer.from(c.authTag, 'base64');
  const key = deriveKey(secret, salt, params);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  // final() throws "Unsupported state or unable to authenticate data" on a wrong
  // key/tag — caller maps that to a friendly "wrong secret" message.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** sha256 hex of a buffer (used to verify plaintext integrity end-to-end). */
function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

module.exports = {
  SNAPSHOT_ENC_NAME,
  SNAPSHOT_META_NAME,
  RESTORE_DOC_NAME,
  DEFAULT_SOURCE_SECRET,
  ALGO,
  SCRYPT,
  deriveKey,
  resolveSourceSecret,
  encrypt,
  decrypt,
  sha256Hex,
};
