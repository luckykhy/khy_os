// Shim: resolve to backend CLI bootstrap via Node module resolution
const path = require('path');

function findBackendCli() {
  // 1. pip bundled: handlers/ -> software/khyquant/handlers/ -> khy_quant/bundled/services/backend/src/cli/
  const bundled = path.resolve(__dirname, '..', 'khy_quant', 'bundled', 'services', 'backend', 'src', 'cli', 'bootstrap.js');
  try { if (require('fs').existsSync(bundled)) return require(bundled); } catch {}
  // 2. source dev: handlers/ -> software/khyquant/handlers/ -> services/backend/src/cli/
  const dev = path.resolve(__dirname, '..', '..', '..', 'services', 'backend', 'src', 'cli', 'bootstrap.js');
  try { return require(dev); } catch {}
  // 3. fallback no-op (log warning in debug mode)
  try { if (process.env.DEBUG) console.warn('[khyquant] bootstrap fallback: backend CLI not found'); } catch {}
  return { bootstrap: async () => {}, muteDbLogs: () => {}, restoreDbLogs: () => {} };
}

module.exports = findBackendCli();
