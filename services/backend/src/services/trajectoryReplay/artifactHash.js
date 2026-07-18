'use strict';

/**
 * artifactHash.js — content & artifact hashing for trajectory replay (DESIGN-ARCH-048).
 *
 * Thin, total wrappers over sourceSnapshotCrypto.sha256Hex. Centralizes "what to
 * hash" so the record side and the replay verify side compute identical digests.
 * Every function fails soft (returns null) rather than throwing — the ledger is
 * best-effort evidence on the hot path.
 */

const fs = require('fs');
const { sha256Hex } = require('../sourceSnapshotCrypto');

/** sha256 of a UTF-8 string. */
function hashString(s) {
  try {
    return sha256Hex(Buffer.from(s == null ? '' : String(s), 'utf-8'));
  } catch {
    return null;
  }
}

/** Read a file's raw bytes; null if unreadable/non-file. */
function readBytes(filePath) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    return fs.readFileSync(filePath);
  } catch {
    return null;
  }
}

/** sha256 of a file's raw bytes; null if unreadable. */
function hashFile(filePath) {
  const buf = readBytes(filePath);
  if (buf == null) return null;
  try {
    return sha256Hex(buf);
  } catch {
    return null;
  }
}

/** Deterministic sha256 over a canonical JSON serialization of any value. */
function hashCanonical(value) {
  try {
    return sha256Hex(Buffer.from(JSON.stringify(value) || '', 'utf-8'));
  } catch {
    try {
      return sha256Hex(Buffer.from(String(value), 'utf-8'));
    } catch {
      return null;
    }
  }
}

module.exports = { hashString, readBytes, hashFile, hashCanonical, sha256Hex };
