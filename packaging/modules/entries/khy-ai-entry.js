#!/usr/bin/env node
'use strict';

/**
 * Standalone entry for khy-ai module.
 * Provides AI chat REPL without database or full server dependencies.
 */

process.env.KHY_MODE = 'standalone';

const path = require('path');
const fs = require('fs');
const { handleStandaloneInfo } = require('./standalone-info');

// Resolve backend root (works both in dev and bundled mode)
const BACKEND_ROOT = process.env.KHY_BACKEND_ROOT
  || path.resolve(__dirname, '../../../services/backend');

// Bootstrap minimal environment
function bootstrap() {
  // Set minimal env defaults
  if (!process.env.KHY_HOME) {
    const os = require('os');
    process.env.KHY_HOME = path.join(os.homedir(), '.khyquant');
  }

  // Ensure config directory exists
  const configDir = process.env.KHY_HOME;
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (handleStandaloneInfo(
    'khy-ai',
    'Interactive AI chat REPL with one-shot prompt support.',
    'khy-ai [prompt]',
    args
  )) return;

  bootstrap();

  try {
    // Windows spawn hardening (best effort)
    try {
      require('../../../services/backend/src/bootstrap/windowsSpawnHardening').installWindowsSpawnHardening();
    } catch { /* best effort */ }

    // Start AI REPL
    const repl = require('../../../services/backend/src/cli/repl');

    // Check for one-shot mode (khy-ai "prompt here")
    if (args.length > 0 && !args[0].startsWith('-')) {
      // One-shot AI query
      const aiChat = require('../../../services/backend/src/cli/aiChatCore');
      await aiChat.handleSingleQuery(args.join(' '));
    } else {
      // Interactive REPL mode
      await repl.startRepl({ aiMode: true, module: 'khy-ai' });
    }
  } catch (err) {
    console.error(`khy-ai startup failed: ${err.message}`);
    process.exit(1);
  }
}

main();
