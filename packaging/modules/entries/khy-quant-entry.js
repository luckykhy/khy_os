#!/usr/bin/env node
'use strict';

/**
 * Standalone entry for khy-quant module.
 * Provides quantitative trading tools: backtest, data, training, strategy.
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
    'khy-quant',
    'Quantitative trading toolkit with backtesting and market data commands.',
    'khy-quant [command] [args...]',
    args
  )) return;

  bootstrap();

  try {
    // Windows spawn hardening
    try {
      require('../../../services/backend/src/bootstrap/windowsSpawnHardening').installWindowsSpawnHardening();
    } catch { /* best effort */ }

    if (args.length === 0) {
      // Interactive mode — launch quant REPL
      const repl = require('../../../services/backend/src/cli/repl');
      await repl.startRepl({ module: 'khy-quant' });
    } else {
      // Command mode — route to handler
      const router = require('../../../services/backend/src/cli/router');
      await router.route(args[0], args.slice(1));
    }
  } catch (err) {
    console.error(`khy-quant startup failed: ${err.message}`);
    process.exit(1);
  }
}

main();
