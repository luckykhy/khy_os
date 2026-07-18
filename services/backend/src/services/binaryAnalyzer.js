/**
 * binaryAnalyzer.js — ELF + PE static binary analysis service
 *
 * Parses ELF and PE binary headers to extract:
 *   - Architecture and format info
 *   - Section layout
 *   - Dynamic library dependencies
 *   - Platform-specific API usage
 *   - Cross-platform compatibility assessment
 *
 * Used by AI tools to analyze binary artifacts for portability.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// parseELF/parsePE are hand-rolled parsers that walk ATTACKER-CONTROLLED offsets
// and counts (shoff/shnum/shentsize/phoff/phnum for ELF; e_lfanew/numSections/
// optHeaderSize/data-directory RVAs for PE). A crafted or truncated binary — the
// exact kind of file a user drops in for "analyze this" — can drive a
// buffer.readBig*/read* call past the end of the buffer, which makes Node throw
// RangeError [ERR_OUT_OF_RANGE]. analyzeBinary() calls these with NO try/catch, so
// that throw becomes an unhandled rejection / tool crash. A parser fed untrusted
// bytes must NEVER throw — it must degrade to the header it already parsed. This
// gate (default on) wraps the risky section/program-header walks; off
// (=0/false/off/no) → legacy unguarded behaviour, byte-identical on well-formed
// input but crash-prone on malformed input (honest escape hatch).
function binaryParseGuardEnabled(env = process.env) {
  const flag = String((env && env.KHY_BINARY_PARSE_GUARD) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

// ─── ELF Constants ────────────────────────────────────────────────────────

const ELF_MAGIC = Buffer.from([0x7F, 0x45, 0x4C, 0x46]); // \x7FELF
const ELF_MACHINES = {
  0x03: 'x86', 0x3E: 'x86_64', 0x28: 'ARM', 0xB7: 'AArch64',
  0xF3: 'RISC-V', 0x08: 'MIPS', 0x15: 'PowerPC64',
};
const ELF_TYPES = { 1: 'relocatable', 2: 'executable', 3: 'shared_object', 4: 'core' };

// ─── PE Constants ─────────────────────────────────────────────────────────

const PE_MAGIC = Buffer.from([0x4D, 0x5A]); // MZ
const PE_MACHINES = {
  0x014C: 'x86', 0x8664: 'x86_64', 0xAA64: 'AArch64',
};
const PE_SUBSYSTEMS = {
  1: 'native', 2: 'gui', 3: 'console', 7: 'posix',
  10: 'efi_application', 14: 'xbox',
};

// ─── ELF Parser ───────────────────────────────────────────────────────────

function parseELF(buffer, env = process.env) {
  if (buffer.length < 64 || !buffer.subarray(0, 4).equals(ELF_MAGIC)) {
    return null;
  }

  const is64 = buffer[4] === 2;
  const isLE = buffer[5] === 1;
  const read16 = isLE ? (o) => buffer.readUInt16LE(o) : (o) => buffer.readUInt16BE(o);
  const read32 = isLE ? (o) => buffer.readUInt32LE(o) : (o) => buffer.readUInt32BE(o);

  const machine = read16(18);
  const type = read16(16);

  const result = {
    format: 'ELF',
    bits: is64 ? 64 : 32,
    endian: isLE ? 'little' : 'big',
    architecture: ELF_MACHINES[machine] || `unknown(0x${machine.toString(16)})`,
    type: ELF_TYPES[type] || `unknown(${type})`,
    machine_id: machine,
    sections: [],
    dependencies: [],
    platform: 'linux',
  };

  // Walk section + program headers over untrusted offsets/counts. Any read past
  // the buffer end (crafted shoff/shentsize/phnum, truncated file) throws
  // RangeError; the guard degrades to the header already collected above instead
  // of crashing analyzeBinary. Gate off → rethrow (legacy byte-identical path).
  try {
  // Parse section headers for section names
  if (is64 && buffer.length >= 64) {
    const shoff = Number(buffer.readBigUInt64LE(40));
    const shentsize = read16(58);
    const shnum = read16(60);
    const shstrndx = read16(62);

    if (shoff > 0 && shoff + shnum * shentsize <= buffer.length) {
      // Read section string table
      let strtabOff = 0, strtabSize = 0;
      if (shstrndx < shnum) {
        const strSecOff = shoff + shstrndx * shentsize;
        strtabOff = Number(buffer.readBigUInt64LE(strSecOff + 24));
        strtabSize = Number(buffer.readBigUInt64LE(strSecOff + 32));
      }

      for (let i = 0; i < shnum && i < 64; i++) {
        const off = shoff + i * shentsize;
        if (off + shentsize > buffer.length) break;

        const nameIdx = read32(off);
        const sh_type = read32(off + 4);
        const sh_size = Number(buffer.readBigUInt64LE(off + 32));

        let name = `section_${i}`;
        if (strtabOff > 0 && nameIdx < strtabSize) {
          const end = buffer.indexOf(0, strtabOff + nameIdx);
          if (end > strtabOff + nameIdx) {
            name = buffer.toString('ascii', strtabOff + nameIdx, end);
          }
        }

        result.sections.push({ name, type: sh_type, size: sh_size });
      }
    }

    // Parse dynamic section for dependencies
    const phoff = Number(buffer.readBigUInt64LE(32));
    const phentsize = read16(54);
    const phnum = read16(56);

    // Find PT_DYNAMIC segment
    for (let i = 0; i < phnum; i++) {
      const off = phoff + i * phentsize;
      if (off + phentsize > buffer.length) break;
      const p_type = read32(off);
      if (p_type === 2) { // PT_DYNAMIC
        const dynOff = Number(buffer.readBigUInt64LE(off + 8));
        const dynSize = Number(buffer.readBigUInt64LE(off + 32));
        // Find DT_NEEDED entries (would need string table from PT_DYNAMIC)
        // Simplified: scan for common library patterns
        _findElfDeps(buffer, dynOff, dynSize, result);
        break;
      }
    }
  }
  } catch (err) {
    if (!binaryParseGuardEnabled(env)) throw err;
    // Guard on: malformed section/program headers → keep the parsed ELF header,
    // leave sections/dependencies as collected so far. Never throw.
  }

  return result;
}

function _findElfDeps(buffer, dynOff, dynSize, result) {
  // Find .dynstr section for string lookup
  let strtabAddr = 0;
  const needed = [];

  for (let i = 0; i < dynSize; i += 16) {
    const off = dynOff + i;
    if (off + 16 > buffer.length) break;
    const tag = Number(buffer.readBigInt64LE(off));
    const val = Number(buffer.readBigUInt64LE(off + 8));

    if (tag === 0) break; // DT_NULL
    if (tag === 5) strtabAddr = val; // DT_STRTAB
    if (tag === 1) needed.push(val); // DT_NEEDED (string offset)
  }

  // Try to resolve DT_NEEDED strings from loaded sections
  for (const sec of result.sections) {
    if (sec.name === '.dynstr') {
      // Find the section in the file
      // This is a simplification - in production you'd map vaddr → file offset
      break;
    }
  }

  // Fallback: scan binary for common .so names
  const soPattern = /lib[a-z0-9_-]+\.so[.\d]*/g;
  const text = buffer.toString('ascii', 0, Math.min(buffer.length, 1024 * 1024));
  const matches = text.match(soPattern);
  if (matches) {
    const unique = [...new Set(matches)];
    result.dependencies = unique.slice(0, 50);
  }
}

// ─── PE Parser ────────────────────────────────────────────────────────────

function parsePE(buffer, env = process.env) {
  if (buffer.length < 64 || !buffer.subarray(0, 2).equals(PE_MAGIC)) {
    return null;
  }

  const peOffset = buffer.readUInt32LE(60); // e_lfanew
  if (peOffset + 4 + 20 > buffer.length) return null;

  const peSig = buffer.readUInt32LE(peOffset);
  if (peSig !== 0x00004550) return null; // "PE\0\0"

  const coffOff = peOffset + 4;
  const machine = buffer.readUInt16LE(coffOff);
  const numSections = buffer.readUInt16LE(coffOff + 2);
  const optHeaderSize = buffer.readUInt16LE(coffOff + 16);

  const optOff = coffOff + 20;
  if (optOff + optHeaderSize > buffer.length) return null;

  const optMagic = buffer.readUInt16LE(optOff);
  const is64 = optMagic === 0x020B;

  const result = {
    format: 'PE',
    bits: is64 ? 64 : 32,
    endian: 'little',
    architecture: PE_MACHINES[machine] || `unknown(0x${machine.toString(16)})`,
    machine_id: machine,
    sections: [],
    dependencies: [],
    platform: 'windows',
    subsystem: 'unknown',
    entry_point: 0,
    image_base: 0,
  };

  // Walk optional header, data directories, imports and section headers over
  // untrusted offsets (data-directory RVAs, numSections, optHeaderSize). A
  // crafted/truncated PE can drive a read past the buffer end (e.g. numDirs>1
  // with a buffer ending at optOff+112). Guard degrades to the header parsed so
  // far instead of throwing. Gate off → rethrow (legacy byte-identical path).
  try {
  if (is64 && optOff + 112 <= buffer.length) {
    result.entry_point = buffer.readUInt32LE(optOff + 16);
    result.image_base = Number(buffer.readBigUInt64LE(optOff + 24));
    const subsystem = buffer.readUInt16LE(optOff + 68);
    result.subsystem = PE_SUBSYSTEMS[subsystem] || `unknown(${subsystem})`;

    // Data directories
    const numDirs = buffer.readUInt32LE(optOff + 108);

    // Parse import directory (index 1)
    if (numDirs > 1) {
      const importRVA = buffer.readUInt32LE(optOff + 112 + 8);
      const importSize = buffer.readUInt32LE(optOff + 112 + 12);

      if (importRVA > 0 && importSize > 0) {
        _findPEImports(buffer, importRVA, importSize, numSections,
                       coffOff, optHeaderSize, result);
      }
    }
  }

  // Parse section headers
  const secOff = optOff + optHeaderSize;
  for (let i = 0; i < numSections && i < 96; i++) {
    const off = secOff + i * 40;
    if (off + 40 > buffer.length) break;

    const name = buffer.toString('ascii', off, off + 8).replace(/\0/g, '');
    const virtualSize = buffer.readUInt32LE(off + 8);
    const characteristics = buffer.readUInt32LE(off + 36);

    const flags = [];
    if (characteristics & 0x20000000) flags.push('execute');
    if (characteristics & 0x40000000) flags.push('read');
    if (characteristics & 0x80000000) flags.push('write');

    result.sections.push({ name, size: virtualSize, flags });
  }
  } catch (err) {
    if (!binaryParseGuardEnabled(env)) throw err;
    // Guard on: malformed optional/section headers → keep the parsed PE header,
    // leave sections/dependencies as collected so far. Never throw.
  }

  return result;
}

function _findPEImports(buffer, importRVA, importSize, numSections,
                        coffOff, optHeaderSize, result) {
  // Convert RVA to file offset using section table
  const secOff = coffOff + 20 + optHeaderSize;
  let fileOff = 0;

  for (let i = 0; i < numSections; i++) {
    const off = secOff + i * 40;
    if (off + 40 > buffer.length) break;
    const va = buffer.readUInt32LE(off + 12);
    const rawSize = buffer.readUInt32LE(off + 16);
    const rawPtr = buffer.readUInt32LE(off + 20);

    if (importRVA >= va && importRVA < va + rawSize) {
      fileOff = rawPtr + (importRVA - va);
      break;
    }
  }

  if (fileOff === 0) return;

  // Read import descriptors (20 bytes each, null-terminated)
  for (let i = 0; i < 128; i++) {
    const descOff = fileOff + i * 20;
    if (descOff + 20 > buffer.length) break;

    const nameRVA = buffer.readUInt32LE(descOff + 12);
    if (nameRVA === 0) break;

    // Convert name RVA to file offset
    let nameFileOff = 0;
    for (let s = 0; s < numSections; s++) {
      const soff = secOff + s * 40;
      if (soff + 40 > buffer.length) break;
      const va = buffer.readUInt32LE(soff + 12);
      const rawSize = buffer.readUInt32LE(soff + 16);
      const rawPtr = buffer.readUInt32LE(soff + 20);

      if (nameRVA >= va && nameRVA < va + rawSize) {
        nameFileOff = rawPtr + (nameRVA - va);
        break;
      }
    }

    if (nameFileOff > 0 && nameFileOff < buffer.length) {
      const end = buffer.indexOf(0, nameFileOff);
      const dllName = buffer.toString('ascii', nameFileOff,
        Math.min(end > nameFileOff ? end : nameFileOff + 64, buffer.length));
      if (dllName.length > 0 && dllName.length < 128) {
        result.dependencies.push(dllName);
      }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Analyze a binary file and return structured information.
 * @param {string} filePath — Path to the binary file
 * @returns {object} Analysis result with format, architecture, dependencies, etc.
 */
async function analyzeBinary(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return { error: `File not found: ${resolvedPath}` };
  }

  const stats = fs.statSync(resolvedPath);
  if (stats.size > 100 * 1024 * 1024) {
    return { error: 'File too large (>100MB)' };
  }

  const buffer = fs.readFileSync(resolvedPath);

  // Try ELF first, then PE
  let result = parseELF(buffer);
  if (!result) result = parsePE(buffer);
  if (!result) {
    return {
      error: 'Unknown binary format',
      magic: buffer.subarray(0, 4).toString('hex'),
      size: stats.size,
    };
  }

  result.file = resolvedPath;
  result.fileSize = stats.size;

  // Cross-platform compatibility assessment
  result.compatibility = assessCompatibility(result);

  return result;
}

/**
 * Assess cross-platform compatibility of a binary.
 */
function assessCompatibility(analysis) {
  const compat = {
    nativePlatform: analysis.platform,
    canRunOn: {},
    issues: [],
  };

  if (analysis.format === 'ELF') {
    compat.canRunOn.linux = true;
    compat.canRunOn.macos = analysis.architecture === 'AArch64' || analysis.architecture === 'x86_64';
    compat.canRunOn.windows = false;

    // Check for platform-specific dependencies
    const linuxOnly = ['libsystemd', 'libpam', 'libudev'];
    for (const dep of analysis.dependencies) {
      for (const lo of linuxOnly) {
        if (dep.includes(lo)) {
          compat.issues.push({
            severity: 'error',
            message: `Linux-specific dependency: ${dep}`,
          });
          compat.canRunOn.macos = false;
        }
      }
    }
  }

  if (analysis.format === 'PE') {
    compat.canRunOn.windows = true;
    compat.canRunOn.linux = false;
    compat.canRunOn.macos = false;

    // Check for WINE compatibility hints
    const wineSupported = ['kernel32.dll', 'user32.dll', 'gdi32.dll',
      'advapi32.dll', 'msvcrt.dll', 'ntdll.dll', 'shell32.dll'];
    const unsupported = analysis.dependencies.filter(
      d => !wineSupported.some(w => d.toLowerCase() === w));

    if (unsupported.length === 0) {
      compat.canRunOn.linux = true; // Likely works under WINE
      compat.issues.push({
        severity: 'info',
        message: 'All DLL imports are WINE-compatible',
      });
    } else {
      compat.issues.push({
        severity: 'warning',
        message: `Potentially unsupported DLLs: ${unsupported.join(', ')}`,
      });
    }

    // KHY OS compatibility check
    const khySupported = ['kernel32.dll'];
    const khyUnsupported = analysis.dependencies.filter(
      d => !khySupported.some(w => d.toLowerCase() === w));
    if (khyUnsupported.length > 0) {
      compat.issues.push({
        severity: 'warning',
        message: `KHY OS wincompat layer does not support: ${khyUnsupported.join(', ')}`,
      });
    }
  }

  return compat;
}

/**
 * Compare two binaries for platform portability.
 */
async function compareBinaries(pathA, pathB) {
  const [a, b] = await Promise.all([analyzeBinary(pathA), analyzeBinary(pathB)]);

  return {
    fileA: a,
    fileB: b,
    sameArchitecture: a.architecture === b.architecture,
    sameFormat: a.format === b.format,
    samePlatform: a.platform === b.platform,
    sharedDependencies: (a.dependencies || []).filter(
      d => (b.dependencies || []).includes(d)),
  };
}

module.exports = {
  analyzeBinary,
  compareBinaries,
  assessCompatibility,
  parseELF,
  parsePE,
  binaryParseGuardEnabled,
};
