#!/usr/bin/env node
'use strict';

/**
 * Standalone entry for khy-tools module.
 * Provides developer tools: deploy, ci, proxy, plugin-dev, etc.
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
    'khy-tools',
    'Developer tools for deployment, CI, plugins, maintenance, and diagnostics.',
    'khy-tools <command> [args...]',
    args
  )) return;

  bootstrap();

  try {
    // Windows spawn hardening
    try {
      require('../../../services/backend/src/bootstrap/windowsSpawnHardening').installWindowsSpawnHardening();
    } catch { /* best effort */ }

    if (args.length === 0) {
      // Show available tools
      const chalk = require('chalk');
      console.log(chalk.bold('\n  khy-tools — Developer Toolkit\n'));
      console.log('  Available commands:');
      console.log('    deploy, ci, pr, proxy, publish, ide, extension');
      console.log('    plugin-dev, forge, convert, deps, health, heal');
      console.log('    maintain, metadata, modules\n');
      console.log(`  Usage: ${chalk.cyan('khy-tools <command> [args...]')}\n`);
      return;
    }

    // Route to handler
    const router = require('../../../services/backend/src/cli/router');
    await router.route(args[0], args.slice(1));
  } catch (err) {
    console.error(`khy-tools startup failed: ${err.message}`);
    process.exit(1);
  }
}

main();
