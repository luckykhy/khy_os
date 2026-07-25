'use strict';

const fs = require('fs');
const path = require('path');

/**
 * A handful of suites under tests/ are authored for Node's built-in `node:test`
 * runner (they `require('node:test')`), not Jest. Jest tears its environment
 * down before those suites' async bodies execute, which surfaces as spurious
 * "import after teardown" / "not a function" failures even though the suites
 * pass cleanly under `node --test` (see the `test:node` script).
 *
 * Rather than hand-maintain an ignore list, discover those files by their
 * runner marker so the two runners stay cleanly separated as suites are added
 * or removed.
 */
function findNodeTestFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findNodeTestFiles(full));
    } else if (entry.name.endsWith('.test.js')) {
      const src = fs.readFileSync(full, 'utf8');
      if (src.includes("require('node:test')") || src.includes('require("node:test")')) {
        found.push(full);
      }
    }
  }
  return found;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const nodeTestIgnores = findNodeTestFiles(path.join(__dirname, 'tests')).map(escapeRegExp);

module.exports = {
  testPathIgnorePatterns: ['/node_modules/', ...nodeTestIgnores],
  // Pin the jest suite to RTK-off so native command-shape assertions are
  // deterministic regardless of whether an `rtk` binary is on PATH (see the
  // setup file's header for the rationale). RTK logic is covered separately by
  // tests/rtkMode.test.js (node:test, injected spawn).
  setupFiles: ['<rootDir>/tests/jest.rtkOff.setup.js'],
};
