/**
 * Minimal launcher for the AI Management Server.
 * Loads dotenv, sets up NODE_PATH, and starts aiManagementServer directly.
 * No frontend, no GC loop, no idle shutdown — just the API server.
 */
const path = require('path');

// Set NODE_PATH first so bare module requires resolve
const rootModulesDir = path.resolve(__dirname, '..', '..', 'node_modules');
const backendModulesDir = path.resolve(__dirname, '..', 'node_modules');
const existingNodePath = process.env.NODE_PATH || '';
const paths = [backendModulesDir, rootModulesDir];
if (existingNodePath) paths.push(existingNodePath);
process.env.NODE_PATH = paths.join(path.delimiter);
require('module').Module._initPaths();

// Load .env before anything else
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

process.env.KHYQUANT_PORTABLE_ROOT = path.resolve(__dirname, '..', '..');

const aiManagementServer = require('../src/services/aiManagementServer');

async function main() {
  const port = parseInt(process.env.AI_MGMT_PORT, 10) || 9090;
  const actualPort = await aiManagementServer.start(port);
  console.log(`[mgmt-server] AI Management Server listening on http://127.0.0.1:${actualPort}`);
  console.log(
    `[mgmt-server] OpenAI-compatible endpoint: http://127.0.0.1:${actualPort}/v1/chat/completions`
  );
}

main().catch((err) => {
  console.error('[mgmt-server] Failed to start:', err && err.message ? err.message : String(err));
  process.exit(1);
});
