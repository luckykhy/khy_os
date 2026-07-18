/**
 * @pattern Strategy
 */
'use strict';

const crypto = require('crypto');

/**
 * Unified API Key hashing utility.
 * Single source of truth for key_hash generation across the system.
 */

function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex');
}

function extractPrefix(key) {
  return String(key || '').slice(0, 12);
}

function generateKey() {
  return 'khy_' + crypto.randomBytes(24).toString('hex');
}

module.exports = { hashApiKey, extractPrefix, generateKey };
