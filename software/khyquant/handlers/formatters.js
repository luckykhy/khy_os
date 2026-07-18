// Shim: resolve to backend CLI formatters via path traversal
const path = require('path');

function findFormatters() {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'services', 'backend', 'src', 'cli', 'formatters.js'),
  ];
  for (const p of candidates) {
    try { if (require('fs').existsSync(p)) return require(p); } catch {}
  }
  // Minimal fallback for standalone mode
  return {
    printQuote: (...a) => console.log(...a),
    printTable: (...a) => console.log(...a),
    printSuccess: (...a) => console.log('OK:', ...a),
    printError: (...a) => console.error('ERROR:', ...a),
    withSpinner: async (msg, fn) => { console.log(msg); return fn(); },
  };
}

module.exports = findFormatters();
