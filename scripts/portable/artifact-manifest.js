'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const MANIFEST_FILENAME = 'MANIFEST.json';
const SUMS_FILENAME = 'SHA256SUMS';
const BUILD_INFO_FILENAME = 'BUILD-INFO.json';
const VALID_KINDS = new Set(['portable-dev', 'portable-runtime']);
const VALID_PLATFORMS = new Set(['win32', 'linux', 'darwin']);
const VALID_ARCHES = new Set(['x64', 'arm64']);
const GENERATED_FILES = new Set([MANIFEST_FILENAME, SUMS_FILENAME]);

function toPosixPath(value) {
  return String(value).split(path.sep).join('/');
}

function normalizeTarget(platform, arch) {
  const normalizedPlatform = platform === 'win' || platform === 'windows'
    ? 'win32'
    : platform === 'macos' ? 'darwin' : platform;
  if (!VALID_PLATFORMS.has(normalizedPlatform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  if (!VALID_ARCHES.has(arch)) {
    throw new Error(`Unsupported architecture: ${arch}`);
  }
  if (normalizedPlatform === 'linux' && arch !== 'x64') {
    throw new Error('Supported Linux artifact target is linux-x64');
  }
  return { platform: normalizedPlatform, arch };
}

function platformSlug(platform, arch) {
  const target = normalizeTarget(platform, arch);
  const name = target.platform === 'win32'
    ? 'win'
    : target.platform === 'darwin' ? 'macos' : 'linux';
  return `${name}-${target.arch}`;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function listPayloadFiles(rootDir) {
  const root = path.resolve(rootDir);
  const files = [];

  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Artifact entry escapes root: ${absolute}`);
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`Artifact contains a symbolic link: ${relative}`);
      }
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && !GENERATED_FILES.has(toPosixPath(relative))) {
        files.push({ absolute, path: toPosixPath(relative) });
      }
    }
  }

  walk(root);
  return files;
}

async function inventoryArtifact(rootDir) {
  const files = listPayloadFiles(rootDir);
  const inventory = [];
  for (const file of files) {
    const stat = fs.statSync(file.absolute);
    inventory.push({
      path: file.path,
      size: stat.size,
      sha256: await sha256File(file.absolute),
      mode: process.platform === 'win32' ? undefined : (stat.mode & 0o777).toString(8).padStart(3, '0'),
    });
  }
  return inventory.map(item => {
    if (item.mode === undefined) delete item.mode;
    return item;
  });
}

function validateManifestShape(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') errors.push('manifest must be an object');
  if (manifest?.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!VALID_KINDS.has(manifest?.kind)) errors.push(`unsupported kind: ${manifest?.kind}`);
  try {
    normalizeTarget(manifest?.target?.platform, manifest?.target?.arch);
  } catch (error) {
    errors.push(error.message);
  }
  if (!Array.isArray(manifest?.files)) errors.push('files must be an array');
  return errors;
}

async function writeArtifactManifest(rootDir, metadata) {
  const root = path.resolve(rootDir);
  if (!VALID_KINDS.has(metadata.kind)) throw new Error(`Unsupported artifact kind: ${metadata.kind}`);
  const target = normalizeTarget(metadata.platform, metadata.arch);
  const files = await inventoryArtifact(root);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: metadata.kind,
    name: metadata.name || `${metadata.kind}-${platformSlug(target.platform, target.arch)}`,
    version: String(metadata.version || '0.0.0'),
    target,
    runtimes: metadata.runtimes || {},
    frontends: metadata.frontends || {},
    nativeModules: metadata.nativeModules || [],
    source: metadata.source || {},
    files,
  };
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const sums = [...files, {
    path: MANIFEST_FILENAME,
    sha256: await sha256File(manifestPath),
  }].map(file => `${file.sha256}  ${file.path}`).join('\n');
  fs.writeFileSync(path.join(root, SUMS_FILENAME), `${sums}\n`, 'utf8');
  return manifest;
}

async function verifyArtifactManifest(rootDir) {
  const root = path.resolve(rootDir);
  const manifestPath = path.join(root, MANIFEST_FILENAME);
  const issues = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { ok: false, manifest: null, issues: [`MANIFEST.json unreadable: ${error.message}`] };
  }
  issues.push(...validateManifestShape(manifest));
  if (!Array.isArray(manifest.files)) return { ok: false, manifest, issues };

  const seen = new Set();
  for (const file of manifest.files) {
    const relative = typeof file.path === 'string' ? file.path : '';
    if (!relative || relative.includes('\\') || relative.startsWith('/') || relative.split('/').includes('..')) {
      issues.push(`invalid manifest path: ${relative || '<empty>'}`);
      continue;
    }
    if (seen.has(relative)) {
      issues.push(`duplicate manifest path: ${relative}`);
      continue;
    }
    seen.add(relative);
    const absolute = path.resolve(root, ...relative.split('/'));
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      issues.push(`manifest path escapes artifact: ${relative}`);
      continue;
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      issues.push(`missing file: ${relative}`);
      continue;
    }
    const stat = fs.statSync(absolute);
    if (stat.size !== file.size) issues.push(`size mismatch: ${relative}`);
    const digest = await sha256File(absolute);
    if (digest !== file.sha256) issues.push(`sha256 mismatch: ${relative}`);
  }

  const actual = listPayloadFiles(root).map(file => file.path);
  for (const relative of actual) {
    if (!seen.has(relative)) issues.push(`untracked file: ${relative}`);
  }

  const sumsPath = path.join(root, SUMS_FILENAME);
  try {
    const expectedSums = new Map();
    const lines = fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^([a-f0-9]{64})  (.+)$/i);
      if (!match) {
        issues.push(`invalid SHA256SUMS line: ${line}`);
        continue;
      }
      const [, digest, relative] = match;
      if (expectedSums.has(relative)) {
        issues.push(`duplicate SHA256SUMS path: ${relative}`);
        continue;
      }
      expectedSums.set(relative, digest.toLowerCase());
    }
    const expectedPaths = new Set([...seen, MANIFEST_FILENAME]);
    for (const relative of expectedPaths) {
      if (!expectedSums.has(relative)) issues.push(`SHA256SUMS missing path: ${relative}`);
    }
    for (const relative of expectedSums.keys()) {
      if (!expectedPaths.has(relative)) issues.push(`SHA256SUMS unexpected path: ${relative}`);
    }
    const manifestDigest = await sha256File(manifestPath);
    if (expectedSums.get(MANIFEST_FILENAME) !== manifestDigest) {
      issues.push('SHA256SUMS manifest digest mismatch');
    }
    for (const file of manifest.files) {
      if (typeof file.path === 'string' && expectedSums.get(file.path) !== file.sha256) {
        issues.push(`SHA256SUMS payload digest mismatch: ${file.path}`);
      }
    }
  } catch (error) {
    issues.push(`SHA256SUMS unreadable: ${error.message}`);
  }
  return { ok: issues.length === 0, manifest, issues };
}

module.exports = {
  SCHEMA_VERSION,
  MANIFEST_FILENAME,
  SUMS_FILENAME,
  BUILD_INFO_FILENAME,
  normalizeTarget,
  platformSlug,
  toPosixPath,
  sha256File,
  listPayloadFiles,
  inventoryArtifact,
  validateManifestShape,
  writeArtifactManifest,
  verifyArtifactManifest,
};
