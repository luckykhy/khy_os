'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function _compactHomePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') return null;
  const homeDir = os.homedir();
  const normalized = path.normalize(inputPath);
  if (normalized.startsWith(homeDir)) {
    return `~${normalized.slice(homeDir.length)}`;
  }
  return normalized;
}

function _validateMode(stat) {
  // NTFS stat.mode 不反映实际 ACL，Windows 上跳过权限检查
  if (process.platform === 'win32') return { mode: 0o600, secure: true };
  const mode = stat.mode & 0o777;
  const hasUnsafeBits = (mode & 0o077) !== 0;
  return {
    mode,
    secure: !hasUnsafeBits,
  };
}

function validateIdentityFile(identityFile) {
  if (!identityFile) {
    return {
      ok: true,
      code: 'no_identity_file',
      message: 'No explicit key file configured; rely on SSH agent or defaults.',
      identityFile: null,
    };
  }

  const resolvedPath = path.resolve(identityFile);
  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      code: 'identity_file_missing',
      message: `SSH key file is missing: ${_compactHomePath(resolvedPath)}`,
      identityFile: _compactHomePath(resolvedPath),
    };
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    return {
      ok: false,
      code: 'identity_file_not_file',
      message: `SSH key path is not a file: ${_compactHomePath(resolvedPath)}`,
      identityFile: _compactHomePath(resolvedPath),
    };
  }

  const modeState = _validateMode(stat);
  if (!modeState.secure) {
    return {
      ok: false,
      code: 'identity_file_insecure_mode',
      message: `SSH key permissions are too open (${modeState.mode.toString(8)}); require 600-level permission.`,
      identityFile: _compactHomePath(resolvedPath),
    };
  }

  return {
    ok: true,
    code: 'identity_file_valid',
    message: 'SSH key file is present with secure permissions.',
    identityFile: _compactHomePath(resolvedPath),
  };
}

function validateHostCredentials(hostEntry) {
  if (!hostEntry || typeof hostEntry !== 'object') {
    return {
      ok: false,
      code: 'invalid_host_entry',
      message: 'Host entry is missing or invalid.',
      identityFile: null,
    };
  }
  return validateIdentityFile(hostEntry.identityFile);
}

module.exports = {
  validateIdentityFile,
  validateHostCredentials,
};
