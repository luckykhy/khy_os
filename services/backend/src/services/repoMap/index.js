'use strict';

/**
 * repoMap/index.js — Repo Map orchestrator + fingerprint cache.
 *
 * Wires the deterministic project scan (projectMetadataService._collectContext)
 * to the pure renderer (repoMapRenderer), adds a fingerprint-keyed on-disk cache
 * under the project data home, and is fail-soft end-to-end: any error returns an
 * empty map rather than throwing.
 *
 * Policy (token budget, cache on/off) is resolved here from flagRegistry, then
 * handed to the pure renderer — the renderer itself never reads env.
 */

const fs = require('fs');
const path = require('path');

const { getProjectDataDir } = require('../../utils/dataHome');
const flagRegistry = require('../flagRegistry');
const projectMetadataService = require('../projectMetadataService');

const repoMapRenderer = require('./repoMapRenderer');

const CACHE_SUBDIR = 'repo-map-cache';
const TOKEN_BUDGET_FLAG = 'KHY_REPO_MAP_TOKEN_BUDGET';
const CACHE_FLAG = 'KHY_REPO_MAP_CACHE';

const EMPTY_RESULT = Object.freeze({ text: '', fileCount: 0, tokenCount: 0, cached: false });

/** No-op status sink so callers may omit onStatus without extra guards. */
function _noop() {}

/** Resolve the cache directory (created), derived only from the data-home resolver. */
function _cacheDir() {
  return getProjectDataDir(CACHE_SUBDIR);
}

/** Cache file path for a fingerprint. Fingerprint change ⇒ different file ⇒ miss. */
function _cacheFile(fingerprint) {
  return path.join(_cacheDir(), `${fingerprint}.json`);
}

/** Read a cached map for a fingerprint. Returns null on any miss/corruption. */
function _readCache(fingerprint) {
  try {
    const raw = fs.readFileSync(_cacheFile(fingerprint), 'utf8');
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj === 'object' &&
      obj.fingerprint === fingerprint &&
      typeof obj.text === 'string'
    ) {
      return obj;
    }
  } catch {
    /* missing / corrupt → treated as a miss */
  }
  return null;
}

/** Write a rendered map to the fingerprint cache (best-effort, never throws). */
function _writeCache(fingerprint, payload) {
  try {
    const file = _cacheFile(fingerprint);
    const body = JSON.stringify({
      fingerprint,
      text: payload.text,
      fileCount: payload.fileCount,
      tokenCount: payload.tokenCount,
    });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch {
    /* cache is an optimization; a write failure must never break the build */
  }
}

/**
 * Resolve the token budget: explicit argument wins, otherwise the numeric flag
 * KHY_REPO_MAP_TOKEN_BUDGET (clamped by the registry).
 * @param {number} [tokenBudget]
 * @returns {number}
 */
function _resolveTokenBudget(tokenBudget) {
  const n = Number(tokenBudget);
  if (Number.isFinite(n) && n > 0) {
    return n;
  }
  return flagRegistry.resolveNumeric(TOKEN_BUDGET_FLAG);
}

/**
 * Build the Repo Map for a directory.
 *
 * @param {object} args
 * @param {string} args.cwd            Project root to scan.
 * @param {number} [args.tokenBudget]  Token cap; defaults from the numeric flag.
 * @param {boolean} [args.forceRefresh] Bypass a cache hit and re-render.
 * @param {function} [args.onStatus]   Optional status callback (动作+目标+进度).
 * @returns {{ text: string, fileCount: number, tokenCount: number, cached: boolean }}
 */
function buildRepoMap(args) {
  const opts = args || {};
  const emit = typeof opts.onStatus === 'function' ? opts.onStatus : _noop;
  try {
    const cwd = opts.cwd;
    const tokenBudget = _resolveTokenBudget(opts.tokenBudget);
    const cacheEnabled = flagRegistry.isFlagEnabled(CACHE_FLAG);

    // TODO(CONTEXT.yaml fast-path): when a FRESH .ai/CONTEXT.yaml is present and
    // its fingerprint matches, parse it to skip the rescan. Deferred — non-trivial
    // YAML parsing; for now always call _collectContext (correct, just not the
    // cheapest cold path). The on-disk fingerprint cache below already covers the
    // hot path.
    const limits = projectMetadataService._internal.LIMITS();
    const collected = projectMetadataService._internal._collectContext(cwd, limits);
    if (!collected || !collected.ok || !collected.ctx) {
      return { ...EMPTY_RESULT };
    }

    const ctx = collected.ctx;
    const totalFiles = Number.isFinite(collected.fileCount) ? collected.fileCount : 0;
    const fingerprint = projectMetadataService._internal._computeFingerprint(ctx);

    // Cache hit: fingerprint unchanged → skip re-render.
    if (cacheEnabled && !opts.forceRefresh) {
      const hit = _readCache(fingerprint);
      if (hit) {
        emit('代码地图缓存命中 (指纹未变, 跳过重扫)');
        return {
          text: hit.text,
          fileCount: Number.isFinite(hit.fileCount) ? hit.fileCount : 0,
          tokenCount: Number.isFinite(hit.tokenCount) ? hit.tokenCount : 0,
          cached: true,
        };
      }
    }

    emit(`正在构建代码地图 (已解析 ${totalFiles}/${totalFiles} 文件)...`);
    const rendered = repoMapRenderer.renderRepoMap(ctx, { tokenBudget });

    if (cacheEnabled) {
      _writeCache(fingerprint, rendered);
    }

    emit(`已生成代码地图 (渲染 ${rendered.fileCount}/${totalFiles} 文件)`);
    return {
      text: rendered.text,
      fileCount: rendered.fileCount,
      tokenCount: rendered.tokenCount,
      cached: false,
    };
  } catch {
    // fail-soft: any error → empty map, never throw.
    return { ...EMPTY_RESULT };
  }
}

module.exports = {
  buildRepoMap,
  // Exposed for tests/reuse.
  _internal: {
    _cacheDir,
    _cacheFile,
    _readCache,
    _writeCache,
    _resolveTokenBudget,
    CACHE_SUBDIR,
  },
};
