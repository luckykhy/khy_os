'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Some suites under tests/ AND src/ (e.g. `__tests__/` colocated next to their
 * implementation) are authored for Node's built-in `node:test` runner (they
 * `require('node:test')`), not Jest. Jest tears its environment down before
 * those suites' async bodies execute, which surfaces as spurious "import after
 * teardown" / "not a function" / "must contain at least one test" failures even
 * though the suites pass cleanly under `node --test` (see the `test:node`
 * script).
 *
 * A second group under tests/ are standalone self-running scripts: they execute
 * their assertions at top level and print a summary (e.g. `process.exit(1)` on
 * failure), registering no test at all — Jest rejects them with "must contain
 * at least one test" even though they pass under plain `node tests/foo.test.js`
 * and under `node --test` (which runs the file body as the test).
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

// Registration markers of a real Jest suite. `it.each(...)(...)` / `test.each`
// / `describe.each` register tests too, so `.each` is covered explicitly.
const JEST_REGISTER_RE =
  /(?:describe|test|it)\s*\.\s*each\s*\(|\b(?:describe|test|it)\s*\(\s*['"`]/;
const NODE_TEST_RE = /require\s*\(\s*['"]node:test['"]\s*\)|from\s*['"]node:test['"]/;

function findStandaloneTestFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findStandaloneTestFiles(full));
    } else if (entry.name.endsWith('.test.js')) {
      const src = fs.readFileSync(full, 'utf8');
      if (!JEST_REGISTER_RE.test(src) && !NODE_TEST_RE.test(src)) {
        found.push(full);
      }
    }
  }
  return found;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const nodeTestIgnores = [
  ...findNodeTestFiles(path.join(__dirname, 'tests')),
  ...findNodeTestFiles(path.join(__dirname, 'src')),
  ...findStandaloneTestFiles(path.join(__dirname, 'tests')),
].map(escapeRegExp);

module.exports = {
  testPathIgnorePatterns: ['/node_modules/', ...nodeTestIgnores],
  // Pin the jest suite to RTK-off so native command-shape assertions are
  // deterministic regardless of whether an `rtk` binary is on PATH (see the
  // setup file's header for the rationale). RTK logic is covered separately by
  // tests/rtkMode.test.js (node:test, injected spawn).
  setupFiles: [
    '<rootDir>/tests/jest.rtkOff.setup.js',
    // Pin data home to a throwaway dir so the task-store singleton never
    // touches the live task list (see the setup file's header).
    '<rootDir>/tests/jest.taskStoreIsolation.setup.js',
    // Pin the log dir likewise, so suites stop appending fixture noise to the
    // real app-/error-<date>.log files (see the setup file's header).
    '<rootDir>/tests/jest.logIsolation.setup.js',
  ],
};
