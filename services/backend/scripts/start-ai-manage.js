/**
 * Minimal launcher for the AI Management Server.
 * Loads dotenv and sets up the environment so the daemon can access all env vars (API keys, etc).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

process.env.KHYQUANT_PORTABLE_ROOT = path.resolve(__dirname, '..', '..');

// Set NODE_PATH for module resolution (root node_modules + backend node_modules)
const rootModulesDir = path.resolve(__dirname, '..', '..', 'node_modules');
const backendModulesDir = path.resolve(__dirname, '..', 'node_modules');
const existingNodePath = process.env.NODE_PATH || '';
const paths = [backendModulesDir, rootModulesDir];
if (existingNodePath) paths.push(existingNodePath);
process.env.NODE_PATH = paths.join(path.delimiter);
require('module').Module._initPaths();

// Also ensure PYTHONPATH for bootstrap scripts that call python
process.env.PYTHONPATH = `${path.resolve(__dirname, '..', '..', 'platform')}${path.delimiter}${process.env.PYTHONPATH || ''}`;

require('./ai-manage-daemon');
