'use strict';

/**
 * aiBackendModuleResolve.js — make the sibling `services/ai-backend/` tree able
 * to resolve its bare npm dependencies inside a bundled pip install.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 * The khychat daemon (`services/backend/scripts/ai-manage-daemon.js` →
 * `aiManagementServer.js`) cross-requires ai-backend routers via
 * `require('../../../ai-backend/src/...')`. Those ai-backend modules then do
 * bare requires (`express`, `sequelize`, `@khy/shared/*`, `ws`, `axios`,
 * `jsonwebtoken`, …).
 *
 * In the dev tree this resolves fine: root-hoisted `node_modules` plus the
 * `services/ai-backend/node_modules -> ../backend/node_modules` symlink cover
 * every dep. In a bundled pip install neither exists:
 *   - the dev symlink is not copied (COPY_EXCLUDE_PATTERNS strips node_modules),
 *   - ai-backend has NO ancestor `node_modules` (it is a *sibling* of
 *     `bundled/services/backend`, not a parent),
 *   - the only complete dependency store is `bundled/services/backend/node_modules`,
 *     populated by setup.py's first-run `npm install` (standalone package.json +
 *     vendored `@khy/shared`).
 * So every ai-backend bare require throws `Cannot find module` at sub-app
 * construction → the daemon dispatcher catch → HTTP 500 on user-gateway /
 * proxy-subscriptions / marketplace / plugins / workflow routes.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Append `services/backend/node_modules` to the global module resolution
 * fallback (NODE_PATH) before the aiManagementServer require, so the sibling
 * ai-backend tree resolves its deps (and `@khy/shared`, whose `exports` map
 * covers every subpath ai-backend imports) from backend's store.
 *
 * Design notes:
 *   - Fallback-only: NODE_PATH is consulted AFTER the normal node_modules walk,
 *     so this never shadows or changes any already-resolvable module. In dev it
 *     is a no-op (root hoist + symlink already resolve everything).
 *   - Idempotent: a repeated call does not grow NODE_PATH.
 *   - Fail-soft: any error is swallowed by the caller's try/catch; this module
 *     additionally guards internally so a missing directory is simply skipped.
 *   - Ungated by design: gating it off would only re-break bundled installs
 *     (the exact "gate-off re-introduces the breakage" anti-pattern). Consistent
 *     with the sibling ungated `ensureAuthSecret` bootstrap.
 */

const path = require('path');
const fs = require('fs');

/**
 * Resolve backend's node_modules directory relative to this file.
 * __dirname = <root>/services/backend/src/bootstrap
 *   → ../../node_modules = <root>/services/backend/node_modules
 * In a bundle this is `bundled/services/backend/node_modules` (npm-installed at
 * first run); in dev it is the sparse workspace dir (harmless — never hit).
 */
function _backendNodeModulesDir() {
  return path.resolve(__dirname, '../../node_modules');
}

/**
 * Append `dir` to process.env.NODE_PATH (de-duplicated) and refresh Node's
 * global module search paths. Returns true if NODE_PATH changed.
 */
function ensureAiBackendResolvable(options = {}) {
  try {
    const dir = options.backendNodeModulesDir || _backendNodeModulesDir();

    // Skip silently if the store does not exist yet (e.g. deps not installed):
    // adding a non-existent path would be inert anyway, but avoid churn.
    try {
      if (!fs.existsSync(dir)) return false;
    } catch { /* fs probe failed — fall through and attempt the append */ }

    const sep = path.delimiter;
    const current = process.env.NODE_PATH ? process.env.NODE_PATH.split(sep) : [];
    // Idempotent: already present → nothing to do.
    if (current.includes(dir)) return false;

    current.push(dir);
    process.env.NODE_PATH = current.filter(Boolean).join(sep);

    // Rebuild Module.globalPaths from the updated NODE_PATH so the new fallback
    // takes effect for subsequent requires in this process.
    // eslint-disable-next-line global-require
    require('module').Module._initPaths();
    return true;
  } catch {
    // Fail-soft: never let a resolution-bootstrap failure crash the daemon.
    return false;
  }
}

module.exports = { ensureAiBackendResolvable };
module.exports.__test__ = { _backendNodeModulesDir };
