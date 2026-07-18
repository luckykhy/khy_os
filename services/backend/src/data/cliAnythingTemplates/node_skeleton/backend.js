'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function findExe(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = require('child_process').execFileSync(cmd, [name], {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split(/\r?\n/)[0].trim();
    if (result) return result;
  } catch { /* not found */ }

  const commonPaths = [
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `/opt/${name}/bin/${name}`,
    path.join(require('os').homedir(), '.local', 'bin', name),
  ];
  for (const p of commonPaths) {
    try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
  }

  const envVar = `${name.toUpperCase()}_PATH`;
  if (process.env[envVar]) return process.env[envVar];
  return null;
}

function runCommand(args, opts = {}) {
  const timeout = opts.timeout || 60000;
  const cwd = opts.cwd || undefined;
  try {
    const output = execFileSync(args[0], args.slice(1), {
      encoding: 'utf-8', timeout, cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    return { success: true, stdout: output, stderr: '' };
  } catch (err) {
    return {
      success: false,
      error: err.message || 'command failed',
      stderr: err.stderr ? err.stderr.toString().slice(0, 2000) : '',
      exitCode: err.status || -1,
    };
  }
}

module.exports = { findExe, runCommand };
