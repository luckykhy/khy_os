'use strict';
// Integration: file-read upper-limit raise + bounded-window-instead-of-hard-error.
// Reproduces the reported bug ("html files won't read") â€?a file between the old
// 500KB hard cap and the new 2MB cap must now read fully; a file beyond 2MB must
// return a bounded window + honest pagination notice (gate ON) or hard-error
// (gate OFF, byte-revert). Tools read process.env at execute() time, so the gate
// is toggled in-process around each call.
// node:test (jest is broken under rtk â€?run with `node --test`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileRead = require('../../src/tools/FileReadTool');
const readFile = require('../../src/tools/readFile');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-readlimit-'));
function writeSized(name, bytes) {
  const p = path.join(tmp, name);
  // 40-char lines + newline = 41 bytes each â†?predictable size, many lines.
  const line = 'x'.repeat(40) + '\n';
  const reps = Math.ceil(bytes / line.length);
  fs.writeFileSync(p, line.repeat(reps));
  return p;
}
// 800KB: above the legacy 500KB hard cap, below the new 2MB cap.
const midPath = writeSized('mid.html', 800 * 1024);
// 2.5MB: above the new 2MB cap â†?bounded window territory.
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

describe('File Read Limit Integration', () => {
  test('800KB file: gate ON (default) â†?reads fully (was the reported failure)', async () => {
      const res = await withGate(undefined, () => FileRead.execute({ file_path: midPath }));
      expect(res.success).toBe(true);
      expect(res.truncated).toBe(false);
      expect(res.size).toBe(fs.statSync(midPath).size);
  });

  test('800KB file: gate OFF â†?hard error at legacy 500KB cap (byte-revert)', async () => {
      const res = await withGate('0', () => FileRead.execute({ file_path: midPath }));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/too large/i);
  });

  test('2.5MB file: gate ON â†?bounded window + honest pagination notice', async () => {
      const res = await withGate(undefined, () => FileRead.execute({ file_path: bigPath }));
      expect(res.success).toBe(true);
      expect(res.truncated).toBe(true);
      expect(res.content).toMatch(/è¶…è¿‡å•æ¬¡è¯»å–ä¸Šé™/);
      expect(res.content).toMatch(/offset\/limit/);
  });

  test('2.5MB file: gate OFF â†?hard error (byte-revert)', async () => {
      const res = await withGate('0', () => FileRead.execute({ file_path: bigPath }));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/too large/i);
  });

  test('readFile tool: 800KB reads fully on (gate ON); 2.5MB bounded + notice', async () => {
      const mid = await withGate(undefined, () => readFile.execute({ path: midPath }));
      expect(mid.success).toBe(true);
      expect(mid.truncated).toBe(false);
    
      const big = await withGate(undefined, () => readFile.execute({ path: bigPath }));
      expect(big.success).toBe(true);
      expect(big.truncated).toBe(true);
      expect(big.content).toMatch(/è¶…è¿‡å•æ¬¡è¯»å–ä¸Šé™/);
  });

  test('readFile tool: gate OFF â†?800KB hard error (legacy 500KB cap)', async () => {
      const res = await withGate('0', () => readFile.execute({ path: midPath }));
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/too large/i);
  });

});

