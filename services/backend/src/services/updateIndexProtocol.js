'use strict';

const SCHEMA_VERSION = 1;
const VALID_PLATFORMS = new Set(['win32', 'linux', 'darwin']);
const VALID_ARCHES = new Set(['x64', 'arm64']);

function normalizeTarget(platform, arch) {
  const normalizedPlatform = platform === 'win' || platform === 'windows'
    ? 'win32'
    : platform === 'macos' ? 'darwin' : platform;
  if (!VALID_PLATFORMS.has(normalizedPlatform)) throw new Error(`Unsupported platform: ${platform}`);
  if (!VALID_ARCHES.has(arch)) throw new Error(`Unsupported architecture: ${arch}`);
  if (normalizedPlatform === 'linux' && arch !== 'x64') throw new Error('Supported Linux artifact target is linux-x64');
  return { platform: normalizedPlatform, arch };
}

function platformSlug(platform, arch) {
  const target = normalizeTarget(platform, arch);
  const name = target.platform === 'win32' ? 'win' : target.platform === 'darwin' ? 'macos' : 'linux';
  return `${name}-${target.arch}`;
}
const CHANNELS = new Set(['stable', 'preview', 'dev']);
const KINDS = new Set(['portable-runtime', 'portable-dev']);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function validatePackageArtifact(artifact, label, errors) {
  if (!isPlainObject(artifact)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (!isHttpsUrl(artifact.url)) errors.push(`${label}.url must use HTTPS`);
  if (artifact.filename !== undefined &&
      (typeof artifact.filename !== 'string' || !artifact.filename ||
       artifact.filename !== pathBasename(artifact.filename))) {
    errors.push(`${label}.filename must be a basename`);
  }
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
    errors.push(`${label}.size must be a positive integer`);
  }
  if (!SHA256.test(String(artifact.sha256 || '').toLowerCase())) {
    errors.push(`${label}.sha256 is missing or invalid`);
  }
}

function pathBasename(value) {
  return String(value).replace(/\\/g, '/').split('/').pop();
}

function validateUpdateIndex(index, expected = {}) {
  const errors = [];
  if (!isPlainObject(index)) return { ok: false, errors: ['index must be an object'] };
  if (index.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!CHANNELS.has(index.channel)) errors.push(`unsupported channel: ${index.channel}`);
  if (expected.channel && index.channel !== expected.channel) errors.push(`channel does not match ${expected.channel}`);
  if (!isPlainObject(index.release)) errors.push('release must be an object');

  const release = isPlainObject(index.release) ? index.release : {};
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(release.version || ''))) {
    errors.push('release.version must be a semantic version');
  }
  if (!COMMIT.test(String(release.commit || '').toLowerCase())) errors.push('release.commit must be a full Git commit');
  if (!Number.isFinite(Date.parse(String(release.publishedAt || '')))) errors.push('release.publishedAt must be an ISO date');
  if (expected.version && release.version !== expected.version) errors.push(`version does not match ${expected.version}`);
  if (expected.commit && release.commit !== expected.commit) errors.push(`commit does not match ${expected.commit}`);

  if (!isPlainObject(index.packages)) errors.push('packages must be an object');
  else {
    const allowedKeys = new Set(['pip', 'npm']);
    for (const key of Object.keys(index.packages)) {
      if (!allowedKeys.has(key)) errors.push(`unsupported package channel: ${key}`);
    }
    if (index.packages.pip) {
      if (!['khy-os', 'khy-quant'].includes(index.packages.pip.name)) errors.push('unsupported pip package');
      if (index.packages.pip.version !== release.version) errors.push('pip version does not match release');
      if (index.packages.pip.artifact !== undefined) {
        validatePackageArtifact(index.packages.pip.artifact, 'packages.pip.artifact', errors);
      }
    }
    if (index.packages.npm) {
      if (index.packages.npm.name !== '@khy-os/khy-os') errors.push('unsupported npm package');
      if (index.packages.npm.version !== release.version) errors.push('npm version does not match release');
      if (index.packages.npm.artifact !== undefined) {
        validatePackageArtifact(index.packages.npm.artifact, 'packages.npm.artifact', errors);
      }
    }
  }

  if (!Array.isArray(index.portable) || index.portable.length === 0) {
    errors.push('portable must contain at least one artifact');
  } else {
    const seen = new Set();
    for (const [position, artifact] of index.portable.entries()) {
      const label = `portable[${position}]`;
      if (!isPlainObject(artifact)) {
        errors.push(`${label} must be an object`);
        continue;
      }
      if (!KINDS.has(artifact.kind)) errors.push(`${label}.kind is unsupported`);
      let slug = '';
      try {
        const target = normalizeTarget(artifact.target?.platform, artifact.target?.arch);
        slug = platformSlug(target.platform, target.arch);
        if (expected.platform && target.platform !== expected.platform) errors.push(`${label} platform mismatch`);
        if (expected.arch && target.arch !== expected.arch) errors.push(`${label} architecture mismatch`);
      } catch (error) {
        errors.push(`${label}: ${error.message}`);
      }
      const key = `${artifact.kind}:${slug}`;
      if (seen.has(key)) errors.push(`duplicate portable target: ${key}`);
      seen.add(key);
      if (artifact.version !== release.version) errors.push(`${label}.version does not match release`);
      if (artifact.commit !== release.commit) errors.push(`${label}.commit does not match release`);
      if (!isHttpsUrl(artifact.url)) errors.push(`${label}.url must use HTTPS`);
      if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) errors.push(`${label}.size must be a positive integer`);
      if (!SHA256.test(String(artifact.sha256 || '').toLowerCase())) errors.push(`${label}.sha256 is missing or invalid`);
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { SCHEMA_VERSION, CHANNELS, normalizeTarget, platformSlug, validateUpdateIndex };
