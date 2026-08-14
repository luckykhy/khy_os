'use strict';

/**
 * routerHandlers.handleLogCommand — `khy log [tail] --n <count>` line cap.
 *
 * Regression: the old `Number.parseInt(options.n || '20', 10)` only guarded
 * undefined/empty. A non-numeric ('abc'), valueless (bare `--n` → true), zero,
 * or negative value slipped through to `slice(-NaN)` / `slice(-0)`, which both
 * degrade to `slice(0)` = the ENTIRE log file — silently blowing past the
 * documented 20-line default. The fix validates the parsed number and falls
 * back to 20 for anything that is not a positive integer.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { createRouterHandlers } = require('../../../src/cli/routerHandlers');

function makeHandlers() {
  const chalkFn = (...a) => a.join(' ');
  for (const k of ['bold', 'dim', 'cyan', 'red', 'green', 'yellow', 'gray', 'white']) chalkFn[k] = chalkFn;
  return createRouterHandlers({
    fmt: () => ({ printError() {}, printSuccess() {}, printInfo() {} }),
    chk: () => chalkFn,
    symResolver: () => ({ resolveSymbol: async () => ({ matched: false }) }),
  });
}

// Run handleLogCommand against a 100-line temp log and count how many log-body
// rows ("lineN") were printed.
async function countPrintedLines(options, totalLines = 100) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khylog-'));
  fs.mkdirSync(path.join(dir, 'logs'));
  const body = Array.from({ length: totalLines }, (_, i) => `line${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'logs', 'combined.log'), body);
  const prevRoot = process.env.KHYQUANT_ROOT;
  process.env.KHYQUANT_ROOT = dir;
  const origLog = console.log;
  let count = 0;
  console.log = (...a) => { if (/(^|\s)line\d+/.test(a.join(' '))) count += 1; };
  try {
    await makeHandlers().handleLogCommand('tail', [], options);
  } finally {
    console.log = origLog;
    if (prevRoot === undefined) delete process.env.KHYQUANT_ROOT;
    else process.env.KHYQUANT_ROOT = prevRoot;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return count;
}

test('no --n → default 20 lines', async () => {
  assert.strictEqual(await countPrintedLines({}), 20);
});

test('valid --n is honored exactly', async () => {
  assert.strictEqual(await countPrintedLines({ n: '50' }), 50);
  assert.strictEqual(await countPrintedLines({ n: '20' }), 20);
  assert.strictEqual(await countPrintedLines({ n: '5' }), 5);
});

test('non-numeric --n falls back to 20 (was: whole file via slice(-NaN))', async () => {
  assert.strictEqual(await countPrintedLines({ n: 'abc' }), 20);
});

test('bare --n (options.n === true) falls back to 20 (was: whole file)', async () => {
  assert.strictEqual(await countPrintedLines({ n: true }), 20);
});

test('--n 0 falls back to 20 (was: whole file via slice(-0))', async () => {
  assert.strictEqual(await countPrintedLines({ n: '0' }), 20);
});

test('negative --n falls back to 20 (was: dropped only |n| leading lines)', async () => {
  assert.strictEqual(await countPrintedLines({ n: '-5' }), 20);
});

test('a fewer-than-default log shows all its lines, not padded', async () => {
  assert.strictEqual(await countPrintedLines({}, 8), 8);
});
