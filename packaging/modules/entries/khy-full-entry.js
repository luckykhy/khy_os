#!/usr/bin/env node
'use strict';

/**
 * Standalone entry for the full khy platform.
 * This is functionally equivalent to bin/khy.js but wrapped for pkg bundling.
 */

process.env.KHY_MODE = 'standalone';

// Keep this path static so esbuild includes the complete runtime dependency
// graph. Runtime resources are resolved separately from the emitted manifest.
require('../../../services/backend/bin/khy.js');
