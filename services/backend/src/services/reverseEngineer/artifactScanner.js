'use strict';

/**
 * artifactScanner.js — 只读制品分诊 (DESIGN-ARCH-054 §3.2)。
 *
 * 输入一个产物文件路径，输出「它是什么」的确定性事实：格式、家族、可还原档位、架构、
 * 大小、SHA-256、嵌入工具链标记。全程**只读字节，绝不执行**被分析的二进制（防呆①：
 * 逆向分析永不运行不可信制品）。零模型——这一层是纯确定性证据采集。
 *
 * 匹配逻辑集中在此，签名声明集中在 formatRegistry，二者分离（数据/代码分离）。
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const registry = require('./formatRegistry');

/** 读头部用于签名匹配的字节数（覆盖最深签名 tar@257 + 余量）。 */
const HEADER_BYTES = 512;
/** 扫描嵌入标记时读取的尾部字节数（PyInstaller cookie 等在文件尾）。 */
const TAIL_BYTES = 64 * 1024;
/** 扫描嵌入标记时读取的头部字节数（.NET/Go/Rust 标记多在前段）。 */
const MARKER_HEAD_BYTES = 256 * 1024;

/** 单个签名条目是否在 buffer 指定偏移命中。 */
function _matchSignature(buf, sig) {
  if (!sig || !Buffer.isBuffer(sig.bytes)) return false;
  const end = sig.offset + sig.bytes.length;
  if (buf.length < end) return false;
  return buf.compare(sig.bytes, 0, sig.bytes.length, sig.offset, end) === 0;
}

/**
 * cafebabe 撞号消歧：Java class vs macOS fat/universal Mach-O。
 * Java class：cafebabe 后接 2 字节 minor + 2 字节 major(>=0x2D≈JDK1.1 起)。
 * Mach-O fat：cafebabe 后接 4 字节 nfat_arch（架构数，通常很小，1~8）。
 * 判据：major 版本字节(offset 6-7)落在合理 class 区间 → class；否则按 fat-macho。
 */
function _disambiguateCafebabe(buf) {
  if (buf.length < 8) return 'java-class';
  const major = buf.readUInt16BE(6);
  // Java class major: 45 (JDK1.1) ~ 70+ (现代)。fat-macho 此处是 nfat_arch，通常 <16。
  if (major >= 45 && major <= 200) return 'java-class';
  return 'macho';
}

/** 从 ELF/PE/Mach-O 头粗提架构与位宽（仅头部确定性字段，不反汇编）。 */
function _detectArch(formatId, buf) {
  try {
    if (formatId === 'elf' && buf.length >= 20) {
      const cls = buf[4] === 2 ? 64 : buf[4] === 1 ? 32 : 0;
      const little = buf[5] === 1;
      const machine = buf.readUInt16LE(18); // e_machine (LE 常见)
      const MACHINE = { 0x3e: 'x86-64', 0x03: 'x86', 0xb7: 'arm64', 0x28: 'arm', 0xf3: 'riscv' };
      return { bits: cls, endian: little ? 'little' : 'big', arch: MACHINE[machine] || `machine:${machine}` };
    }
    if (formatId === 'pe' && buf.length >= 0x40) {
      // PE: e_lfanew at 0x3C → COFF Machine 2 字节
      const peOff = buf.readUInt32LE(0x3c);
      if (peOff + 6 <= buf.length && buf.toString('ascii', peOff, peOff + 4) === 'PE\0\0') {
        const machine = buf.readUInt16LE(peOff + 4);
        const MACHINE = { 0x8664: 'x86-64', 0x14c: 'x86', 0xaa64: 'arm64', 0x1c0: 'arm' };
        return { bits: machine === 0x8664 || machine === 0xaa64 ? 64 : 32, arch: MACHINE[machine] || `machine:${machine}` };
      }
    }
    if (formatId === 'macho' && buf.length >= 8) {
      const m32 = buf.readUInt32BE(0);
      const bits = (m32 === 0xfeedfacf || m32 === 0xcffaedfe) ? 64 : 32;
      return { bits, arch: 'macho' };
    }
  } catch { /* 头部畸形：架构留空，绝不抛 */ }
  return {};
}

/**
 * 同步分诊（小文件/测试友好）。返回事实对象，绝不抛——畸形/不可读也降级为 unknown。
 * @param {string} filePath
 * @returns {object} ScanResult
 */
function scanFileSync(filePath) {
  const result = {
    path: filePath,
    exists: false,
    sizeBytes: 0,
    sha256: null,
    format: 'unknown',
    family: 'unknown',
    recoverability: registry.RECOVERABILITY.UNKNOWN,
    label: 'Unknown / opaque bytes',
    ext: path.extname(filePath || '').toLowerCase(),
    arch: {},
    markers: [],     // 命中的嵌入标记 id 列表
    candidateTools: [],
    note: '',
  };

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return result; // 不存在/不可读：exists=false
  }
  if (!stat.isFile()) return result;
  result.exists = true;
  result.sizeBytes = stat.size;

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return result;
  }

  try {
    // SHA-256（流式，避免大文件全量入内存）。
    try {
      const hash = crypto.createHash('sha256');
      const CHUNK = 1 << 20;
      const tmp = Buffer.allocUnsafe(CHUNK);
      let pos = 0;
      let n;
      while ((n = fs.readSync(fd, tmp, 0, CHUNK, pos)) > 0) {
        hash.update(tmp.subarray(0, n));
        pos += n;
      }
      result.sha256 = hash.digest('hex');
    } catch { /* 哈希失败不致命 */ }

    // 头部签名匹配。
    const head = Buffer.alloc(Math.min(HEADER_BYTES, stat.size || HEADER_BYTES));
    const headN = fs.readSync(fd, head, 0, head.length, 0);
    const headBuf = head.subarray(0, headN);

    let matched = null;
    for (const fmt of registry.FORMATS) {
      if (fmt.signatures.some((s) => _matchSignature(headBuf, s))) {
        matched = fmt;
        break;
      }
    }

    if (matched) {
      let fmtId = matched.id;
      // cafebabe 撞号消歧。
      if (headBuf.length >= 4 && headBuf.readUInt32BE(0) === 0xcafebabe) {
        const which = _disambiguateCafebabe(headBuf);
        fmtId = which;
      }
      const fmt = registry.getById(fmtId) || matched;
      result.format = fmt.id;
      result.family = fmt.family;
      result.recoverability = fmt.recoverability;
      result.label = fmt.label;
      result.note = fmt.note || '';
      result.arch = _detectArch(fmt.id, headBuf);
      result.candidateTools = registry.candidateTools(fmt.id);
    }

    // 嵌入标记扫描：读头部 + 尾部窗口，匹配 .NET / PyInstaller / Node / Go / Rust。
    const markerBufs = [];
    {
      const hb = Buffer.alloc(Math.min(MARKER_HEAD_BYTES, stat.size));
      const hn = fs.readSync(fd, hb, 0, hb.length, 0);
      markerBufs.push(hb.subarray(0, hn));
      if (stat.size > MARKER_HEAD_BYTES) {
        const tStart = Math.max(0, stat.size - TAIL_BYTES);
        const tb = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
        const tn = fs.readSync(fd, tb, 0, tb.length, tStart);
        markerBufs.push(tb.subarray(0, tn));
      }
    }
    for (const marker of registry.EMBEDDED_MARKERS) {
      if (marker.appliesTo && marker.appliesTo !== 'any' && marker.appliesTo !== result.format) continue;
      const probes = [marker.contentMarker, ...(marker.altMarkers || [])].filter(Buffer.isBuffer);
      const hit = markerBufs.some((b) => probes.some((p) => b.includes(p)));
      if (hit) {
        result.markers.push(marker.id);
        // 嵌入标记可升级可还原档位（如裸 ELF + PyInstaller → SOURCE）。
        if (marker.recoverability && _isStrongerRecoverability(marker.recoverability, result.recoverability)) {
          result.recoverability = marker.recoverability;
          result.family = marker.family;
          result.label = `${result.label} · ${marker.label}`;
        }
        result.candidateTools = Array.from(new Set([...result.candidateTools, ...(marker.tools || [])]));
      }
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* noop */ }
  }

  return result;
}

/** SOURCE > BYTECODE > NATIVE > ARCHIVE > UNKNOWN 的强弱比较（嵌入标记可升级档位）。 */
const _RANK = { source: 4, bytecode: 3, native: 2, archive: 1, unknown: 0 };
function _isStrongerRecoverability(a, b) {
  return (_RANK[a] || 0) > (_RANK[b] || 0);
}

/** 异步包装（统一对外异步契约；内部委托同步实现，绝不抛）。 */
async function scanFile(filePath) {
  return scanFileSync(filePath);
}

module.exports = {
  scanFile,
  scanFileSync,
  HEADER_BYTES,
  // 暴露给单测的内部判定。
  _disambiguateCafebabe,
  _isStrongerRecoverability,
};
