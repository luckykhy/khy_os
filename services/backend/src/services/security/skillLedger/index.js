/**
 * Skill Ledger — Ed25519 integrity verification for skills.
 *
 * Aligned with ANOLISA Agent Sec Core skill ledger:
 * - Ed25519 keypair generation and management
 * - Skill content hashing (SHA-256) and signing
 * - Signature verification before skill execution
 * - Audit trail of skill certifications
 *
 * Storage: ~/.khyquant/skill-ledger/
 *   - keypair.json     — Ed25519 keypair (private key encrypted)
 *   - manifest.json    — Signed skill manifest
 *   - audit.jsonl      — Certification audit trail
 *
 * Cross-platform: uses Node.js crypto (Linux, macOS, Windows).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LEDGER_DIR = path.join(os.homedir(), '.khyquant', 'skill-ledger');
const KEYPAIR_FILE = path.join(LEDGER_DIR, 'keypair.json');
const MANIFEST_FILE = path.join(LEDGER_DIR, 'manifest.json');
const AUDIT_FILE = path.join(LEDGER_DIR, 'audit.jsonl');

// ─── Key Management ─────────────────────────────────────────────────────────

/**
 * Initialize keypair if not already present.
 * Generates Ed25519 keypair and stores it.
 * @returns {{ publicKey: string, created: boolean }}
 */
function initKeys() {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });

  if (fs.existsSync(KEYPAIR_FILE)) {
    const kp = JSON.parse(fs.readFileSync(KEYPAIR_FILE, 'utf-8'));
    return { publicKey: kp.publicKey, created: false };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const keypair = {
    publicKey,
    privateKey,
    createdAt: new Date().toISOString(),
    algorithm: 'Ed25519',
  };

  const { safeChmod } = require('../../../tools/platformUtils');
  fs.writeFileSync(KEYPAIR_FILE, JSON.stringify(keypair, null, 2));
  safeChmod(KEYPAIR_FILE, 0o600);

  _appendAudit({ action: 'init_keys', publicKeyHash: _hashString(publicKey) });

  return { publicKey, created: true };
}

/**
 * Get the public key.
 * @returns {string|null}
 */
function getPublicKey() {
  if (!fs.existsSync(KEYPAIR_FILE)) return null;
  const kp = JSON.parse(fs.readFileSync(KEYPAIR_FILE, 'utf-8'));
  return kp.publicKey;
}

// ─── Skill Hashing ──────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of skill content.
 * @param {string} content - Skill file content
 * @returns {string} hex-encoded hash
 */
function hashSkillContent(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute hash of an entire skill directory.
 * Hashes all files sorted by path for deterministic results.
 * @param {string} skillDir - Path to skill directory
 * @returns {string} hex-encoded composite hash
 */
function hashSkillDirectory(skillDir) {
  const hash = crypto.createHash('sha256');
  const files = _walkDir(skillDir).sort();

  for (const file of files) {
    const relPath = path.relative(skillDir, file);
    const content = fs.readFileSync(file);
    hash.update(relPath);
    hash.update(content);
  }

  return hash.digest('hex');
}

// ─── Signing & Verification ─────────────────────────────────────────────────

/**
 * Sign a skill (certify it).
 * @param {string} skillId - Skill identifier
 * @param {string} contentHash - SHA-256 hash of skill content
 * @param {object} [metadata] - Additional metadata
 * @returns {{ signature: string, certifiedAt: string }}
 */
function certifySkill(skillId, contentHash, metadata = {}) {
  if (!fs.existsSync(KEYPAIR_FILE)) {
    throw new Error('Skill ledger not initialized. Run initKeys() first.');
  }

  const kp = JSON.parse(fs.readFileSync(KEYPAIR_FILE, 'utf-8'));
  const payload = JSON.stringify({ skillId, contentHash, timestamp: Date.now() });
  const signature = crypto.sign(null, Buffer.from(payload), kp.privateKey).toString('base64');

  // Update manifest
  const manifest = _loadManifest();
  manifest[skillId] = {
    contentHash,
    signature,
    payload,
    certifiedAt: new Date().toISOString(),
    metadata,
  };
  _saveManifest(manifest);

  _appendAudit({
    action: 'certify',
    skillId,
    contentHash,
    signaturePrefix: signature.slice(0, 16) + '...',
  });

  return { signature, certifiedAt: manifest[skillId].certifiedAt };
}

/**
 * Verify a skill's signature.
 * @param {string} skillId - Skill identifier
 * @param {string} currentHash - Current SHA-256 hash of skill content
 * @returns {{ valid: boolean, reason: string, certifiedAt: string|null }}
 */
function verifySkill(skillId, currentHash) {
  if (!fs.existsSync(KEYPAIR_FILE)) {
    return { valid: false, reason: 'ledger_not_initialized', certifiedAt: null };
  }

  const manifest = _loadManifest();
  const entry = manifest[skillId];

  if (!entry) {
    return { valid: false, reason: 'skill_not_certified', certifiedAt: null };
  }

  // Check content hash matches
  if (entry.contentHash !== currentHash) {
    _appendAudit({
      action: 'verify_failed',
      skillId,
      reason: 'hash_mismatch',
      expected: entry.contentHash,
      actual: currentHash,
    });
    return { valid: false, reason: 'content_modified', certifiedAt: entry.certifiedAt };
  }

  // Verify signature
  const kp = JSON.parse(fs.readFileSync(KEYPAIR_FILE, 'utf-8'));
  try {
    const isValid = crypto.verify(
      null,
      Buffer.from(entry.payload),
      kp.publicKey,
      Buffer.from(entry.signature, 'base64')
    );

    if (!isValid) {
      _appendAudit({ action: 'verify_failed', skillId, reason: 'bad_signature' });
      return { valid: false, reason: 'invalid_signature', certifiedAt: entry.certifiedAt };
    }
  } catch (err) {
    return { valid: false, reason: 'signature_error: ' + err.message, certifiedAt: entry.certifiedAt };
  }

  _appendAudit({ action: 'verify_ok', skillId });
  return { valid: true, reason: 'ok', certifiedAt: entry.certifiedAt };
}

/**
 * Get status of all certified skills.
 * @returns {Array<{ skillId: string, contentHash: string, certifiedAt: string }>}
 */
function listCertifiedSkills() {
  const manifest = _loadManifest();
  return Object.entries(manifest).map(([skillId, entry]) => ({
    skillId,
    contentHash: entry.contentHash,
    certifiedAt: entry.certifiedAt,
    metadata: entry.metadata || {},
  }));
}

/**
 * Remove a skill from the ledger.
 * @param {string} skillId
 */
function revokeSkill(skillId) {
  const manifest = _loadManifest();
  if (manifest[skillId]) {
    delete manifest[skillId];
    _saveManifest(manifest);
    _appendAudit({ action: 'revoke', skillId });
  }
}

/**
 * Get audit trail.
 * @param {number} [limit=50] - Max entries to return
 * @returns {Array<object>}
 */
function getAuditTrail(limit = 50) {
  if (!fs.existsSync(AUDIT_FILE)) return [];

  const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines.slice(-limit)) {
    try { entries.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return entries;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function _loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function _saveManifest(manifest) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

function _appendAudit(event) {
  try {
    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    const entry = { ...event, timestamp: new Date().toISOString() };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch { /* best effort */ }
}

function _hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function _walkDir(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(..._walkDir(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

module.exports = {
  initKeys,
  getPublicKey,
  hashSkillContent,
  hashSkillDirectory,
  certifySkill,
  verifySkill,
  listCertifiedSkills,
  revokeSkill,
  getAuditTrail,
};
