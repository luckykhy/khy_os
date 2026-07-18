'use strict';

/**
 * MCP OAuth Token Store — multi-backend token storage for MCP server authentication.
 *
 * Supports multiple storage backends:
 *   - file: JSON file with restricted permissions (~/.khyquant/mcp_oauth_tokens.json)
 *   - memory: In-memory only (lost on restart)
 *   - keychain: System keychain via `secret-tool` (Linux) or `security` (macOS)
 *
 * Each MCP server can require OAuth authentication. This store manages:
 *   - Access tokens and refresh tokens per server
 *   - Token expiry tracking and auto-refresh
 *   - OAuth 2.0 Authorization Code + PKCE flow
 *   - Device Code flow for headless environments
 *
 * @module mcpOAuthTokenStore
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const log = require('../../utils/logger');

// ── Constants ──

const TOKEN_FILE = path.join(os.homedir(), '.khyquant', 'mcp_oauth_tokens.json');
const KEYCHAIN_SERVICE = 'khy-mcp-oauth';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry
const DEFAULT_BACKEND = 'file';

// ── Token Store Class ──

class McpOAuthTokenStore {
  /**
   * @param {object} [options]
   * @param {string} [options.backend] - 'file' | 'memory' | 'keychain'
   * @param {string} [options.filePath] - Custom file path for 'file' backend
   */
  constructor(options) {
    const opts = options || {};
    this._backend = opts.backend || DEFAULT_BACKEND;
    this._filePath = opts.filePath || TOKEN_FILE;
    this._memoryStore = new Map();
    this._refreshTimers = new Map();
  }

  /**
   * Store a token set for an MCP server.
   * @param {string} serverId - MCP server identifier
   * @param {object} tokenSet
   * @param {string} tokenSet.accessToken
   * @param {string} [tokenSet.refreshToken]
   * @param {number} [tokenSet.expiresAt] - Unix timestamp (ms)
   * @param {string} [tokenSet.tokenType] - Usually 'Bearer'
   * @param {string} [tokenSet.scope]
   * @param {object} [tokenSet.oauthConfig] - Provider config for refresh
   */
  async store(serverId, tokenSet) {
    const entry = {
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken || null,
      expiresAt: tokenSet.expiresAt || null,
      tokenType: tokenSet.tokenType || 'Bearer',
      scope: tokenSet.scope || null,
      oauthConfig: tokenSet.oauthConfig || null,
      storedAt: Date.now(),
    };

    switch (this._backend) {
      case 'keychain':
        await this._keychainStore(serverId, entry);
        break;
      case 'memory':
        this._memoryStore.set(serverId, entry);
        break;
      case 'file':
      default:
        this._fileStore(serverId, entry);
        break;
    }

    // Schedule refresh if we have expiry + refresh token
    if (entry.expiresAt && entry.refreshToken) {
      this._scheduleRefresh(serverId, entry);
    }
  }

  /**
   * Get a valid access token for an MCP server.
   * Auto-refreshes if expired.
   * @param {string} serverId
   * @returns {Promise<string|null>} Access token or null
   */
  async getToken(serverId) {
    const entry = await this._load(serverId);
    if (!entry) return null;

    // Check if expired
    if (entry.expiresAt && Date.now() >= entry.expiresAt - REFRESH_BUFFER_MS) {
      if (entry.refreshToken && entry.oauthConfig) {
        try {
          const refreshed = await this.refresh(serverId);
          return refreshed ? refreshed.accessToken : entry.accessToken;
        } catch (err) {
          log.debug(`MCP OAuth refresh failed for ${serverId}:`, err.message);
          return entry.accessToken; // Return stale token, let caller handle 401
        }
      }
    }

    return entry.accessToken;
  }

  /**
   * Get full token entry for an MCP server.
   * @param {string} serverId
   * @returns {Promise<object|null>}
   */
  async getEntry(serverId) {
    return this._load(serverId);
  }

  /**
   * Refresh the access token for an MCP server.
   * @param {string} serverId
   * @returns {Promise<object|null>} Updated token set
   */
  async refresh(serverId) {
    const entry = await this._load(serverId);
    if (!entry || !entry.refreshToken || !entry.oauthConfig) return null;

    const config = entry.oauthConfig;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: entry.refreshToken,
      client_id: config.clientId,
    });
    if (config.clientSecret) body.set('client_secret', config.clientSecret);

    const tokenData = await _httpPost(config.tokenEndpoint, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    if (!tokenData.access_token) {
      throw new Error('No access_token in refresh response');
    }

    const updated = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || entry.refreshToken,
      expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : entry.expiresAt,
      tokenType: tokenData.token_type || entry.tokenType,
      scope: tokenData.scope || entry.scope,
      oauthConfig: config,
    };

    await this.store(serverId, updated);
    log.info(`MCP OAuth token refreshed for ${serverId}`);
    return updated;
  }

  /**
   * Revoke and remove tokens for an MCP server.
   * @param {string} serverId
   */
  async revoke(serverId) {
    const entry = await this._load(serverId);

    // Best-effort revoke at provider
    if (entry && entry.oauthConfig && entry.oauthConfig.revokeEndpoint) {
      try {
        await _httpPost(entry.oauthConfig.revokeEndpoint,
          new URLSearchParams({ token: entry.accessToken }).toString(),
          { 'Content-Type': 'application/x-www-form-urlencoded' });
      } catch { /* best effort */ }
    }

    // Clear local
    this._clearRefreshTimer(serverId);

    switch (this._backend) {
      case 'keychain':
        this._keychainDelete(serverId);
        break;
      case 'memory':
        this._memoryStore.delete(serverId);
        break;
      case 'file':
      default:
        this._fileDelete(serverId);
        break;
    }
  }

  /**
   * List all stored server IDs.
   * @returns {Promise<string[]>}
   */
  async listServers() {
    switch (this._backend) {
      case 'memory':
        return [...this._memoryStore.keys()];
      case 'keychain':
        return this._keychainList();
      case 'file':
      default:
        return Object.keys(this._fileLoadAll());
    }
  }

  /**
   * Get status for all servers.
   * @returns {Promise<Array<{serverId, hasToken, expired, expiresAt}>>}
   */
  async getStatus() {
    const servers = await this.listServers();
    const result = [];

    for (const id of servers) {
      const entry = await this._load(id);
      if (!entry) continue;

      result.push({
        serverId: id,
        hasToken: !!entry.accessToken,
        hasRefreshToken: !!entry.refreshToken,
        expired: entry.expiresAt ? Date.now() >= entry.expiresAt : false,
        expiresAt: entry.expiresAt || null,
        tokenType: entry.tokenType,
      });
    }

    return result;
  }

  /**
   * Cleanup — clear all refresh timers.
   */
  destroy() {
    for (const timer of this._refreshTimers.values()) {
      clearTimeout(timer);
    }
    this._refreshTimers.clear();
  }

  // ── OAuth Flows ──

  /**
   * Start OAuth 2.0 Authorization Code + PKCE flow.
   * Returns the authorization URL for the user to visit.
   *
   * @param {string} serverId
   * @param {object} config
   * @param {string} config.authorizationEndpoint
   * @param {string} config.tokenEndpoint
   * @param {string} config.clientId
   * @param {string} [config.clientSecret]
   * @param {string} config.redirectUri
   * @param {string} [config.scope]
   * @returns {{authUrl: string, state: string, codeVerifier: string}}
   */
  startAuthCodeFlow(serverId, config) {
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    if (config.scope) params.set('scope', config.scope);

    const authUrl = `${config.authorizationEndpoint}?${params}`;

    return { authUrl, state, codeVerifier };
  }

  /**
   * Complete the Authorization Code flow by exchanging the code.
   * @param {string} serverId
   * @param {object} config - Same config as startAuthCodeFlow
   * @param {string} code - Authorization code from callback
   * @param {string} codeVerifier - PKCE code verifier
   * @returns {Promise<object>} Token set
   */
  async completeAuthCodeFlow(serverId, config, code, codeVerifier) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: codeVerifier,
    });
    if (config.clientSecret) body.set('client_secret', config.clientSecret);

    const tokenData = await _httpPost(config.tokenEndpoint, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    const tokenSet = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
      tokenType: tokenData.token_type || 'Bearer',
      scope: tokenData.scope || config.scope,
      oauthConfig: {
        tokenEndpoint: config.tokenEndpoint,
        clientId: config.clientId,
        clientSecret: config.clientSecret || null,
        revokeEndpoint: config.revokeEndpoint || null,
      },
    };

    await this.store(serverId, tokenSet);
    return tokenSet;
  }

  /**
   * Start Device Code flow for headless environments.
   * @param {string} serverId
   * @param {object} config
   * @param {string} config.deviceAuthorizationEndpoint
   * @param {string} config.tokenEndpoint
   * @param {string} config.clientId
   * @param {string} [config.scope]
   * @returns {Promise<{userCode, verificationUri, deviceCode, interval, expiresIn}>}
   */
  async startDeviceCodeFlow(serverId, config) {
    const body = new URLSearchParams({ client_id: config.clientId });
    if (config.scope) body.set('scope', config.scope);

    const data = await _httpPost(config.deviceAuthorizationEndpoint, body.toString(), {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    return {
      userCode: data.user_code,
      verificationUri: data.verification_uri || data.verification_url,
      deviceCode: data.device_code,
      interval: data.interval || 5,
      expiresIn: data.expires_in || 900,
    };
  }

  /**
   * Poll for device code completion.
   * @param {string} serverId
   * @param {object} config
   * @param {string} deviceCode
   * @param {number} [interval] - Polling interval in seconds
   * @param {number} [timeout] - Max wait in ms
   * @returns {Promise<object>} Token set
   */
  async pollDeviceCode(serverId, config, deviceCode, interval, timeout) {
    const pollInterval = (interval || 5) * 1000;
    const maxTime = timeout || 900_000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxTime) {
      await _sleep(pollInterval);

      try {
        const body = new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: config.clientId,
        });

        const tokenData = await _httpPost(config.tokenEndpoint, body.toString(), {
          'Content-Type': 'application/x-www-form-urlencoded',
        });

        if (tokenData.access_token) {
          const tokenSet = {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token || null,
            expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : null,
            tokenType: tokenData.token_type || 'Bearer',
            scope: tokenData.scope || config.scope,
            oauthConfig: {
              tokenEndpoint: config.tokenEndpoint,
              clientId: config.clientId,
              revokeEndpoint: config.revokeEndpoint || null,
            },
          };

          await this.store(serverId, tokenSet);
          return tokenSet;
        }
      } catch (err) {
        // authorization_pending is expected, keep polling
        if (err.message && err.message.includes('authorization_pending')) continue;
        if (err.message && err.message.includes('slow_down')) {
          await _sleep(pollInterval); // Extra wait
          continue;
        }
        throw err;
      }
    }

    throw new Error('Device code flow timed out');
  }

  // ── Backend: File ──

  _fileStore(serverId, entry) {
    const all = this._fileLoadAll();
    all[serverId] = entry;
    this._fileSaveAll(all);
  }

  _fileDelete(serverId) {
    const all = this._fileLoadAll();
    delete all[serverId];
    this._fileSaveAll(all);
  }

  _fileLoadAll() {
    try {
      if (fs.existsSync(this._filePath)) {
        return JSON.parse(fs.readFileSync(this._filePath, 'utf8'));
      }
    } catch { /* corrupt file */ }
    return {};
  }

  _fileSaveAll(data) {
    const dir = path.dirname(this._filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Q-004 (khy问题列表2): atomic write via tmp + fsync + rename. Previously a bare
    // writeFileSync on the token file — a crash mid-write would truncate/corrupt it,
    // and _fileLoadAll's catch below would silently treat the corrupted file as `{}`
    // dropping every stored OAuth token. Same-repo baseline: utils/dataHome.js _writePointer.
    // Mode 0o600 is silently ignored on Windows; tokens rely on user-profile ACLs there.
    const tmp = `${this._filePath}.tmp-${process.pid}`;
    const serialized = JSON.stringify(data, null, 2);
    try {
      fs.writeFileSync(tmp, serialized, { mode: 0o600 });
      // Best-effort fsync so data hits disk before rename (Linux ext4/XFS reorder protection).
      // Some fs / platforms silently no-op; swallow. Always close the fd to avoid leak.
      let fd;
      try {
        fd = fs.openSync(tmp, 'r+');
        fs.fsyncSync(fd);
      } catch { /* best-effort */ }
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best-effort */ }
      }
      fs.renameSync(tmp, this._filePath);
    } catch (err) {
      // Clean up orphaned tmp on rename failure; re-throw so caller observes the write failure
      // (unlike utils/dataHome.js _writePointer which swallow — token persistence must surface).
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw err;
    }
  }

  // ── Backend: Keychain ──

  async _keychainStore(serverId, entry) {
    const json = JSON.stringify(entry);
    const platform = os.platform();

    try {
      if (platform === 'darwin') {
        execSync(`security add-generic-password -a "${serverId}" -s "${KEYCHAIN_SERVICE}" -w "${json.replace(/"/g, '\\"')}" -U`, { stdio: 'pipe' });
      } else if (platform === 'linux') {
        execSync(`echo "${json.replace(/"/g, '\\"')}" | secret-tool store --label="${KEYCHAIN_SERVICE}: ${serverId}" service "${KEYCHAIN_SERVICE}" account "${serverId}"`, { stdio: 'pipe' });
      } else {
        // Fallback to file on unsupported platforms
        this._fileStore(serverId, entry);
      }
    } catch {
      // Fallback to file
      log.debug(`Keychain store failed for ${serverId}, falling back to file`);
      this._fileStore(serverId, entry);
    }
  }

  _keychainDelete(serverId) {
    const platform = os.platform();
    try {
      if (platform === 'darwin') {
        execSync(`security delete-generic-password -a "${serverId}" -s "${KEYCHAIN_SERVICE}"`, { stdio: 'pipe' });
      } else if (platform === 'linux') {
        execSync(`secret-tool clear service "${KEYCHAIN_SERVICE}" account "${serverId}"`, { stdio: 'pipe' });
      }
    } catch { /* not found, ignore */ }
  }

  _keychainList() {
    // Best-effort list — falls back to file listing
    return Object.keys(this._fileLoadAll());
  }

  // ── Backend: Generic load ──

  async _load(serverId) {
    switch (this._backend) {
      case 'memory':
        return this._memoryStore.get(serverId) || null;
      case 'keychain': {
        const platform = os.platform();
        try {
          let json;
          if (platform === 'darwin') {
            json = execSync(`security find-generic-password -a "${serverId}" -s "${KEYCHAIN_SERVICE}" -w`, { stdio: 'pipe' }).toString().trim();
          } else if (platform === 'linux') {
            json = execSync(`secret-tool lookup service "${KEYCHAIN_SERVICE}" account "${serverId}"`, { stdio: 'pipe' }).toString().trim();
          }
          return json ? JSON.parse(json) : null;
        } catch {
          // Fallback to file
          const all = this._fileLoadAll();
          return all[serverId] || null;
        }
      }
      case 'file':
      default: {
        const all = this._fileLoadAll();
        return all[serverId] || null;
      }
    }
  }

  // ── Refresh scheduling ──

  _scheduleRefresh(serverId, entry) {
    this._clearRefreshTimer(serverId);

    if (!entry.expiresAt || !entry.refreshToken) return;

    const delay = Math.max(0, entry.expiresAt - Date.now() - REFRESH_BUFFER_MS);
    const maxDelay = 24 * 60 * 60 * 1000; // Cap at 24h
    const actualDelay = Math.min(delay, maxDelay);

    const timer = setTimeout(async () => {
      try {
        await this.refresh(serverId);
      } catch (err) {
        log.debug(`Scheduled MCP OAuth refresh failed for ${serverId}:`, err.message);
      }
    }, actualDelay);

    timer.unref();
    this._refreshTimers.set(serverId, timer);
  }

  _clearRefreshTimer(serverId) {
    const timer = this._refreshTimers.get(serverId);
    if (timer) {
      clearTimeout(timer);
      this._refreshTimers.delete(serverId);
    }
  }
}

// ── HTTP Helper ──

function _httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const parsed = new URL(url);

    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 15_000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error_description || json.error));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error(`Invalid response from ${url}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OAuth request timed out')); });
    req.write(body);
    req.end();
  });
}

const _sleep = require('../../utils/sleep'); // single-source sleep ([MGMT-RPT-020] REQ-2026-010)

// ── Singleton ──

let _defaultStore = null;

/**
 * Get the default token store instance.
 * @param {object} [options]
 * @returns {McpOAuthTokenStore}
 */
function getTokenStore(options) {
  if (!_defaultStore) {
    _defaultStore = new McpOAuthTokenStore(options);
  }
  return _defaultStore;
}

module.exports = {
  McpOAuthTokenStore,
  getTokenStore,
};
