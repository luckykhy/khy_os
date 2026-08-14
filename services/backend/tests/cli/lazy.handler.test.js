'use strict';

/**
 * khy lazy handler tests (node:test).
 *
 * Exercises the CLI face of the laziness methodology: `ladder` prints the SSOT
 * ladder, `debt` harvests `lazy:` markers from a temp tree, `level`/`on`/`off`
 * persist via an injected writeEnvPatch (no real .env touched). Printers are
 * captured before requiring the handler (it destructures them at load).
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const formatters = require('../../src/cli/formatters');

let logs = [];
const origPrinters = {};
for (const name of ['printInfo', 'printError', 'printTable', 'printSuccess', 'printWarn']) {
  origPrinters[name] = formatters[name];
  formatters[name] = (...a) => { logs.push({ name, a }); };
}

const { handleLazy } = require('../../src/cli/handlers/lazy');

beforeEach(() => { logs = []; });
test.after(() => { for (const n of Object.keys(origPrinters)) formatters[n] = origPrinters[n]; });

function joined() { return logs.map((l) => JSON.stringify(l.a)).join(' | '); }

test('ladder → prints the 7-rung ladder, writes nothing', () => {
  const writes = [];
  const code = handleLazy('ladder', [], {}, { writeEnvPatch: (m) => { writes.push(m); return '/tmp/.env'; } });
  assert.equal(code, 0);
  assert.equal(writes.length, 0);
  assert.match(joined(), /YAGNI/);
  assert.match(joined(), /标准库/);
});

test('debt → harvests lazy: markers from a temp tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-debt-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x=1; // lazy: 全局锁, 吞吐成瓶颈再换每账户锁\n');
  fs.writeFileSync(path.join(dir, 'b.py'), '# lazy: O(n^2) 扫描\n');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'c.js'), '// lazy: should be skipped\n');
  const code = handleLazy('debt', [], {}, { rootDir: dir });
  assert.equal(code, 0);
  const out = joined();
  assert.match(out, /a\.js:1/);
  assert.match(out, /b\.py:1/);
  assert.doesNotMatch(out, /node_modules/); // skipped
  assert.match(out, /no-trigger/); // b.py has no upgrade path
});

test('debt → clean ledger when no markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazy-clean-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');
  const code = handleLazy('debt', [], {}, { rootDir: dir });
  assert.equal(code, 0);
  assert.match(joined(), /台账干净/);
});

test('level ultra → persists KHY_CODE_LAZINESS_LEVEL=ultra', () => {
  const writes = [];
  const code = handleLazy('level', ['ultra'], {}, { writeEnvPatch: (m) => { writes.push(m); return '/tmp/.env'; } });
  assert.equal(code, 0);
  assert.deepEqual(writes[0], { KHY_CODE_LAZINESS_LEVEL: 'ultra' });
});

test('level bogus → error, no write', () => {
  const writes = [];
  const code = handleLazy('level', ['bogus'], {}, { writeEnvPatch: (m) => { writes.push(m); return '/tmp/.env'; } });
  assert.equal(code, 1);
  assert.equal(writes.length, 0);
});

test('off → persists KHY_CODE_LAZINESS=off', () => {
  const writes = [];
  const code = handleLazy('off', [], {}, { writeEnvPatch: (m) => { writes.push(m); return '/tmp/.env'; } });
  assert.equal(code, 0);
  assert.deepEqual(writes[0], { KHY_CODE_LAZINESS: 'off' });
});
