#!/usr/bin/env node
'use strict';

/**
 * Standalone entry for khy-server module.
 * Runs the Express web server with management UI.
 */

process.env.KHY_MODE = 'standalone';

const path = require('path');
const fs = require('fs');
const { handleStandaloneInfo } = require('./standalone-info');

const BACKEND_ROOT = process.env.KHY_BACKEND_ROOT
  || path.resolve(__dirname, '../../../services/backend');

function bootstrap() {
  if (!process.env.KHY_HOME) {
    const os = require('os');
    process.env.KHY_HOME = path.join(os.homedir(), '.khyquant');
  }
  const configDir = process.env.KHY_HOME;
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (handleStandaloneInfo(
    'khy-server',
    'Web management backend and API server.',
    'khy-server [--port PORT]',
    args
  )) return;

  bootstrap();

  try {
    // Support --port flag
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
      process.env.PORT = args[portIdx + 1];
    }

    // Start the Express server
    require('../../../services/backend/server');
  } catch (err) {
    console.error(`khy-server startup failed: ${err.message}`);
    process.exit(1);
  }
}

main();
