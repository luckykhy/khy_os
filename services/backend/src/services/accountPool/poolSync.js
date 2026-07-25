/**
 * poolSync.js — Synchronize active account credentials to local IDE storage.
 *
 * Provides write-back of active pool credentials into local IDE/CLI storage
 * files (Trae, Windsurf, Cursor, Kiro, Warp) so the local IDE recognizes the
 * pool-selected account. Also exposes watchable-path enumeration for the
 * credential watcher service.
 *
 * @module services/accountPool/poolSync
 */
'use strict';

const fs = require('fs');
const path = require('path');

const {
  normalizePoolType,
  safeJsonParse,
  formatIso,
} = require('./credentialHelpers');

const {
  CURSOR_STORAGE_PATHS,
  CURSOR_DB_PATHS,
  WARP_STORAGE_PATHS,
  NIRVANA_STORAGE_PATHS,
  _getKiroTokenCandidatePaths,
} = require('./candidateDetect');

// ── Exports (factory) ──

/**
 * Create a sync module bound to pool state.
 * @param {object} deps
 * @param {function} deps.ensureReady
 * @param {function} deps.getActiveAccount
 * @param {Array} deps.WINDSURF_STORAGE_PATHS
 * @param {Array} deps.TRAE_STORAGE_PATHS
 */
module.exports = function createSync(deps) {
  const {
    ensureReady,
    getActiveAccount,
    WINDSURF_STORAGE_PATHS,
    TRAE_STORAGE_PATHS,
  } = deps;

  // ── Internal Helpers ──

  function _providerStoragePaths(poolType) {
    const norm = normalizePoolType(poolType);
    if (norm === 'trae') return [...NIRVANA_STORAGE_PATHS, ...TRAE_STORAGE_PATHS];
    if (norm === 'windsurf') return WINDSURF_STORAGE_PATHS.slice();
    if (norm === 'cursor') return CURSOR_STORAGE_PATHS.slice();
    if (norm === 'kiro') return _getKiroTokenCandidatePaths();
    if (norm === 'warp') return WARP_STORAGE_PATHS.slice();
    return [];
  }

  function _loadJsonIfExists(filePath) {
    try {
      if (!fs.existsSync(filePath)) return {};
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = safeJsonParse(raw, {});
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function _writeJson(filePath, payload) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  function _resolveSyncPaths(poolType, options = {}) {
    const candidates = _providerStoragePaths(poolType);
    const requestedPath = String(options.targetPath || '').trim();
    if (requestedPath) return [requestedPath];

    const existing = candidates.filter(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (existing.length > 0) return existing;
    return candidates.length > 0 ? [candidates[0]] : [];
  }

  function _applyTraeLikeStorageShape(data = {}, account = {}) {
    const now = new Date().toISOString();
    const next = { ...(data || {}) };
    const token = account.accessToken ? String(account.accessToken) : '';
    const refreshToken = account.refreshToken ? String(account.refreshToken) : '';
    const email = account.email ? String(account.email) : '';
    const expiresAt = account.expiresAt || account.authData?.expiresAt || null;
    const refreshExpireAt = account.authData?.refreshExpireAt || expiresAt || null;
    const host = account.authData?.host || null;
    const userJwt = account.authData?.userJwt || null;
    const userInfo = account.authData?.userInfo || null;
    const callback = account.authData?.callback && typeof account.authData.callback === 'object'
      ? account.authData.callback
      : null;

    next.traeAuth = {
      ...(next.traeAuth && typeof next.traeAuth === 'object' ? next.traeAuth : {}),
      ...(token ? { accessToken: token } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(email ? { email } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(host ? { host } : {}),
      ...(userJwt ? { userJwt } : {}),
      ...(userInfo ? { userInfo } : {}),
      source: 'khy-pool',
      updatedAt: now,
    };
    if (token) next['traeAuth/accessToken'] = token;
    if (refreshToken) next['traeAuth/refreshToken'] = refreshToken;
    if (email) next['traeAuth/email'] = email;
    if (expiresAt) next['traeAuth/expiresAt'] = expiresAt;

    next.nirvanaAuth = {
      ...(next.nirvanaAuth && typeof next.nirvanaAuth === 'object' ? next.nirvanaAuth : {}),
      ...(token ? { accessToken: token } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(email ? { email } : {}),
      ...(refreshExpireAt ? { refreshExpireAt } : {}),
      ...(host ? { host } : {}),
      ...(userJwt ? { userJwt } : {}),
      ...(userInfo ? { userInfo } : {}),
      ...(callback ? { callback } : {}),
      source: 'khy-pool',
      updatedAt: now,
    };
    if (token) next['nirvanaAuth/accessToken'] = token;
    if (refreshToken) next['nirvanaAuth/refreshToken'] = refreshToken;
    if (email) next['nirvanaAuth/email'] = email;
    if (refreshExpireAt) next['nirvanaAuth/refreshExpireAt'] = refreshExpireAt;
    if (host) next['nirvanaAuth/host'] = host;
    if (userJwt) next['nirvanaAuth/userJwt'] = userJwt;

    return next;
  }

  function _applyWindsurfStorageShape(data = {}, account = {}) {
    const now = new Date().toISOString();
    const next = { ...(data || {}) };
    const token = account.accessToken ? String(account.accessToken) : '';
    const refreshToken = account.refreshToken ? String(account.refreshToken) : '';
    const email = account.email ? String(account.email) : '';
    const expiresAt = account.expiresAt || account.authData?.expiresAt || null;

    next.windsurfAuth = {
      ...(next.windsurfAuth && typeof next.windsurfAuth === 'object' ? next.windsurfAuth : {}),
      ...(token ? { accessToken: token } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(email ? { email } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      source: 'khy-pool',
      updatedAt: now,
    };
    if (token) next['windsurfAuth/accessToken'] = token;
    if (refreshToken) next['windsurfAuth/refreshToken'] = refreshToken;
    if (email) next['windsurfAuth/email'] = email;
    if (expiresAt) next['windsurfAuth/expiresAt'] = expiresAt;
    return next;
  }

  function _applyCursorStorageShape(data = {}, account = {}) {
    const now = new Date().toISOString();
    const next = { ...(data || {}) };
    const token = account.accessToken ? String(account.accessToken) : '';
    const email = account.email ? String(account.email) : '';
    const expiresAt = account.expiresAt || account.authData?.expiresAt || null;

    next.cursorAuth = {
      ...(next.cursorAuth && typeof next.cursorAuth === 'object' ? next.cursorAuth : {}),
      ...(token ? { accessToken: token } : {}),
      ...(email ? { email } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      source: 'khy-pool',
      updatedAt: now,
    };
    if (token) next['cursorAuth/accessToken'] = token;
    if (email) next['cursorAuth/email'] = email;
    if (expiresAt) next['cursorAuth/expiresAt'] = expiresAt;
    return next;
  }

  function _applyWarpStorageShape(data = {}, account = {}) {
    const now = new Date().toISOString();
    const next = { ...(data || {}) };
    const token = account.accessToken ? String(account.accessToken) : '';
    const email = account.email ? String(account.email) : '';
    const endpoint = account.authData?.endpoint || null;
    const expiresAt = account.expiresAt || account.authData?.expiresAt || null;

    next.warpAuth = {
      ...(next.warpAuth && typeof next.warpAuth === 'object' ? next.warpAuth : {}),
      ...(token ? { accessToken: token } : {}),
      ...(email ? { email } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      source: 'khy-pool',
      updatedAt: now,
    };
    if (token) next['warpAuth/accessToken'] = token;
    if (email) next['warpAuth/email'] = email;
    if (endpoint) next.endpoint = endpoint;
    if (expiresAt) next['warpAuth/expiresAt'] = expiresAt;
    return next;
  }

  // ── Public API ──

  async function syncActiveAccountToLocal(provider, options = {}) {
    await ensureReady();
    const norm = normalizePoolType(provider);
    if (!norm) throw new Error('provider is required');

    const active = await getActiveAccount(norm);
    if (!active) {
      return { provider: norm, attempted: 0, updated: 0, reason: 'no_active_account', paths: [] };
    }

    const paths = _resolveSyncPaths(norm, options);
    if (paths.length === 0) {
      return { provider: norm, attempted: 0, updated: 0, reason: 'no_storage_path', paths: [] };
    }

    let updated = 0;
    const writtenPaths = [];
    const errors = [];

    for (const p of paths) {
      try {
        if (norm === 'kiro') {
          const payload = {
            accessToken: active.accessToken || '',
            refreshToken: active.refreshToken || '',
            email: active.email || '',
            expiresAt: active.expiresAt || null,
            provider: active.authData?.provider || 'kiro',
            authMethod: active.authData?.authMethod || 'pool',
            updatedAt: new Date().toISOString(),
          };
          _writeJson(p, payload);
          updated += 1;
          writtenPaths.push(p);
          continue;
        }

        let data = _loadJsonIfExists(p);
        if (norm === 'trae') data = _applyTraeLikeStorageShape(data, active);
        else if (norm === 'windsurf') data = _applyWindsurfStorageShape(data, active);
        else if (norm === 'cursor') data = _applyCursorStorageShape(data, active);
        else if (norm === 'warp') data = _applyWarpStorageShape(data, active);
        else continue;

        _writeJson(p, data);
        updated += 1;
        writtenPaths.push(p);
      } catch (err) {
        errors.push({ path: p, error: err?.message || String(err) });
      }
    }

    return {
      provider: norm,
      attempted: paths.length,
      updated,
      paths: writtenPaths,
      errors,
    };
  }

  /**
   * Return all watchable credential file paths for a provider (or all providers).
   * Used by credentialWatcherService to set up fs.watch watchers.
   * @param {string} [provider] - 'cursor'|'windsurf'|'trae'|'kiro' or omit for all
   * @returns {Array<{provider: string, path: string, type: 'json'|'vscdb'}>}
   */
  function getWatchablePaths(provider) {
    const result = [];
    const providers = provider
      ? [normalizePoolType(provider)]
      : ['cursor', 'windsurf', 'trae', 'kiro'];

    for (const p of providers) {
      if (p === 'cursor') {
        for (const fp of CURSOR_STORAGE_PATHS) result.push({ provider: p, path: fp, type: 'json' });
        for (const fp of CURSOR_DB_PATHS) result.push({ provider: p, path: fp, type: 'vscdb' });
      } else if (p === 'windsurf') {
        for (const fp of WINDSURF_STORAGE_PATHS) result.push({ provider: p, path: fp, type: 'json' });
      } else if (p === 'trae') {
        for (const fp of TRAE_STORAGE_PATHS) result.push({ provider: p, path: fp, type: 'json' });
      } else if (p === 'kiro') {
        for (const fp of _getKiroTokenCandidatePaths()) result.push({ provider: p, path: fp, type: 'json' });
      }
    }
    return result;
  }

  return { syncActiveAccountToLocal, getWatchablePaths };
};
