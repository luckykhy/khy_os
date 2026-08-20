'use strict';

const path = require('path');

function resolveLogDir(env = process.env, fallbackDir = path.join(__dirname, '../../logs')) {
  // KHY_LOG_DIR sits below the data homes on purpose: it is the test-isolation
  // hook (tests/jest.logIsolation.setup.js), not a deployment knob, and must not
  // outrank the canonical <data home>/logs contract.
  const configured = env.KHY_LOG_HOME
    || (env.KHY_DATA_HOME && path.join(env.KHY_DATA_HOME, 'logs'))
    || (env.KHYQUANT_DATA_HOME && path.join(env.KHYQUANT_DATA_HOME, 'logs'))
    || env.KHY_LOG_DIR;
  return configured ? path.resolve(configured) : fallbackDir;
}

function resolveLogWriteDir(env = process.env, fallbackDir) {
  const root = resolveLogDir(env, fallbackDir);
  return String(env.KHY_LOG_LAYOUT || 'active').toLowerCase() === 'legacy'
    ? root
    : path.join(root, 'active');
}

function resolveLogArchiveDir(env = process.env, fallbackDir) {
  return path.join(resolveLogDir(env, fallbackDir), 'archive');
}

module.exports = { resolveLogDir, resolveLogWriteDir, resolveLogArchiveDir };
