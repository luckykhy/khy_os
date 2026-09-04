/**
 * poolImporter.js — Import credentials from local IDE/CLI storage into the pool.
 *
 * Scans local IDE login storage (Windsurf, Trae, Cursor, Kiro, Warp, Nirvana)
 * and imports discovered credentials into the account pool database via upsert.
 * Also handles observed auto-import with cooldown/deduplication.
 *
 * @module services/accountPool/poolImporter
 */
'use strict';

const fs = require('fs');
const path = require('path');

const {
  CURSOR_STORAGE_PATHS,
  CURSOR_DB_PATHS,
  WARP_STORAGE_PATHS,
  NIRVANA_STORAGE_PATHS,
  NIRVANA_TRAE_CACHE_PATHS,
  NIRVANA_PRESET_LOGIN_EMAIL,
  _getKiroTokenCandidatePaths,
  resolveObservedAutoImportSourcePath,
  resolveObservedAutoImportCooldownMs,
  resolveArchiveImportRoot,
  cleanupArchiveExtractDirs,
  resolveNirvanaDefaultRoots,
  normalizeNirvanaProviderHint,
  walkCandidateFiles,
  readCursorTokenFromVscdb,
  collectNirvanaCandidatesFromRecord,
  collectGenericCandidateFromRecord,
  importGenericCandidatesFromPath,
} = require('./candidateDetect');
const {
  normalizePoolType,
  safeJsonParse,
  tokenHash,
  formatIso,
  normalizeTokenValue,
  _isPlaceholderEmail,
  isValidEmail,
  hasTokenShape,
  hasLooseTokenShape,
  firstNonEmpty,
  parseBoolean,
  dedupePaths,
} = require('./credentialHelpers');

// ── Exports (factory) ──

/**
 * Create an importer bound to pool core operations.
 * @param {object} deps
 * @param {function} deps.ensureReady
 * @param {function} deps.upsertTokenRecord
 * @param {function} deps.getActiveAccount
 * @param {function} deps.setActiveAccount
 * @param {Map} deps._observedAutoImportState
 * @param {Array} deps.WINDSURF_STORAGE_PATHS
 * @param {Array} deps.TRAE_STORAGE_PATHS
 */
module.exports = function createImporter(deps) {
  const {
    ensureReady,
    upsertTokenRecord,
    getActiveAccount,
    setActiveAccount,
    _observedAutoImportState,
    WINDSURF_STORAGE_PATHS,
    TRAE_STORAGE_PATHS,
  } = deps;

  // ── Internal Helpers ──

  function loadStorageSnapshots(paths) {
    const out = [];
    for (const p of paths) {
      try {
        if (!fs.existsSync(p)) {
          continue;
        }
        const raw = fs.readFileSync(p, 'utf8');
        const json = JSON.parse(raw);
        out.push({ path: p, data: json || {} });
      } catch {
        /* ignore malformed files */
      }
    }
    return out;
  }

  /**
   * 读取 Nirvana trae_local_cache.json 中的账号 (含 session_cookies)
   */
  function loadNirvanaCacheAccounts() {
    const now = Date.now();
    const results = [];
    for (const cachePath of NIRVANA_TRAE_CACHE_PATHS) {
      try {
        if (!fs.existsSync(cachePath)) {
          continue;
        }
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (!raw || typeof raw !== 'object') {
          continue;
        }
        for (const [email, acc] of Object.entries(raw)) {
          if (!acc || typeof acc !== 'object') {
            continue;
          }
          if (!acc.access_token && !acc.session_cookies) {
            continue;
          }
          const cookiesExpireTs = acc.cookies_expire_at
            ? new Date(acc.cookies_expire_at).getTime()
            : 0;
          if (acc.cookies_expire_at && Number.isFinite(cookiesExpireTs) && cookiesExpireTs < now) {
            continue;
          }
          results.push({
            email: acc.email || email,
            accessToken: String(acc.access_token || '').trim(),
            sessionCookies: acc.session_cookies || null,
            cookiesExpireAt: acc.cookies_expire_at || null,
            tokenExpireAt: acc.token_expire_at || null,
            apiBase: acc.api_base || null,
            sourcePath: cachePath,
          });
        }
      } catch {
        /* ignore malformed cache files */
      }
    }
    return results;
  }

  function importWindsurfCandidates() {
    const snapshots = loadStorageSnapshots(WINDSURF_STORAGE_PATHS);
    const found = [];
    const seenHash = new Set();

    for (const snap of snapshots) {
      const data = snap.data || {};
      const accessToken =
        data.windsurfAuth?.accessToken ||
        data['windsurfAuth/accessToken'] ||
        data['windsurf.auth']?.accessToken ||
        data['windsurf.auth.accessToken'] ||
        data['codeium/accessToken'] ||
        data['codeium.auth']?.accessToken ||
        data['codeium.auth.accessToken'] ||
        data.accessToken;
      if (!accessToken) {
        continue;
      }

      const hash = tokenHash(accessToken);
      if (hash && seenHash.has(hash)) {
        continue;
      }
      if (hash) {
        seenHash.add(hash);
      }

      const email =
        data.windsurfAuth?.email ||
        data['windsurf.auth']?.email ||
        data['codeium.auth']?.email ||
        '';

      const expiresAt =
        data.windsurfAuth?.expiresAt ||
        data['windsurfAuth/expiresAt'] ||
        data['windsurf.auth']?.expiresAt ||
        data['codeium.auth']?.expiresAt ||
        null;

      const refreshToken =
        data.windsurfAuth?.refreshToken ||
        data['windsurfAuth/refreshToken'] ||
        data['windsurf.auth']?.refreshToken ||
        data['codeium.auth']?.refreshToken ||
        null;

      const sourceName = path.basename(path.dirname(path.dirname(path.dirname(snap.path))));
      const cleanEmail = email && !_isPlaceholderEmail(email) ? email : null;
      found.push({
        email: cleanEmail,
        label: cleanEmail ? `windsurf:${cleanEmail}` : `windsurf:${sourceName}`,
        accessToken: String(accessToken).trim(),
        refreshToken: refreshToken ? String(refreshToken).trim() : null,
        sourcePath: snap.path,
        authData: {
          source: sourceName,
          path: snap.path,
          expiresAt: formatIso(expiresAt),
        },
        accountType: 'LOGIN',
        priority: 10,
      });
    }

    return found;
  }

  function importTraeCandidates() {
    const snapshots = loadStorageSnapshots([...TRAE_STORAGE_PATHS, ...NIRVANA_STORAGE_PATHS]);
    const found = [];
    const seenHash = new Set();

    for (const snap of snapshots) {
      const data = snap.data || {};
      const accessToken =
        data.traeAuth?.accessToken ||
        data['traeAuth/accessToken'] ||
        data['trae.auth']?.accessToken ||
        data['bytedance.auth']?.accessToken ||
        data.accessToken;
      if (!accessToken) {
        continue;
      }

      const hash = tokenHash(accessToken);
      if (hash && seenHash.has(hash)) {
        continue;
      }
      if (hash) {
        seenHash.add(hash);
      }

      const email =
        data.traeAuth?.email || data['trae.auth']?.email || data['bytedance.auth']?.email || '';

      const expiresAt =
        data.traeAuth?.expiresAt ||
        data['traeAuth/expiresAt'] ||
        data['trae.auth']?.expiresAt ||
        data['bytedance.auth']?.expiresAt ||
        null;

      const refreshToken =
        data.traeAuth?.refreshToken ||
        data['traeAuth/refreshToken'] ||
        data['trae.auth']?.refreshToken ||
        data['bytedance.auth']?.refreshToken ||
        null;

      // Reject placeholder / fake credentials
      if (!hasTokenShape(accessToken) && !hasLooseTokenShape(accessToken)) {
        continue;
      }
      if (email && _isPlaceholderEmail(email)) {
        // Token exists but email is fake — clear the email, use source name instead
        // eslint-disable-next-line no-param-reassign
      }

      const sourceName = path.basename(path.dirname(path.dirname(path.dirname(snap.path))));
      const cleanEmail = email && !_isPlaceholderEmail(email) ? email : null;
      found.push({
        email: cleanEmail,
        label: cleanEmail ? `trae:${cleanEmail}` : `trae:${sourceName}`,
        accessToken: String(accessToken).trim(),
        refreshToken: refreshToken ? String(refreshToken).trim() : null,
        sourcePath: snap.path,
        authData: {
          source: sourceName,
          path: snap.path,
          expiresAt: formatIso(expiresAt),
        },
        accountType: 'LOGIN',
        priority: 10,
      });
    }

    // 追加 Nirvana trae_local_cache.json 中的账号 (含 session_cookies, 60天有效)
    const cacheAccounts = loadNirvanaCacheAccounts();
    for (const acc of cacheAccounts) {
      if (!acc.accessToken) {
        continue;
      }
      const hash = tokenHash(acc.accessToken);
      if (hash && seenHash.has(hash)) {
        continue;
      }
      if (hash) {
        seenHash.add(hash);
      }
      if (!hasTokenShape(acc.accessToken) && !hasLooseTokenShape(acc.accessToken)) {
        continue;
      }

      const cleanEmail = acc.email && !_isPlaceholderEmail(acc.email) ? acc.email : null;
      found.push({
        email: cleanEmail,
        label: cleanEmail ? `trae:${cleanEmail}` : 'trae:nirvana-cache',
        accessToken: acc.accessToken,
        refreshToken: null,
        sourcePath: acc.sourcePath,
        authData: {
          source: 'nirvana-cache',
          path: acc.sourcePath,
          expiresAt: formatIso(acc.tokenExpireAt),
          sessionCookies: acc.sessionCookies,
          cookiesExpireAt: formatIso(acc.cookiesExpireAt),
          apiBase: acc.apiBase,
        },
        accountType: 'LOGIN',
        priority: 15,
      });
    }

    return found;
  }

  function importWarpCandidates() {
    const snapshots = loadStorageSnapshots(WARP_STORAGE_PATHS);
    const found = [];
    const seenHash = new Set();

    for (const snap of snapshots) {
      const data = snap.data || {};
      const accessToken = firstNonEmpty([
        data.warpAuth?.accessToken,
        data['warpAuth/accessToken'],
        data['warp.auth']?.accessToken,
        data['warp.auth.accessToken'],
        data.apiKey,
        data.api_key,
        data.authToken,
        data.accessToken,
        data.token,
      ]);
      if (!hasTokenShape(accessToken) && !hasLooseTokenShape(accessToken)) {
        continue;
      }

      const token = normalizeTokenValue(accessToken);
      const hash = tokenHash(token);
      if (hash && seenHash.has(hash)) {
        continue;
      }
      if (hash) {
        seenHash.add(hash);
      }

      const email = firstNonEmpty([
        data.warpAuth?.email,
        data['warpAuth/email'],
        data['warp.auth']?.email,
        data.email,
        data.userEmail,
        data.username,
      ]);
      const endpoint = firstNonEmpty([
        data.endpoint,
        data.apiBase,
        data.baseUrl,
        data.baseURL,
        data.host,
        data.warpAuth?.endpoint,
      ]);
      const expiresAt = firstNonEmpty([
        data.warpAuth?.expiresAt,
        data['warpAuth/expiresAt'],
        data.expiresAt,
      ]);

      const sourceName = path.basename(path.dirname(path.dirname(path.dirname(snap.path))));
      found.push({
        email: email ? String(email).trim() : null,
        label: email ? `warp:${String(email).trim()}` : `warp:${sourceName}`,
        accessToken: token,
        refreshToken: null,
        sourcePath: snap.path,
        authData: {
          source: sourceName,
          path: snap.path,
          endpoint: endpoint || null,
          expiresAt: formatIso(expiresAt),
        },
        accountType: 'LOGIN',
        priority: 10,
      });
    }

    return found;
  }

  /**
   * Read-only Warp local-login probe (does NOT write to the pool).
   */
  function detectWarpLocalLogin() {
    let installed = false;
    try {
      const { findInstallation, findDataPath } = require('../../../gateway/adapters/ideDetector');
      installed = !!(findInstallation('warp') || findDataPath('warp'));
    } catch {
      installed = false;
    }

    let candidates = [];
    try {
      candidates = importWarpCandidates();
    } catch {
      candidates = [];
    }
    const hasLogin = candidates.length > 0;
    const email = hasLogin ? candidates[0].email || null : null;

    return { installed, hasLogin, email };
  }

  function importKiroCandidates() {
    const found = [];
    const seenHash = new Set();
    const candidatePaths = _getKiroTokenCandidatePaths();

    for (const tokenPath of candidatePaths) {
      try {
        if (!fs.existsSync(tokenPath)) {
          continue;
        }
        const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        if (!data || !data.accessToken) {
          continue;
        }

        const hash = tokenHash(data.accessToken);
        if (hash && seenHash.has(hash)) {
          continue;
        }
        if (hash) {
          seenHash.add(hash);
        }

        const email = data.email || data.username || data.userEmail || null;
        found.push({
          email,
          label: email ? `kiro:${email}` : `kiro:${data.authMethod || 'login'}`,
          accessToken: String(data.accessToken).trim(),
          refreshToken: data.refreshToken ? String(data.refreshToken).trim() : null,
          sourcePath: tokenPath,
          authData: {
            path: tokenPath,
            authMethod: data.authMethod || null,
            provider: data.provider || null,
            profileArn: data.profileArn || null,
            region: data.region || null,
            clientIdHash: data.clientIdHash || null,
            expiresAt: formatIso(data.expiresAt),
          },
          accountType: 'LOGIN',
          priority: 10,
        });
      } catch {
        /* ignore individual path errors */
      }
    }
    return found;
  }

  function importCursorCandidates() {
    const found = [];
    const seenHash = new Set();

    const addCandidate = (candidate) => {
      if (!candidate || !candidate.accessToken) {
        return;
      }
      const hash = tokenHash(candidate.accessToken);
      if (hash && seenHash.has(hash)) {
        return;
      }
      if (hash) {
        seenHash.add(hash);
      }
      found.push(candidate);
    };

    for (const dbPath of CURSOR_DB_PATHS) {
      try {
        if (!fs.existsSync(dbPath)) {
          continue;
        }
        const token = readCursorTokenFromVscdb(dbPath);
        if (!hasTokenShape(token)) {
          continue;
        }
        addCandidate({
          email: null,
          label: `cursor:${path.basename(path.dirname(path.dirname(path.dirname(dbPath))))}`,
          accessToken: normalizeTokenValue(token),
          refreshToken: null,
          sourcePath: dbPath,
          authData: {
            source: 'cursor',
            path: dbPath,
            tokenSource: 'state.vscdb',
          },
          accountType: 'LOGIN',
          priority: 10,
        });
      } catch {
        /* ignore */
      }
    }

    for (const p of CURSOR_STORAGE_PATHS) {
      try {
        if (!fs.existsSync(p)) {
          continue;
        }
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        const token =
          data.cursorAuth?.accessToken ||
          data['cursorAuth/accessToken'] ||
          data['cursorAuth.accessToken'] ||
          data.accessToken;
        if (!hasTokenShape(token)) {
          continue;
        }
        const email = firstNonEmpty([
          data.cursorAuth?.email,
          data['cursorAuth/email'],
          data['cursorAuth.email'],
        ]);
        const cleanEmail =
          email && !_isPlaceholderEmail(String(email).trim()) ? String(email).trim() : null;
        addCandidate({
          email: cleanEmail,
          label: cleanEmail
            ? `cursor:${cleanEmail}`
            : `cursor:${path.basename(path.dirname(path.dirname(path.dirname(p))))}`,
          accessToken: normalizeTokenValue(token),
          refreshToken: null,
          sourcePath: p,
          authData: {
            source: 'cursor',
            path: p,
            tokenSource: 'storage.json',
          },
          accountType: 'LOGIN',
          priority: 10,
        });
      } catch {
        /* ignore */
      }
    }

    return found;
  }

  function importNirvanaCandidates(options = {}) {
    const sourcePath = String(options.sourcePath || '').trim();
    const providerFilter = normalizeNirvanaProviderHint(options.provider || '');
    const defaultProvider =
      normalizeNirvanaProviderHint(options.defaultProvider || providerFilter || 'trae') || 'trae';
    const usePresetEmail = options.usePresetEmail !== false;
    const defaultEmail = String(options.defaultEmail || NIRVANA_PRESET_LOGIN_EMAIL || '').trim();
    const allowArchiveExtract = options.allowArchiveExtract !== false;
    const includeDefaultRoots = options.includeDefaultRoots !== false;
    const includeEnvRoot = options.includeEnvRoot !== false;
    const found = [];
    const seenTokenOrEmail = new Set();
    const addCandidate = (candidate) => {
      if (!candidate) {
        return;
      }
      if (
        !candidate.accessToken &&
        !candidate.refreshToken &&
        _isPlaceholderEmail(candidate.email)
      ) {
        return;
      }
      if (candidate.email && _isPlaceholderEmail(candidate.email)) {
        candidate.email = null;
        candidate.label = candidate.label ? candidate.label.replace(/:[^:]+$/, ':oauth') : null;
      }
      const provider =
        normalizeNirvanaProviderHint(candidate.provider || defaultProvider) || 'trae';
      candidate.provider = provider;
      const idByAccess = candidate.accessToken ? `a:${tokenHash(candidate.accessToken)}` : '';
      const idByRefresh = candidate.refreshToken ? `r:${tokenHash(candidate.refreshToken)}` : '';
      const idByEmail = candidate.email ? `e:${String(candidate.email).trim().toLowerCase()}` : '';
      const key = idByAccess || idByRefresh || idByEmail;
      if (!key) {
        return;
      }
      const providerKey = `${provider}:${key}`;
      if (seenTokenOrEmail.has(providerKey)) {
        return;
      }
      seenTokenOrEmail.add(providerKey);
      found.push(candidate);
    };

    const snapshots = loadStorageSnapshots([...NIRVANA_STORAGE_PATHS, ...TRAE_STORAGE_PATHS]);
    for (const snap of snapshots) {
      const fromTop = collectNirvanaCandidatesFromRecord(snap.data, snap.path, {
        provider: providerFilter,
        defaultProvider,
        usePresetEmail,
        defaultEmail,
      });
      if (fromTop) {
        addCandidate(fromTop);
      }

      const fromAuth = collectNirvanaCandidatesFromRecord(
        firstNonEmpty([
          snap.data?.nirvanaAuth,
          snap.data?.traeAuth,
          snap.data?.auth,
          snap.data?.oauth,
          snap.data?.callback,
        ]),
        snap.path,
        {
          provider: providerFilter,
          defaultProvider,
          usePresetEmail,
          defaultEmail,
        }
      );
      if (fromAuth) {
        addCandidate(fromAuth);
      }
    }

    const roots = [];
    const extractedRoots = new Set();
    try {
      const envRoot = includeEnvRoot ? String(process.env.NIRVANA_IMPORT_PATH || '').trim() : '';
      if (sourcePath) {
        roots.push(sourcePath);
        if (allowArchiveExtract) {
          const extracted = resolveArchiveImportRoot(sourcePath);
          if (extracted) {
            extractedRoots.add(extracted);
            roots.push(extracted);
          }
        }
      }
      if (envRoot) {
        roots.push(envRoot);
        if (allowArchiveExtract) {
          const extracted = resolveArchiveImportRoot(envRoot);
          if (extracted) {
            extractedRoots.add(extracted);
            roots.push(extracted);
          }
        }
      }
      if (includeDefaultRoots) {
        for (const defaultRoot of resolveNirvanaDefaultRoots()) {
          roots.push(defaultRoot);
          if (allowArchiveExtract) {
            const extracted = resolveArchiveImportRoot(defaultRoot);
            if (extracted) {
              extractedRoots.add(extracted);
              roots.push(extracted);
            }
          }
        }
      }

      for (const root of dedupePaths(roots)) {
        let stat;
        try {
          stat = fs.statSync(root);
        } catch {
          continue;
        }
        if (!allowArchiveExtract && stat.isFile()) {
          const ext = path.extname(root).toLowerCase();
          if (ext === '.zip' || ext === '.rar') {
            continue;
          }
        }

        const files = stat.isFile()
          ? [root]
          : walkCandidateFiles(root, { maxDepth: 7, maxFiles: 600 });
        for (const file of files) {
          let raw = '';
          try {
            raw = fs.readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          if (!raw.trim()) {
            continue;
          }

          const json = safeJsonParse(raw, null);
          if (Array.isArray(json)) {
            for (const row of json) {
              const c = collectNirvanaCandidatesFromRecord(row, file, {
                provider: providerFilter,
                defaultProvider,
                usePresetEmail,
                defaultEmail,
              });
              if (c) {
                addCandidate(c);
              }
            }
            continue;
          }
          if (json && typeof json === 'object') {
            const queue = [json];
            let seen = 0;
            while (queue.length > 0 && seen < 2000) {
              const node = queue.shift();
              seen += 1;
              if (!node || typeof node !== 'object') {
                continue;
              }
              const c = collectNirvanaCandidatesFromRecord(node, file, {
                provider: providerFilter,
                defaultProvider,
                usePresetEmail,
                defaultEmail,
              });
              if (c) {
                addCandidate(c);
              }
              for (const v of Object.values(node)) {
                if (v && typeof v === 'object') {
                  queue.push(v);
                }
              }
            }
            continue;
          }

          // JSONL / log lines.
          for (const line of raw.split('\n')) {
            const text = String(line || '').trim();
            if (!text) {
              continue;
            }
            if (text.startsWith('{') && text.endsWith('}')) {
              const obj = safeJsonParse(text, null);
              if (obj && typeof obj === 'object') {
                const c = collectNirvanaCandidatesFromRecord(obj, file, {
                  provider: providerFilter,
                  defaultProvider,
                  usePresetEmail,
                  defaultEmail,
                });
                if (c) {
                  addCandidate(c);
                }
                continue;
              }
            }

            // Callback URL / querystring logs
            if (text.includes('refreshToken=')) {
              const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
              try {
                const params = new URLSearchParams(query);
                const callbackObj = {};
                for (const [k, v] of params.entries()) {
                  if (!k) {
                    continue;
                  }
                  callbackObj[k] = v;
                }
                const c = collectNirvanaCandidatesFromRecord({ callback: callbackObj }, file, {
                  provider: providerFilter,
                  defaultProvider,
                  usePresetEmail,
                  defaultEmail,
                });
                if (c) {
                  addCandidate(c);
                }
              } catch {
                /* ignore malformed query */
              }
            }
          }
        }
      }

      return found;
    } finally {
      cleanupArchiveExtractDirs(extractedRoots);
    }
  }

  async function importProviderTokens(provider, options = {}) {
    await ensureReady();
    const requested = String(provider || '')
      .trim()
      .toLowerCase();
    const norm = normalizePoolType(requested);
    if (!norm) {
      throw new Error('provider is required');
    }
    const isNirvanaBrokerImport = requested === 'nirvana' || requested === 'antigravity';

    let candidates = [];
    if (isNirvanaBrokerImport) {
      candidates = importTraeCandidates();
    } else if (norm === 'windsurf') {
      candidates = importWindsurfCandidates();
    } else if (norm === 'kiro') {
      candidates = importKiroCandidates();
    } else if (norm === 'cursor') {
      candidates = importCursorCandidates();
    } else if (norm === 'warp') {
      candidates = importWarpCandidates();
    } else if (norm === 'trae') {
      candidates = importTraeCandidates();
    } else if (options.sourcePath) {
      candidates = importGenericCandidatesFromPath(norm, options.sourcePath);
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    const mergeCandidates = (...sets) => {
      const merged = [];
      const seen = new Set();
      const push = (candidate) => {
        if (!candidate) {
          return;
        }
        const providerKey =
          normalizeNirvanaProviderHint(candidate.provider || '') ||
          normalizePoolType(candidate.provider || norm) ||
          norm;
        const accessHash = candidate.accessToken ? tokenHash(candidate.accessToken) : '';
        const refreshHash = candidate.refreshToken ? tokenHash(candidate.refreshToken) : '';
        const emailKey = candidate.email ? String(candidate.email).trim().toLowerCase() : '';
        const key =
          accessHash ||
          refreshHash ||
          emailKey ||
          `${candidate.label || ''}|${candidate.sourcePath || ''}`;
        const dedupeKey = `${providerKey}:${key}`;
        if (seen.has(dedupeKey)) {
          return;
        }
        seen.add(dedupeKey);
        merged.push(candidate);
      };
      for (const set of sets) {
        for (const candidate of set || []) {
          push(candidate);
        }
      }
      return merged;
    };

    const shouldAttachNirvana =
      requested === 'nirvana' ||
      requested === 'antigravity' ||
      ['trae', 'warp', 'cursor', 'kiro', 'windsurf'].includes(norm);
    if (shouldAttachNirvana && options.includeNirvana !== false) {
      const nirvanaCandidates = importNirvanaCandidates({
        sourcePath: options.sourcePath || '',
        provider: isNirvanaBrokerImport ? '' : norm,
        defaultProvider: isNirvanaBrokerImport
          ? normalizeNirvanaProviderHint(options.defaultProvider || '') || 'trae'
          : norm,
        allowArchiveExtract: options.nirvanaAllowArchiveExtract !== false,
        includeDefaultRoots: options.nirvanaIncludeDefaultRoots !== false,
        includeEnvRoot: options.nirvanaIncludeEnvRoot !== false,
        usePresetEmail: isNirvanaBrokerImport,
        defaultEmail: options.defaultEmail || NIRVANA_PRESET_LOGIN_EMAIL,
      });
      candidates = mergeCandidates(candidates, nirvanaCandidates);
    }

    if (options.sourcePath && options.includeGeneric !== false && !isNirvanaBrokerImport) {
      const genericCandidates = importGenericCandidatesFromPath(norm, options.sourcePath);
      candidates = mergeCandidates(candidates, genericCandidates);
    }

    candidates = candidates.filter((c) => c && isValidEmail(c.email));

    const byProvider = {};
    const ensureProviderStats = (providerKey) => {
      const key = String(providerKey || '').trim();
      if (!byProvider[key]) {
        byProvider[key] = { found: 0, inserted: 0, updated: 0, activated: null };
      }
      return byProvider[key];
    };

    let inserted = 0;
    let updated = 0;
    const lastIdByProvider = {};
    for (const candidate of candidates) {
      const targetProvider = isNirvanaBrokerImport
        ? normalizeNirvanaProviderHint(candidate.provider || '') ||
          normalizePoolType(candidate.provider || '') ||
          norm
        : norm;
      const stats = ensureProviderStats(targetProvider);
      stats.found += 1;

      const res = await upsertTokenRecord(targetProvider, candidate);
      if (res.inserted) {
        inserted++;
      }
      if (res.updated) {
        updated++;
      }
      if (res.inserted) {
        stats.inserted += 1;
      }
      if (res.updated) {
        stats.updated += 1;
      }
      lastIdByProvider[targetProvider] = res.id || lastIdByProvider[targetProvider] || 0;
    }

    let activated = null;
    const activatedByProvider = {};
    if (options.activateIfNone !== false) {
      for (const [providerKey, lastId] of Object.entries(lastIdByProvider)) {
        if (!lastId) {
          continue;
        }
        const active = await getActiveAccount(providerKey);
        if (!active) {
          await setActiveAccount(providerKey, lastId);
          activatedByProvider[providerKey] = lastId;
          ensureProviderStats(providerKey).activated = lastId;
          if (providerKey === norm) {
            activated = lastId;
          }
        }
      }
    }

    return {
      provider: norm,
      found: candidates.length,
      inserted,
      updated,
      activated,
      activatedByProvider,
      byProvider,
    };
  }

  /**
   * Auto-import credentials from Nirvana source archive/path when adapters
   * observe local login/account-switch events.
   */
  async function autoImportObservedCredentials(provider, options = {}) {
    const norm = normalizePoolType(provider);
    if (!norm) {
      return { provider: '', imported: false, skipped: true, reason: 'provider_required' };
    }

    const enabled = parseBoolean(
      options.enabled ??
        process.env.KHY_POOL_EVENT_AUTO_IMPORT ??
        process.env.KHY_ACCOUNT_POOL_EVENT_AUTO_IMPORT,
      true
    );
    if (!enabled) {
      return { provider: norm, imported: false, skipped: true, reason: 'disabled' };
    }

    const includeDefaultSource = parseBoolean(
      options.includeDefaultSource ?? process.env.KHY_POOL_EVENT_AUTO_IMPORT_USE_DEFAULT_SOURCE,
      false
    );
    const includeEnvSource = parseBoolean(
      options.includeEnvSource ?? process.env.KHY_POOL_EVENT_AUTO_IMPORT_USE_ENV_SOURCE,
      false
    );
    const sourcePath = resolveObservedAutoImportSourcePath({
      ...options,
      includeDefaultSource,
      includeEnvSource,
    });

    if (sourcePath) {
      try {
        if (!fs.existsSync(sourcePath)) {
          return {
            provider: norm,
            sourcePath,
            imported: false,
            skipped: true,
            reason: 'source_not_found',
          };
        }
      } catch {
        return {
          provider: norm,
          sourcePath,
          imported: false,
          skipped: true,
          reason: 'source_not_accessible',
        };
      }
    }

    const force = options.force === true;
    const cooldownMs = resolveObservedAutoImportCooldownMs(options);
    const key = `${norm}:${sourcePath || 'observed-local'}`;
    const now = Date.now();
    const state = _observedAutoImportState.get(key) || {
      lastAt: 0,
      inFlight: null,
      lastResult: null,
    };

    if (!force && state.inFlight) {
      return state.inFlight;
    }
    if (!force && state.lastAt > 0 && now - state.lastAt < cooldownMs) {
      return {
        provider: norm,
        sourcePath,
        imported: false,
        skipped: true,
        reason: 'cooldown',
        cooldownMs,
        sinceLastMs: now - state.lastAt,
        lastResult: state.lastResult,
      };
    }

    const task = (async () => {
      state.lastAt = Date.now();
      try {
        const hasExplicitSourcePath = !!sourcePath;
        const imported = await importProviderTokens(norm, {
          activateIfNone: true,
          ...(hasExplicitSourcePath ? { sourcePath } : {}),
          includeNirvana: true,
          includeGeneric: hasExplicitSourcePath,
          nirvanaAllowArchiveExtract: hasExplicitSourcePath,
          nirvanaIncludeDefaultRoots: hasExplicitSourcePath,
          nirvanaIncludeEnvRoot: hasExplicitSourcePath,
        });
        const result = {
          provider: norm,
          sourcePath,
          imported: true,
          skipped: false,
          reason: '',
          found: imported?.found || 0,
          inserted: imported?.inserted || 0,
          updated: imported?.updated || 0,
          activated: imported?.activated || null,
          byProvider: imported?.byProvider || {},
        };
        state.lastResult = result;
        return result;
      } catch (err) {
        const result = {
          provider: norm,
          sourcePath,
          imported: false,
          skipped: true,
          reason: 'import_failed',
          error: err?.message || String(err),
        };
        state.lastResult = result;
        return result;
      } finally {
        state.inFlight = null;
        _observedAutoImportState.set(key, state);
      }
    })();

    state.inFlight = task;
    _observedAutoImportState.set(key, state);
    return task;
  }

  return {
    importProviderTokens,
    autoImportObservedCredentials,
    detectWarpLocalLogin,
  };
};
