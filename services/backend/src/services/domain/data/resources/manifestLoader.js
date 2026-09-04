'use strict';

const fs = require('fs');
const path = require('path');

const VALID_KINDS = new Set(['runtime', 'tool', 'dataset']);
const VALID_POLICIES = new Set(['bundled', 'first-use', 'prefetch', 'manual', 'disabled']);
const VALID_FORMATS = new Set(['file', 'tar', 'tar.gz', 'tgz', 'zip']);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

function defaultManifestPath() {
  return process.env.KHY_RESOURCE_MANIFEST
    ? path.resolve(process.env.KHY_RESOURCE_MANIFEST)
    : path.resolve(__dirname, '..', '..', '..', 'config', 'resources.json');
}

function assertRelativePath(value, label, allowDot = false) {
  if (allowDot && value === '.') return;
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').some(part => part === '..' || part === '' || part === '.')) {
    throw new Error(`${label} contains an unsafe path segment`);
  }
}

function normalizeSources(sources, label) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(`${label}.sources must contain at least one HTTPS URL`);
  }
  const seen = new Set();
  return sources.map((source, index) => {
    const value = typeof source === 'string' ? source : source && source.url;
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`${label}.sources[${index}] is invalid`); }
    if (parsed.protocol !== 'https:') throw new Error(`${label}.sources[${index}] must use HTTPS`);
    const canonical = parsed.toString();
    if (seen.has(canonical)) throw new Error(`${label}.sources contains duplicates`);
    seen.add(canonical);
    return canonical;
  });
}

function normalizeVariant(raw, label) {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object or null`);
  if (!SHA256_RE.test(String(raw.sha256 || ''))) throw new Error(`${label}.sha256 must be a 64-character SHA-256`);
  const format = raw.format || 'file';
  if (!VALID_FORMATS.has(format)) throw new Error(`${label}.format is unsupported`);
  if (format !== 'file') assertRelativePath(raw.sentinel, `${label}.sentinel`);
  if (raw.sourceSubdir != null) assertRelativePath(raw.sourceSubdir, `${label}.sourceSubdir`, true);
  for (const [index, rel] of (raw.chmod || []).entries()) assertRelativePath(rel, `${label}.chmod[${index}]`);
  for (const [index, rel] of (raw.files || []).entries()) assertRelativePath(rel, `${label}.files[${index}]`);
  const size = raw.size == null ? null : Number(raw.size);
  if (size != null && (!Number.isSafeInteger(size) || size < 0)) throw new Error(`${label}.size must be a non-negative integer`);
  return {
    sources: normalizeSources(raw.sources, label),
    sha256: String(raw.sha256).toLowerCase(), size, format,
    sentinel: raw.sentinel || null, sourceSubdir: raw.sourceSubdir || '.',
    chmod: [...(raw.chmod || [])], files: [...(raw.files || [])],
  };
}

function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest must be an object');
  if (raw.schemaVersion !== 1) throw new Error(`unsupported resource manifest schema: ${raw.schemaVersion}`);
  if (!Array.isArray(raw.resources)) throw new Error('manifest.resources must be an array');
  const ids = new Set();
  const resources = raw.resources.map((item, index) => {
    const label = `resources[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label} must be an object`);
    if (!ID_RE.test(String(item.id || ''))) throw new Error(`${label}.id is invalid`);
    if (ids.has(item.id)) throw new Error(`duplicate resource id: ${item.id}`);
    ids.add(item.id);
    if (!VALID_KINDS.has(item.kind)) throw new Error(`${label}.kind is invalid`);
    if (typeof item.version !== 'string' || !item.version.trim()) throw new Error(`${label}.version is required`);
    const policy = item.policy || 'manual';
    if (!VALID_POLICIES.has(policy)) throw new Error(`${label}.policy is invalid`);
    if (!item.platforms || typeof item.platforms !== 'object' || Array.isArray(item.platforms)) throw new Error(`${label}.platforms must be an object`);
    const platforms = {};
    for (const [platformKey, variant] of Object.entries(item.platforms)) platforms[platformKey] = normalizeVariant(variant, `${label}.platforms.${platformKey}`);
    return { id: item.id, kind: item.kind, version: item.version, policy, description: typeof item.description === 'string' ? item.description : '', platforms };
  });
  return { schemaVersion: 1, channel: raw.channel || 'stable', resources };
}

function loadManifest(manifestPath = defaultManifestPath()) {
  try {
    return validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  } catch (err) {
    const explicit = !!process.env.KHY_RESOURCE_MANIFEST;
    if (explicit || path.resolve(manifestPath) !== path.resolve(defaultManifestPath())) throw err;
    // Static require lets esbuild embed the small channel manifest in bundle.mjs.
    // Source and regular installs still read config/resources.json first, so an
    // operator can update the channel metadata without rebuilding JavaScript.
    return validateManifest(require('../../../config/resources.json'));
  }
}

function tryLoadManifest(manifestPath = defaultManifestPath()) {
  try { return { ok: true, path: manifestPath, manifest: loadManifest(manifestPath), error: null }; }
  catch (err) { return { ok: false, path: manifestPath, manifest: null, error: err.message || String(err) }; }
}

module.exports = { VALID_KINDS, VALID_POLICIES, defaultManifestPath, validateManifest, loadManifest, tryLoadManifest, assertRelativePath };
