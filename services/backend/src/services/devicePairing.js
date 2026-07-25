'use strict';

/**
 * devicePairing.js — Cryptographic device pairing and identity management.
 *
 * Ported from OpenClaw's device-pairing (1107 lines).
 * Provides Ed25519 keypair identity, SHA256 fingerprinting, role-based
 * token scopes with operator prefix filtering, and async lock for safe
 * concurrent state mutations.
 *
 * Key features:
 * - Ed25519 keypair generation and management
 * - SHA256 device fingerprinting
 * - Token-based authentication with scopes
 * - Role hierarchy (owner > admin > operator > viewer)
 * - Pairing lifecycle (request → approve/reject → active → revoke)
 * - Async mutex for state protection
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── Roles ──

const ROLE = {
  OWNER:    'owner',
  ADMIN:    'admin',
  OPERATOR: 'operator',
  VIEWER:   'viewer',
};

const ROLE_HIERARCHY = [ROLE.OWNER, ROLE.ADMIN, ROLE.OPERATOR, ROLE.VIEWER];

// ── Token scopes ──

const SCOPE = {
  READ:       'read',
  WRITE:      'write',
  EXECUTE:    'execute',
  ADMIN:      'admin',
  PAIR:       'pair',
};

const ROLE_SCOPES = {
  [ROLE.OWNER]:    [SCOPE.READ, SCOPE.WRITE, SCOPE.EXECUTE, SCOPE.ADMIN, SCOPE.PAIR],
  [ROLE.ADMIN]:    [SCOPE.READ, SCOPE.WRITE, SCOPE.EXECUTE, SCOPE.ADMIN],
  [ROLE.OPERATOR]: [SCOPE.READ, SCOPE.WRITE, SCOPE.EXECUTE],
  [ROLE.VIEWER]:   [SCOPE.READ],
};

// ── Pairing states ──

const PAIRING_STATE = {
  PENDING:   'pending',
  ACTIVE:    'active',
  REJECTED:  'rejected',
  REVOKED:   'revoked',
  EXPIRED:   'expired',
};

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PAIRING_REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Async mutex ──

class AsyncMutex {
  constructor() {
    this._locked = false;
    this._queue = [];
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise(resolve => this._queue.push(resolve));
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }

  async withLock(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/**
 * @typedef {object} DeviceIdentity
 * @property {string} deviceId - Unique device identifier
 * @property {string} fingerprint - SHA256 fingerprint of public key
 * @property {Buffer} publicKey - Ed25519 public key
 * @property {Buffer} [privateKey] - Ed25519 private key (only on local device)
 * @property {string} name - Human-readable device name
 * @property {number} createdAt
 */

/**
 * @typedef {object} PairedDevice
 * @property {string} deviceId
 * @property {string} fingerprint
 * @property {string} name
 * @property {string} role
 * @property {string} state - PAIRING_STATE
 * @property {string[]} scopes
 * @property {string} [token] - Active session token
 * @property {number} [tokenExpiresAt]
 * @property {number} pairedAt
 * @property {number} lastSeenAt
 */

class DevicePairingManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.identityPath] - Path to store local identity
   * @param {number} [opts.tokenTtlMs]
   * @param {number} [opts.requestTtlMs]
   */
  constructor(opts = {}) {
    this._identityPath = opts.identityPath || null;
    this._tokenTtlMs = opts.tokenTtlMs || TOKEN_TTL_MS;
    this._requestTtlMs = opts.requestTtlMs || PAIRING_REQUEST_TTL_MS;

    /** @type {DeviceIdentity|null} */
    this._localIdentity = null;

    /** @type {Map<string, PairedDevice>} deviceId → PairedDevice */
    this._devices = new Map();

    /** @type {Map<string, string>} token → deviceId */
    this._tokenIndex = new Map();

    this._mutex = new AsyncMutex();

    // Load identity if path provided
    this._loadIdentity();
  }

  /**
   * Get or create the local device identity.
   *
   * @param {string} [deviceName]
   * @returns {Promise<DeviceIdentity>}
   */
  async getLocalIdentity(deviceName) {
    return this._mutex.withLock(async () => {
      if (this._localIdentity) return this._publicIdentity(this._localIdentity);

      // Generate Ed25519 keypair
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

      const pubBuf = publicKey.export({ type: 'spki', format: 'der' });
      const fingerprint = crypto.createHash('sha256').update(pubBuf).digest('hex');
      const deviceId = fingerprint.slice(0, 16);

      this._localIdentity = {
        deviceId,
        fingerprint,
        publicKey: pubBuf,
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
        name: deviceName || `device-${deviceId.slice(0, 8)}`,
        createdAt: Date.now(),
      };

      this._saveIdentity();
      return this._publicIdentity(this._localIdentity);
    });
  }

  /**
   * Create a pairing request for a remote device.
   *
   * @param {string} remoteFingerprint
   * @param {string} remoteName
   * @param {string} role
   * @returns {Promise<{ requestId: string, expiresAt: number }>}
   */
  async createPairingRequest(remoteFingerprint, remoteName, role = ROLE.OPERATOR) {
    return this._mutex.withLock(async () => {
      if (!ROLE_HIERARCHY.includes(role)) {
        throw new Error(`Invalid role: ${role}`);
      }

      const deviceId = remoteFingerprint.slice(0, 16);
      const requestId = crypto.randomBytes(8).toString('hex');

      this._devices.set(deviceId, {
        deviceId,
        fingerprint: remoteFingerprint,
        name: remoteName,
        role,
        state: PAIRING_STATE.PENDING,
        scopes: ROLE_SCOPES[role] || [],
        token: null,
        tokenExpiresAt: null,
        pairedAt: Date.now(),
        lastSeenAt: Date.now(),
        _requestId: requestId,
      });

      const expiresAt = Date.now() + this._requestTtlMs;

      // Auto-expire after TTL
      setTimeout(() => {
        const device = this._devices.get(deviceId);
        if (device && device.state === PAIRING_STATE.PENDING) {
          device.state = PAIRING_STATE.EXPIRED;
        }
      }, this._requestTtlMs);

      return { requestId, expiresAt, deviceId };
    });
  }

  /**
   * Approve a pairing request and issue a session token.
   *
   * @param {string} deviceId
   * @returns {Promise<{ token: string, expiresAt: number }>}
   */
  async approvePairing(deviceId) {
    return this._mutex.withLock(async () => {
      const device = this._devices.get(deviceId);
      if (!device) throw new Error('Device not found');
      if (device.state !== PAIRING_STATE.PENDING) {
        throw new Error(`Cannot approve device in state: ${device.state}`);
      }

      device.state = PAIRING_STATE.ACTIVE;
      device.pairedAt = Date.now();

      // Issue token
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + this._tokenTtlMs;
      device.token = token;
      device.tokenExpiresAt = expiresAt;

      this._tokenIndex.set(token, deviceId);

      return { token, expiresAt };
    });
  }

  /**
   * Reject a pairing request.
   */
  async rejectPairing(deviceId) {
    return this._mutex.withLock(async () => {
      const device = this._devices.get(deviceId);
      if (!device) throw new Error('Device not found');
      device.state = PAIRING_STATE.REJECTED;
    });
  }

  /**
   * Revoke an active pairing.
   */
  async revokePairing(deviceId) {
    return this._mutex.withLock(async () => {
      const device = this._devices.get(deviceId);
      if (!device) throw new Error('Device not found');

      if (device.token) {
        this._tokenIndex.delete(device.token);
        device.token = null;
        device.tokenExpiresAt = null;
      }

      device.state = PAIRING_STATE.REVOKED;
    });
  }

  /**
   * Validate a session token and return the associated device.
   *
   * @param {string} token
   * @returns {{ valid: boolean, device?: PairedDevice, scopes?: string[] }}
   */
  validateToken(token) {
    if (!token) return { valid: false };

    const deviceId = this._tokenIndex.get(token);
    if (!deviceId) return { valid: false };

    const device = this._devices.get(deviceId);
    if (!device) {
      this._tokenIndex.delete(token);
      return { valid: false };
    }

    if (device.state !== PAIRING_STATE.ACTIVE) {
      return { valid: false };
    }

    if (device.tokenExpiresAt && Date.now() > device.tokenExpiresAt) {
      this._tokenIndex.delete(token);
      device.token = null;
      device.tokenExpiresAt = null;
      device.state = PAIRING_STATE.EXPIRED;
      return { valid: false };
    }

    device.lastSeenAt = Date.now();

    return {
      valid: true,
      device: { ...device, token: undefined }, // don't leak token
      scopes: device.scopes,
    };
  }

  /**
   * Check if a token has a specific scope.
   *
   * @param {string} token
   * @param {string} scope
   * @returns {boolean}
   */
  hasScope(token, scope) {
    const { valid, scopes } = this.validateToken(token);
    return valid && scopes?.includes(scope);
  }

  /**
   * Refresh a device's token.
   */
  async refreshToken(deviceId) {
    return this._mutex.withLock(async () => {
      const device = this._devices.get(deviceId);
      if (!device || device.state !== PAIRING_STATE.ACTIVE) {
        throw new Error('Device not active');
      }

      // Revoke old token
      if (device.token) {
        this._tokenIndex.delete(device.token);
      }

      // Issue new token
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + this._tokenTtlMs;
      device.token = token;
      device.tokenExpiresAt = expiresAt;
      this._tokenIndex.set(token, deviceId);

      return { token, expiresAt };
    });
  }

  /**
   * List all paired devices.
   *
   * @param {object} [filter]
   * @param {string} [filter.state]
   * @param {string} [filter.role]
   * @returns {PairedDevice[]}
   */
  listDevices(filter) {
    const result = [];
    for (const device of this._devices.values()) {
      if (filter?.state && device.state !== filter.state) continue;
      if (filter?.role && device.role !== filter.role) continue;
      result.push({ ...device, token: undefined }); // don't leak tokens
    }
    return result;
  }

  /**
   * Check if a role has sufficient privilege.
   *
   * @param {string} role
   * @param {string} requiredRole
   * @returns {boolean}
   */
  hasRolePrivilege(role, requiredRole) {
    const roleIdx = ROLE_HIERARCHY.indexOf(role);
    const requiredIdx = ROLE_HIERARCHY.indexOf(requiredRole);
    return roleIdx >= 0 && requiredIdx >= 0 && roleIdx <= requiredIdx;
  }

  /**
   * Sign data with the local device's private key.
   *
   * @param {Buffer|string} data
   * @returns {Buffer}
   */
  sign(data) {
    if (!this._localIdentity?.privateKey) {
      throw new Error('Local identity not initialized');
    }

    const privKey = crypto.createPrivateKey({
      key: Buffer.from(this._localIdentity.privateKey),
      format: 'der',
      type: 'pkcs8',
    });

    return crypto.sign(null, Buffer.from(data), privKey);
  }

  /**
   * Verify a signature against a device's public key.
   *
   * @param {Buffer|string} data
   * @param {Buffer} signature
   * @param {Buffer} publicKey - DER-encoded public key
   * @returns {boolean}
   */
  verify(data, signature, publicKey) {
    try {
      const pubKey = crypto.createPublicKey({
        key: Buffer.from(publicKey),
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(null, Buffer.from(data), pubKey, signature);
    } catch {
      return false;
    }
  }

  // ── Internal ──

  _publicIdentity(identity) {
    return {
      deviceId: identity.deviceId,
      fingerprint: identity.fingerprint,
      publicKey: identity.publicKey,
      name: identity.name,
      createdAt: identity.createdAt,
    };
  }

  _loadIdentity() {
    if (!this._identityPath) return;
    try {
      const raw = fs.readFileSync(this._identityPath, 'utf8');
      const data = JSON.parse(raw);
      if (data.deviceId && data.fingerprint && data.publicKey && data.privateKey) {
        this._localIdentity = {
          ...data,
          publicKey: Buffer.from(data.publicKey, 'hex'),
          privateKey: Buffer.from(data.privateKey, 'hex'),
        };
      }
    } catch {
      // No saved identity
    }
  }

  _saveIdentity() {
    if (!this._identityPath || !this._localIdentity) return;
    try {
      const dir = path.dirname(this._identityPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._identityPath, JSON.stringify({
        ...this._localIdentity,
        publicKey: Buffer.from(this._localIdentity.publicKey).toString('hex'),
        privateKey: Buffer.from(this._localIdentity.privateKey).toString('hex'),
      }, null, 2), 'utf8');
    } catch {
      // Save failure is non-fatal
    }
  }
}

// Singleton
let _instance = null;

function getInstance(opts) {
  if (!_instance) {
    _instance = new DevicePairingManager(opts);
  }
  return _instance;
}

module.exports = {
  ROLE,
  ROLE_HIERARCHY,
  SCOPE,
  ROLE_SCOPES,
  PAIRING_STATE,
  AsyncMutex,
  DevicePairingManager,
  getInstance,
};
