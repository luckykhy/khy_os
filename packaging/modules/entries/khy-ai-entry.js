#!/usr/bin/env node
'use strict';

/**
 * Standalone entry for khy-ai module.
 * Provides AI chat REPL without database or full server dependencies.
 */

// Set module identity before any other require
process.env.KHY_MODULE = 'khy-ai';
process.env.KHY_MODE = 'standalone';

const path = require('path');
const fs = require('fs');

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
  bootstrap();

  try {
    // Windows spawn hardening (best effort)
    try {
      require(path.join(BACKEND_ROOT, 'src/bootstrap/windowsSpawnHardening')).installWindowsSpawnHardening();
    } catch { /* best effort */ }

    // Start AI REPL
    const replPath = path.join(BACKEND_ROOT, 'src/cli/repl');
    const repl = require(replPath);

    // Check for one-shot mode (khy-ai "prompt here")
    const args = process.argv.slice(2);
    if (args.length > 0 && !args[0].startsWith('-')) {
      // One-shot AI query
      const aiChat = require(path.join(BACKEND_ROOT, 'src/cli/aiChatCore'));
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
