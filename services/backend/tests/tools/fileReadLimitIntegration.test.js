'use strict';

// Integration: file-read upper-limit raise + bounded-window-instead-of-hard-error.
// Reproduces the reported bug ("html files won't read") — a file between the old
// 500KB hard cap and the new 2MB cap must now read fully; a file beyond 2MB must
// return a bounded window + honest pagination notice (gate ON) or hard-error
// (gate OFF, byte-revert). Tools read process.env at execute() time, so the gate
// is toggled in-process around each call.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FileRead = require('../../src/tools/FileReadTool');
const readFile = require('../../src/tools/readFile');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-readlimit-'));

function writeSized(name, bytes) {
  const p = path.join(tmp, name);
  // 40-char lines + newline = 41 bytes each → predictable size, many lines.
  const line = 'x'.repeat(40) + '\n';
  const reps = Math.ceil(bytes / line.length);
  fs.writeFileSync(p, line.repeat(reps));
  return p;
}

// 800KB: above the legacy 500KB hard cap, below the new 2MB cap.
const midPath = writeSized('mid.html', 800 * 1024);
// 2.5MB: above the new 2MB cap → bounded window territory.
const bigPath = writeSized('big.txt', 2.5 * 1024 * 1024);

function withGate(value, fn) {
  const prev = process.env.KHY_FILE_READ_LIMIT;
  if (value === undefined) delete process.env.KHY_FILE_READ_LIMIT;
  else process.env.KHY_FILE_READ_LIMIT = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.KHY_FILE_READ_LIMIT;
    else process.env.KHY_FILE_READ_LIMIT = prev;
  }
}

test('800KB file: gate ON (default) → reads fully (was the reported failure)', async () => {
  const res = await withGate(undefined, () => FileRead.execute({ file_path: midPath }));
  assert.equal(res.success, true, JSON.stringify(res).slice(0, 200));
  assert.equal(res.truncated, false);
  assert.equal(res.size, fs.statSync(midPath).size);
});

test('800KB file: gate OFF → hard error at legacy 500KB cap (byte-revert)', async () => {
  const res = await withGate('0', () => FileRead.execute({ file_path: midPath }));
  assert.equal(res.success, false);
  assert.match(res.error, /too large/i);
});

test('2.5MB file: gate ON → bounded window + honest pagination notice', async () => {
  const res = await withGate(undefined, () => FileRead.execute({ file_path: bigPath }));
  assert.equal(res.success, true, JSON.stringify(res).slice(0, 200));
  assert.equal(res.truncated, true);
  assert.match(res.content, /超过单次读取上限/);
  assert.match(res.content, /offset\/limit/);
});

test('2.5MB file: gate OFF → hard error (byte-revert)', async () => {
  const res = await withGate('0', () => FileRead.execute({ file_path: bigPath }));
  assert.equal(res.success, false);
  assert.match(res.error, /too large/i);
});

test('readFile tool: 800KB reads fully on (gate ON); 2.5MB bounded + notice', async () => {
  const mid = await withGate(undefined, () => readFile.execute({ path: midPath }));
  assert.equal(mid.success, true);
  assert.equal(mid.truncated, false);

  const big = await withGate(undefined, () => readFile.execute({ path: bigPath }));
  assert.equal(big.success, true);
  assert.equal(big.truncated, true);
  assert.match(big.content, /超过单次读取上限/);
});

test('readFile tool: gate OFF → 800KB hard error (legacy 500KB cap)', async () => {
  const res = await withGate('0', () => readFile.execute({ path: midPath }));
  assert.equal(res.success, false);
  assert.match(res.error, /too large/i);
});
