#!/usr/bin/env node
'use strict';

/**
 * check-f2e-wiring.js — Front-end ↔ Back-end wiring audit.
 *
 * Verifies that every frontend API call (request.get/post/put/delete/patch
 * in apps/ai-frontend/src/api/) has a corresponding backend route mount
 * (app.use('/api/...', ...) in services/backend/server.js or
 * a.use('/api/..., ...) in services/backend/src/services/aiManagementServer.js).
 *
 * This catches wiring drift: a frontend page calls /api/foo but no backend
 * route handles it (404 at runtime), or a backend route exists that no
 * frontend page consumes (dead endpoint).
 *
 * Exit 0 = all frontend calls have a matching backend route.
 * Exit 1 = wiring gaps found (report printed to stdout).
 *
 * Usage:
 *   node scripts/ci/check-f2e-wiring.js            # full audit
 *   node scripts/ci/check-f2e-wiring.js --verbose  # show matches too
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_API_DIR = path.join(ROOT, 'apps', 'ai-frontend', 'src', 'api');
const MONOLITH_SERVER = path.join(ROOT, 'services', 'backend', 'server.js');
const DAEMON_SERVER = path.join(ROOT, 'services', 'backend', 'src', 'services', 'aiManagementServer.js');

const VERBOSE = process.argv.includes('--verbose');

// ── 1. Collect all frontend API calls ───────────────────────────
function collectFrontendCalls() {
  const calls = [];
  if (!fs.existsSync(FRONTEND_API_DIR)) return calls;

  const files = fs.readdirSync(FRONTEND_API_DIR)
    .filter(f => f.endsWith('.js') && !f.includes('.test.'));

  for (const f of files) {
    const src = fs.readFileSync(path.join(FRONTEND_API_DIR, f), 'utf8');
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match: request.get('/api/...)  request.post('/api/...) etc.
      // Handles single quotes, double quotes, and backticks.
      const m = line.match(/request\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)/);
      if (m) {
        calls.push({
          file: f,
          line: i + 1,
          httpMethod: m[1].toUpperCase(),
          url: m[2],
        });
      }
    }
  }
  return calls;
}

// ── 2. Collect all backend route mounts ────────────────────────
// Returns array of { prefix: '/api/xxx', source: 'server.js' | 'aiManagementServer.js' }
function collectBackendMounts() {
  const mounts = [];

  const sources = [
    { file: MONOLITH_SERVER, label: 'server.js', prefix: 'app.use' },
    { file: DAEMON_SERVER, label: 'aiManagementServer.js', prefix: 'a.use' },
  ];

  for (const src of sources) {
    if (!fs.existsSync(src.file)) continue;
    const content = fs.readFileSync(src.file, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      // Match: app.use('/api/xxx', ...)  or  a.use('/api/xxx', ...)
      const m = line.match(/\.(?:use)\s*\(\s*['"`]([^'"`]+)['"`]/);
      if (m && m[1].startsWith('/api/')) {
        mounts.push({ prefix: m[1], source: src.label });
      }
    }
  }

  return mounts;
}

// ── 3. Match frontend call against backend ─────────────────────
function findBackendMatch(frontendUrl, mounts) {
  const cleanUrl = frontendUrl.split('?')[0];

  // Sort mounts by prefix length descending so the most specific match wins
  const sorted = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);

  for (const mount of sorted) {
    if (cleanUrl === mount.prefix || cleanUrl.startsWith(mount.prefix + '/')) {
      return { type: 'mount', matched: mount.prefix, source: mount.source };
    }
  }

  return null;
}

// ── Main ───────────────────────────────────────────────────────
function main() {
  const frontendCalls = collectFrontendCalls();
  const backendMounts = collectBackendMounts();

  console.log('Front-end ↔ Back-end Wiring Audit');
  console.log('==================================');
  console.log('  Frontend API calls:  ' + frontendCalls.length);
  console.log('  Backend route mounts: ' + backendMounts.length);
  console.log('');

  const gaps = [];
  const matched = [];

  for (const call of frontendCalls) {
    const match = findBackendMatch(call.url, backendMounts);
    if (match) {
      matched.push({ call, match });
    } else {
      gaps.push(call);
    }
  }

  if (VERBOSE && matched.length > 0) {
    console.log('Matched wiring (' + matched.length + '):');
    console.log('-----------------------------------');
    for (const { call, match } of matched) {
      console.log('  ✓ ' + call.httpMethod + ' ' + call.url);
      console.log('    frontend: ' + call.file + ':' + call.line);
      console.log('    backend:  ' + match.source + ' mount ' + match.matched);
    }
    console.log('');
  }

  // Report gaps
  if (gaps.length > 0) {
    console.log('WIRING GAPS FOUND: ' + gaps.length);
    console.log('====================');
    for (const g of gaps) {
      console.log('  ✗ ' + g.httpMethod + ' ' + g.url);
      console.log('    frontend: ' + g.file + ':' + g.line);
      console.log('    backend:  NO matching route mount');
    }
    console.log('');
    console.log('Action: ensure each gap has a corresponding route mount in');
    console.log('  services/backend/server.js (monolith) or');
    console.log('  services/backend/src/services/aiManagementServer.js (daemon).');
    process.exit(1);
  }

  console.log('All frontend API calls have matching backend routes. Wiring is correct.');
  console.log('  ' + matched.length + ' call(s) verified.');
  process.exit(0);
}

main();
