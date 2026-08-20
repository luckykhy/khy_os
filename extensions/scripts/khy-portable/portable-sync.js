#!/usr/bin/env node
'use strict';

/**
 * scripts/portable-sync.js — thin wrapper around `khy portable sync`.
 *
 * Lets you sync the dev tree to the portable copy without entering the REPL:
 *   node scripts/portable-sync.js [--target <dir>] [--dry-run] [--mirror]
 *                                 [--with-node-modules] [--skip-node-modules]
 *                                 [--skip-check] [--yes] [--status]
 *
 * All real logic lives in services/backend (engine + handler); this file only
 * parses argv into the handler's options shape and delegates.
 */

const FLAG_KEYS = new Set([
  'dry-run', 'mirror', 'with-node-modules', 'skip-node-modules',
  'skip-check', 'yes', 'status', 'help',
]);

function parseArgv(argv) {
  const options = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { args.push(token); continue; }
    const key = token.slice(2);
    if (key === 'target' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      options.target = argv[++i];
    } else if (FLAG_KEYS.has(key)) {
      options[key] = true;
    } else {
      console.error(`未知参数: --${key} (可用: --target/--dry-run/--mirror/--with-node-modules/--skip-node-modules/--skip-check/--yes/--status/--help)`);
      process.exit(1);
    }
  }
  return { options, args };
}

async function main() {
  const { options, args } = parseArgv(process.argv.slice(2));
  const { handlePortable } = require('../../../services/backend/src/cli/handlers/portable');
  let sub = 'sync';
  if (options.help) sub = 'help';
  else if (options.status) sub = 'status';
  try {
    await handlePortable(sub, args, options);
  } catch (err) {
    console.error(`portable-sync 执行失败: ${(err && err.message) || err}`);
    process.exit(1);
  }
}

main();
