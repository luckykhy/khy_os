#!/usr/bin/env node
'use strict';

/**
 * Standalone entry for the full khy platform.
 * This is functionally equivalent to bin/khy.js but wrapped for pkg bundling.
 */

process.env.KHY_MODULE = 'khy';
process.env.KHY_MODE = 'standalone';

const path = require('path');

const BACKEND_ROOT = process.env.KHY_BACKEND_ROOT
  || path.resolve(__dirname, '../../../services/backend');

// Delegate to the original CLI entry point
require(path.join(BACKEND_ROOT, 'bin/khy.js'));
