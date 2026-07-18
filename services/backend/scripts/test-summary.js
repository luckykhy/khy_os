#!/usr/bin/env node
'use strict';

/**
 * test-summary.js — anti-context-flood test runner.
 *
 * Running the full backend regression suite (178 Jest suites + 8 node:test TAP
 * suites) emits thousands of lines of stdout. When that stdout lands verbatim in
 * an autonomous agent's tool result, it floods the context/memory window and the
 * session crashes. A prompt instruction like "only report a summary" cannot
 * prevent this: the raw stdout is already in the tool result by the time the
 * model reads it.
 *
 * This wrapper moves the safeguard from the prompt layer to the command layer.
 * Full output is captured to a log file on disk; only a bounded summary
 * (pass/fail counts + failing suite/test names) is printed to stdout, so the
 * tool result stays small no matter how large or how red the run is.
 *
 * Memory is also bounded for the child runners (--runInBand + a heap cap) so a
 * single suite cannot OOM the box.
 *
 * Usage:
 *   npm run test:summary                 # full regression (jest + node:test)
 *   npm run test:summary -- tests/toolUseLoop   # scoped jest run (iteration)
 *   npm run test:summary -- --jest-only  # skip the node:test TAP pass
 *
 * Full output is written to .cbssp-test.log in the backend root.
 * Exit code is non-zero if any runner failed.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const backendRoot = path.resolve(__dirname, '..');
const LOG_PATH = path.join(backendRoot, '.cbssp-test.log');
const HEAP_CAP_MB = process.env.CBSSP_TEST_HEAP_MB || '2048';
const PRINT_LINE_CAP = 60; // hard ceiling on lines we echo, so failures can't flood either

const forwarded = process.argv.slice(2);
const jestOnly = forwarded.includes('--jest-only');
const jestArgs = forwarded.filter((a) => a !== '--jest-only');
// A scoped run (explicit path/pattern given) skips the node:test pass by default;
// node:test files are discovered by marker, not by path filter.
const scoped = jestArgs.some((a) => !a.startsWith('-'));

// Buffer the full output and write it synchronously at the end. Streaming +
// process.exit() races the async flush and can lose the file entirely.
const logChunks = [];
const childEnv = { ...process.env };
const heapFlag = `--max-old-space-size=${HEAP_CAP_MB}`;
childEnv.NODE_OPTIONS = childEnv.NODE_OPTIONS
  ? `${childEnv.NODE_OPTIONS} ${heapFlag}`
  : heapFlag;

function section(title) {
  logChunks.push(`\n===== ${title} =====\n`);
}

// jest's bin is hidden behind package "exports"; locate it via package.json + bin.
const jestPkgPath = require.resolve('jest/package.json', { paths: [backendRoot] });
const jestBin = path.join(path.dirname(jestPkgPath), require(jestPkgPath).bin);

function run(label, file, args) {
  section(label);
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: backendRoot,
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = `${result.stdout || ''}${result.stderr || ''}`;
  logChunks.push(out);
  return { out, status: result.status == null ? 1 : result.status };
}

// Discover node:test files by their runner marker (mirrors jest.config.js).
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

const summary = [];
let failed = false;

// --- Jest pass -------------------------------------------------------------
const jest = run('jest', jestBin, ['--runInBand', '--silent', ...jestArgs]);
if (jest.status !== 0) failed = true;
for (const line of jest.out.split('\n')) {
  // Keep only the verdict block + failures; drop the 170+ green "PASS" lines.
  if (/^(Test Suites:|Tests:|Snapshots:|Time:)/.test(line)) summary.push(`[jest] ${line.trim()}`);
  else if (/^FAIL /.test(line)) summary.push(`[jest] ${line.trim()}`);
  else if (/^\s*●\s/.test(line)) summary.push(`[jest] ${line.trim()}`);
}

// --- node:test pass --------------------------------------------------------
if (!jestOnly && !scoped) {
  const nodeFiles = findNodeTestFiles(path.join(backendRoot, 'tests'));
  if (nodeFiles.length) {
    const node = run('node:test', '--test', nodeFiles);
    if (node.status !== 0) failed = true;
    let pass = 0;
    let fail = 0;
    const failNames = [];
    for (const line of node.out.split('\n')) {
      if (/^ok\s/.test(line)) pass += 1;
      else if (/^not ok\s/.test(line)) {
        fail += 1;
        failNames.push(`[node] ${line.trim()}`);
      }
    }
    summary.push(`[node:test] pass=${pass} fail=${fail} (${nodeFiles.length} files)`);
    summary.push(...failNames);
  }
}

logChunks.push('');
fs.writeFileSync(LOG_PATH, logChunks.join(''));

// --- Bounded summary to stdout --------------------------------------------
const lines = summary.length ? summary : ['(no summary lines parsed — see log)'];
const shown = lines.slice(0, PRINT_LINE_CAP);
process.stdout.write(shown.join('\n') + '\n');
if (lines.length > shown.length) {
  process.stdout.write(`... ${lines.length - shown.length} more lines suppressed\n`);
}
process.stdout.write(`\nVERDICT: ${failed ? 'FAIL' : 'PASS'}  |  full log: ${path.relative(process.cwd(), LOG_PATH)}\n`);

process.exit(failed ? 1 : 0);
