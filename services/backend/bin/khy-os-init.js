#!/usr/bin/env node
/**
 * @pattern Command
 */
/**
 * KHY OS init entry point.
 *
 * Thin wrapper that activates OS-mode environment before delegating to the
 * standard CLI.  Used by OpenRC (or any init system) to start the KHY
 * runtime as the primary operating-system service.
 *
 * Usage:
 *   node khy-os-init.js              # background service (OpenRC)
 *   node khy-os-init.js --interactive # tty1 console REPL
 */
'use strict';

// ── OS-mode environment ────────────────────────────────────────────
process.env.KHY_OS_MODE      = 'true';
process.env.IDLE_SHUTDOWN     = 'false';
process.env.PORT_AUTO_RETRY   = '0';

// Ensure data directory exists
const fs   = require('fs');
const path = require('path');

const dataDir = process.env.KHY_OS_DATA || path.join(path.sep, 'var', 'lib', 'khy-os');
const logDir  = process.env.KHY_OS_LOG  || path.join(path.sep, 'var', 'log', 'khy-os');
for (const dir of [dataDir, logDir]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* may lack perms in dev */ }
}

if (!process.env.DB_PATH) {
  process.env.DB_PATH = path.join(dataDir, 'khy-quant.db');
}

// ── Delegate to the standard CLI ───────────────────────────────────
require('./khyquant.js');
