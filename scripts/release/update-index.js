#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeTarget, platformSlug, validateUpdateIndex } = require('../../services/backend/src/services/updateIndexProtocol');

const SCHEMA_VERSION = 1;
const CHANNELS = new Set(['stable', 'preview', 'dev']);
const PACKAGE_EXTENSIONS = Object.freeze({
  pip: ['.whl', '.tar.gz', '.zip'],
  npm: ['.tgz'],
});

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function sha256FileSync(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function packageArtifact(file, channel, baseUrl) {
  if (!file) return null;
  const absolute = path.resolve(file);
  const filename = path.basename(absolute);
  const extensions = PACKAGE_EXTENSIONS[channel] || [];
  if (!extensions.some(extension => filename.toLowerCase().endsWith(extension))) {
    throw new Error(`${channel} artifact has an unsupported extension: ${filename}`);
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`${channel} artifact is not a file: ${absolute}`);
  }
  return {
    url: `${baseUrl}/${encodeURIComponent(filename)}`,
    filename,
    size: fs.statSync(absolute).size,
    sha256: sha256FileSync(absolute),
  };
}

function findBuildInfo(archive, roots) {
  const stem = path.basename(archive, '.zip');
  const candidates = roots.flatMap(root => [
    path.join(root, stem, 'BUILD-INFO.json'),
    path.join(path.dirname(archive), stem, 'BUILD-INFO.json'),
  ]);
  let match = candidates.find(file => fs.existsSync(file));
  if (!match) {
    const wantedSuffix = `${stem}/BUILD-INFO.json`;
    for (const root of roots) {
      const queue = [path.resolve(root)];
      while (queue.length > 0 && !match) {
        const current = queue.shift();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const absolute = path.join(current, entry.name);
          if (entry.isDirectory()) queue.push(absolute);
          else if (absolute.split(path.sep).join('/').endsWith(wantedSuffix)) match = absolute;
        }
      }
      if (match) break;
    }
  }
  if (!match) throw new Error(`BUILD-INFO.json not found for ${archive}`);
  return JSON.parse(fs.readFileSync(match, 'utf8'));
}

function walkArchives(root) {
  const files = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.zip') && entry.name.startsWith('portable-')) files.push(absolute);
    }
  }
  walk(path.resolve(root));
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function createUpdateIndex(options) {
  const artifactsRoot = path.resolve(options.artifactsRoot);
  const archives = walkArchives(artifactsRoot);
  if (archives.length === 0) throw new Error(`No portable archives found in ${artifactsRoot}`);
  const baseUrl = String(options.baseUrl || '').replace(/\/$/, '');
  if (!isHttpsUrl(`${baseUrl}/placeholder`)) throw new Error('base URL must use HTTPS');
  const portable = archives.map(archive => {
    const info = findBuildInfo(archive, [artifactsRoot]);
    const target = normalizeTarget(info.target?.platform, info.target?.arch);
    return {
      kind: info.kind,
      version: String(info.version || ''),
      commit: String(info.sourceCommit || ''),
      target,
      url: `${baseUrl}/${encodeURIComponent(path.basename(archive))}`,
      size: fs.statSync(archive).size,
      sha256: sha256FileSync(archive),
    };
  });
  const version = String(options.version || portable[0].version);
  const commit = String(options.commit || portable[0].commit);
  const index = {
    schemaVersion: SCHEMA_VERSION,
    channel: options.channel,
    release: {
      version,
      commit,
      publishedAt: options.publishedAt,
      notes: String(options.notes || ''),
    },
    packages: {
      pip: {
        name: 'khy-os',
        version,
        ...(options.pipArtifact ? { artifact: packageArtifact(options.pipArtifact, 'pip', baseUrl) } : {}),
      },
      npm: {
        name: '@khy-os/khy-os',
        version,
        ...(options.npmArtifact ? { artifact: packageArtifact(options.npmArtifact, 'npm', baseUrl) } : {}),
      },
    },
    portable,
  };
  const validation = validateUpdateIndex(index, { channel: options.channel, version, commit });
  if (!validation.ok) throw new Error(`Invalid generated update index:\n- ${validation.errors.join('\n- ')}`);
  return index;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error(`${token} requires a value`);
      return next;
    };
    if (token === '--artifacts') options.artifactsRoot = value();
    else if (token === '--base-url') options.baseUrl = value();
    else if (token === '--channel') options.channel = value();
    else if (token === '--version') options.version = value();
    else if (token === '--commit') options.commit = value();
    else if (token === '--published-at') options.publishedAt = value();
    else if (token === '--notes') options.notes = value();
    else if (token === '--pip-artifact') options.pipArtifact = value();
    else if (token === '--npm-artifact') options.npmArtifact = value();
    else if (token === '--out') options.out = value();
    else if (token === '--verify') options.verify = value();
    else throw new Error(`Unknown option: ${token}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.verify) {
    const index = JSON.parse(fs.readFileSync(path.resolve(options.verify), 'utf8'));
    const result = validateUpdateIndex(index, options);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    console.log(`Update index verified: ${options.verify}`);
    return;
  }
  for (const required of ['artifactsRoot', 'baseUrl', 'channel', 'publishedAt', 'out']) {
    if (!options[required]) throw new Error(`Missing --${required.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
  }
  const index = createUpdateIndex(options);
  const output = path.resolve(options.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(`Update index written: ${output}`);
}

module.exports = {
  SCHEMA_VERSION,
  CHANNELS,
  validateUpdateIndex,
  createUpdateIndex,
  packageArtifact,
  sha256FileSync,
  walkArchives,
  parseArgs,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[update-index] ${error.message}`);
    process.exitCode = 1;
  }
}
