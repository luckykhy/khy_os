// Shim: resolve to backend CLI bootstrap via Node module resolution
const path = require('path');

function findBackendCli() {
  // 1. pip bundled: handlers/ -> software/khyquant/handlers/ -> bundled/services/backend/src/cli/
  const bundled = path.resolve(__dirname, '..', '..', '..', 'services', 'backend', 'src', 'cli', 'bootstrap.js');
  try { if (require('fs').existsSync(bundled)) return require(bundled); } catch {}
  // 2. source dev: handlers/ -> software/khyquant/handlers/ -> services/backend/src/cli/
  const dev = path.resolve(__dirname, '..', '..', '..', 'services', 'backend', 'src', 'cli', 'bootstrap.js');
  try { return require(dev); } catch {}
  // 3. fallback no-op
  return { bootstrap: async () => {}, muteDbLogs: () => {}, restoreDbLogs: () => {} };
}

module.exports = findBackendCli();
