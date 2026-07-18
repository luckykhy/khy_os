'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function getConfigPath() {
  const configured = process.env.KHY_REMOTE_SSH_CONFIG_PATH;
  if (typeof configured === 'string' && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(os.homedir(), '.ssh', 'config');
}

function _stripInlineComment(line) {
  const hashIndex = line.indexOf('#');
  if (hashIndex < 0) return line;
  return line.slice(0, hashIndex);
}

function _parseDirective(line) {
  const cleaned = _stripInlineComment(line).trim();
  if (!cleaned) return null;
  const match = cleaned.match(/^(\S+)\s+(.+)$/);
  if (!match) return null;
  return {
    key: String(match[1]).toLowerCase(),
    value: String(match[2]).trim(),
  };
}

function _isWildcardHostPattern(hostPattern) {
  return /[*?!]/.test(hostPattern);
}

function _expandHomePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return null;
  const trimmed = inputPath.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('~/')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  if (trimmed === '~') return os.homedir();
  return trimmed;
}

function _normalizePort(portValue) {
  const parsed = Number.parseInt(String(portValue || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 22;
}

function _buildHostEntry(alias, mergedOptions) {
  return {
    alias,
    host: mergedOptions.hostname || alias,
    port: _normalizePort(mergedOptions.port),
    user: mergedOptions.user || null,
    identityFile: _expandHomePath(mergedOptions.identityfile),
    proxyJump: mergedOptions.proxyjump || null,
    remoteWorkspace: mergedOptions.remoteworkspace || null,
  };
}

function parseSshConfig(content) {
  const text = typeof content === 'string' ? content : '';
  const blocks = [];
  let currentBlock = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const directive = _parseDirective(rawLine);
    if (!directive) continue;

    if (directive.key === 'host') {
      const patterns = directive.value.split(/\s+/).filter(Boolean);
      currentBlock = {
        patterns,
        options: {},
      };
      blocks.push(currentBlock);
      continue;
    }

    if (!currentBlock) {
      continue;
    }

    if (currentBlock.options[directive.key] === undefined) {
      currentBlock.options[directive.key] = directive.value;
    }
  }

  const defaults = {};
  for (const block of blocks) {
    if (block.patterns.includes('*')) {
      Object.assign(defaults, block.options);
    }
  }

  const hostMap = new Map();

  for (const block of blocks) {
    for (const hostPattern of block.patterns) {
      if (!hostPattern || _isWildcardHostPattern(hostPattern)) {
        continue;
      }
      const mergedOptions = {
        ...defaults,
        ...block.options,
      };
      hostMap.set(hostPattern, _buildHostEntry(hostPattern, mergedOptions));
    }
  }

  return Array.from(hostMap.values()).sort((a, b) => a.alias.localeCompare(b.alias));
}

function readConfigFile() {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { path: configPath, content: '' };
  }
  return {
    path: configPath,
    content: fs.readFileSync(configPath, 'utf8'),
  };
}

function listHosts() {
  const config = readConfigFile();
  return {
    configPath: config.path,
    hosts: parseSshConfig(config.content),
  };
}

module.exports = {
  getConfigPath,
  parseSshConfig,
  readConfigFile,
  listHosts,
};
