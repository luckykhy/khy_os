#!/usr/bin/env node
'use strict';

/**
 * Standalone entry for khy-gateway module.
 * Runs the AI gateway as an independent service.
 */

process.env.KHY_MODULE = 'khy-gateway';
process.env.KHY_MODE = 'standalone';

const path = require('path');
const fs = require('fs');

const BACKEND_ROOT = process.env.KHY_BACKEND_ROOT
  || path.resolve(__dirname, '../../../services/backend');
const AI_BACKEND_ROOT = process.env.KHY_AI_BACKEND_ROOT
  || path.resolve(__dirname, '../../../services/ai-backend');

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
  bootstrap();

  try {
    const args = process.argv.slice(2);

    // Support --port flag
    const portIdx = args.indexOf('--port');
    if (portIdx !== -1 && args[portIdx + 1]) {
      process.env.AI_GATEWAY_PORT = args[portIdx + 1];
    }

    // Start the AI gateway server
    const gatewayServer = require(path.join(AI_BACKEND_ROOT, 'server'));

    if (typeof gatewayServer.start === 'function') {
      await gatewayServer.start();
    }
    // If server.js just starts on require, it's already running

    console.log(`khy-gateway running (port: ${process.env.AI_GATEWAY_PORT || '9090'})`);
  } catch (err) {
    console.error(`khy-gateway startup failed: ${err.message}`);
    process.exit(1);
  }
}

main();
