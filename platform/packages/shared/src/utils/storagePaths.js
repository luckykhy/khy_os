'use strict';

const path = require('path');

function resolveLogDir(env = process.env, fallbackDir = path.join(__dirname, '../../logs')) {
  const configured = env.KHY_LOG_HOME
    || (env.KHY_DATA_HOME && path.join(env.KHY_DATA_HOME, 'logs'))
    || (env.KHYQUANT_DATA_HOME && path.join(env.KHYQUANT_DATA_HOME, 'logs'));
  return configured ? path.resolve(configured) : fallbackDir;
}

module.exports = { resolveLogDir };
