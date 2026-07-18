'use strict';

/**
 * binaryAnalyzerCrashGuard.test.js — regression for the RangeError crash fix.
 *
 * parseELF/parsePE walk attacker-controlled section/program-header offsets. A
 * crafted binary with valid magic but a bogus shentsize (e.g. 0 or 8) whose
 * shoff sits near EOF makes Node's readBigUInt64LE / readUInt32LE read past the
 * buffer end and throw RangeError. analyzeBinary calls these WITHOUT a try/catch,
 * so a user analyzing a malformed/truncated binary would crash the request.
 *
 * The KHY_BINARY_PARSE_GUARD gate (default-on) wraps the risky header walks and
 * degrades to a partial header result instead of throwing. With the gate OFF the
 * legacy (throwing) behavior is preserved byte-for-byte — proving the guard is
 * load-bearing, not cosmetic.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { parseELF, parsePE, binaryParseGuardEnabled } = require('../src/services/binaryAnalyzer');

// ── crafted corpus (mirrors scripts/diagnostics/fuzzFileCorpus.js) ──

// 64-bit ELF header, little-endian. e_shoff points near EOF, e_shentsize = 0.
function craftedElfShentsizeZero() {
  const buf = Buffer.alloc(72, 0);
  buf.write('\x7fELF', 0, 'latin1'); // EI_MAG
  buf[4] = 2;                        // EI_CLASS = ELFCLASS64
  buf[5] = 1;                        // EI_DATA = little-endian
  buf.writeUInt16LE(2, 16);          // e_type = ET_EXEC
  buf.writeUInt16LE(0x3e, 18);       // e_machine = x86-64
  buf.writeBigUInt64LE(64n, 40);     // e_shoff = 64 (near the 72-byte EOF)
  buf.writeUInt16LE(0, 58);          // e_shentsize = 0  (bogus → off+32 overflows)
  buf.writeUInt16LE(4, 60);          // e_shnum = 4
  return buf;
}

// e_shentsize = 8 (< 40): off + 32 read still overflows before the entry ends.
function craftedElfShentsizeSmall() {
  const buf = craftedElfShentsizeZero();
  buf.writeUInt16LE(8, 58);          // e_shentsize = 8
  return buf;
}

// 64-bit PE that reaches the guarded import-directory walk, then overflows.
// optHeaderSize must fit (optOff+optHeaderSize <= len) so parsePE doesn't bail
// early, but numDirs>1 makes it read readUInt32LE(optOff+112+8) past EOF.
function craftedPeImportOverflow() {
  const peOff = 0x80;
  const optOff = peOff + 4 + 20;    // 152
  const optHeaderSize = 112;        // buffer ends exactly at optOff+112
  const len = optOff + optHeaderSize; // 264
  const buf = Buffer.alloc(len, 0);
  buf.write('MZ', 0, 'latin1');
  buf.writeUInt32LE(peOff, 0x3c);        // e_lfanew
  buf.write('PE\x00\x00', peOff, 'latin1');
  buf.writeUInt16LE(0x8664, peOff + 4);  // machine = AMD64
  buf.writeUInt16LE(1, peOff + 6);       // NumberOfSections
  buf.writeUInt16LE(optHeaderSize, peOff + 20); // SizeOfOptionalHeader
  buf.writeUInt16LE(0x20b, optOff);      // PE32+ magic
  buf.writeUInt32LE(16, optOff + 108);   // numDirs = 16 (>1 → import walk reads past EOF)
  return buf;
}

// ── gate default is ON ──────────────────────────────────────────────

test('binaryParseGuardEnabled defaults to true', () => {
  assert.equal(binaryParseGuardEnabled({}), true);
  assert.equal(binaryParseGuardEnabled({ KHY_BINARY_PARSE_GUARD: '1' }), true);
});

test('binaryParseGuardEnabled honors disable tokens', () => {
  for (const off of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
    assert.equal(binaryParseGuardEnabled({ KHY_BINARY_PARSE_GUARD: off }), false, `token ${off}`);
  }
});

// ── guard ON: never throws, returns partial header ─────────────────

test('parseELF does not throw on shentsize=0 near EOF (guard on)', () => {
  const buf = craftedElfShentsizeZero();
  let result;
  assert.doesNotThrow(() => { result = parseELF(buf, { KHY_BINARY_PARSE_GUARD: '1' }); });
  assert.ok(result && typeof result === 'object');
  assert.equal(result.format, 'ELF');
  // header fields parsed before the risky walk survive
  assert.equal(result.bits, 64);
  assert.equal(result.architecture, 'x86_64');
});

test('parseELF does not throw on shentsize=8 (guard on)', () => {
  const buf = craftedElfShentsizeSmall();
  assert.doesNotThrow(() => parseELF(buf, { KHY_BINARY_PARSE_GUARD: '1' }));
});

test('parsePE does not throw on import-directory overflow (guard on)', () => {
  const buf = craftedPeImportOverflow();
  let result;
  assert.doesNotThrow(() => { result = parsePE(buf, { KHY_BINARY_PARSE_GUARD: '1' }); });
  assert.ok(result && typeof result === 'object');
  assert.equal(result.format, 'PE');
});

test('parsePE throws on import-directory overflow when guard disabled', () => {
  const buf = craftedPeImportOverflow();
  assert.throws(() => parsePE(buf, { KHY_BINARY_PARSE_GUARD: '0' }), /out of range|RangeError|bounds/i);
});

// ── guard OFF: legacy throwing behavior preserved (load-bearing) ────

test('parseELF throws on shentsize=0 when guard disabled (proves guard is load-bearing)', () => {
  const buf = craftedElfShentsizeZero();
  assert.throws(() => parseELF(buf, { KHY_BINARY_PARSE_GUARD: '0' }), /out of range|RangeError|bounds/i);
});

// ── well-formed inputs are unaffected by the guard ─────────────────

test('parseELF on a clean minimal ELF returns identical result guard on/off', () => {
  // Minimal valid header with e_shoff = 0 (no section walk) — both paths agree.
  const buf = Buffer.alloc(64, 0);
  buf.write('\x7fELF', 0, 'latin1');
  buf[4] = 2; buf[5] = 1;
  buf.writeUInt16LE(2, 16);
  buf.writeUInt16LE(0x3e, 18);
  // e_shoff stays 0 → no section header walk attempted
  const on = parseELF(buf, { KHY_BINARY_PARSE_GUARD: '1' });
  const off = parseELF(buf, { KHY_BINARY_PARSE_GUARD: '0' });
  assert.deepEqual(on, off);
});
