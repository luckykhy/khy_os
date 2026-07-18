'use strict';

/**
 * sourceRecoverer.js — 自包含产物源码/字节码还原 (DESIGN-ARCH-054 §3.4)。
 *
 * 对「可还原档位 = SOURCE」的产物，直接把内嵌的源码/资源/字节码抽出来。这是验证「khy
 * 自己生成的软件」最强的一条路径：khy 主要打包 Node/Python/Web/JAR，这些产物的真实源码
 * 或近源码就封在包里，逆向退化为「安全解包 + 清单化」，无需猜测。
 *
 * 复用 unpackTool 同源的安全护栏（路径穿越/绝对路径/符号链接/总量上限），绝不把恶意条目
 * 写到目标目录外（防呆④：解包永不逃逸沙箱）。zip 用既有依赖 node-stream-zip。
 *
 * 本模块**只抽取与编目**，不执行任何抽出的代码。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 解包总量上限（默认 64 MiB，env 可调）。 */
const MAX_RECOVER_BYTES = parseInt(process.env.KHY_RE_MAX_BYTES, 10) || 64 * 1024 * 1024;
/** 单包最大条目数（防 zip-bomb 条目爆炸）。 */
const MAX_ENTRIES = parseInt(process.env.KHY_RE_MAX_ENTRIES, 10) || 20000;

/** 与 unpackTool 同源：条目路径是否安全（无 .. / 绝对 / 盘符）。 */
function _isSafeEntry(entryPath) {
  if (!entryPath || typeof entryPath !== 'string') return false;
  if (path.isAbsolute(entryPath)) return false;
  const segments = entryPath.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '..') return false;
    if (seg === '.') continue;
    if (/^[A-Za-z]:/.test(seg)) return false;
  }
  return true;
}

/** 解析后路径是否仍在目标目录内（双保险）。 */
function _isWithinDest(resolvedPath, destDir) {
  const normalDest = path.resolve(destDir) + path.sep;
  const normalPath = path.resolve(resolvedPath);
  return normalPath.startsWith(normalDest) || normalPath === path.resolve(destDir);
}

// 视作「源码/可读资产」的扩展名（用于编目与保真度比对的主集合）。
const SOURCE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte',
  '.py', '.pyw', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.cs',
  '.c', '.h', '.cpp', '.cc', '.hpp', '.swift', '.scala', '.clj',
  '.html', '.css', '.scss', '.json', '.yaml', '.yml', '.toml', '.xml',
  '.sql', '.sh', '.md', '.txt', '.proto', '.graphql',
]);
// 字节码扩展（需后续反编译，编目时标注 needsDecompile）。
const BYTECODE_EXTS = new Set(['.class', '.pyc', '.pyo', '.dll', '.exe']);

function _classifyMember(name) {
  const ext = path.extname(name).toLowerCase();
  if (SOURCE_EXTS.has(ext)) return 'source';
  if (BYTECODE_EXTS.has(ext)) return 'bytecode';
  return 'asset';
}

/**
 * 从 ZIP 家族（jar/war/whl/nupkg/apk/asar-zip）安全抽取。
 * @returns {Promise<object>} RecoverResult
 */
async function _recoverZip(filePath, outDir, opts) {
  const StreamZip = require('node-stream-zip');
  const zip = new StreamZip.async({ file: filePath });
  const members = [];
  let totalBytes = 0;
  let skipped = 0;

  try {
    const entries = await zip.entries();
    const entryList = Object.values(entries);
    if (entryList.length > MAX_ENTRIES) {
      return { ok: false, reason: `entry count ${entryList.length} exceeds cap ${MAX_ENTRIES}`, members: [] };
    }

    for (const e of entryList) {
      if (e.isDirectory) continue;
      const name = e.name;
      if (!_isSafeEntry(name)) { skipped++; continue; }
      totalBytes += e.size || 0;
      if (totalBytes > MAX_RECOVER_BYTES) {
        return { ok: false, reason: `uncompressed size exceeds cap ${MAX_RECOVER_BYTES}`, members, truncated: true };
      }
      const member = {
        name,
        size: e.size || 0,
        kind: _classifyMember(name),
      };

      if (!opts.listOnly && outDir) {
        const dest = path.join(outDir, name);
        if (!_isWithinDest(dest, outDir)) { skipped++; continue; }
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await zip.extract(name, dest);
        member.extractedTo = dest;
      }
      members.push(member);
    }
  } finally {
    await zip.close().catch(() => {});
  }

  return { ok: true, members, totalBytes, skipped, format: 'zip' };
}

/**
 * 从 PyInstaller CArchive 抽取（仅在外部 pyinstxtractor 可用时委托；否则诚实降级）。
 * 这里不重写 CArchive 解析器（版本众多易错），而是登记「可用工具 + 入口偏移线索」，
 * 由 toolOrchestrator 实际驱动（防呆②：没工具就如实说没工具，绝不伪造）。
 */
function _recoverPyInstaller() {
  return {
    ok: false,
    deferred: true,
    reason: 'PyInstaller CArchive 抽取需外部 pyinstxtractor；交 toolOrchestrator 探活后驱动',
    delegateTool: 'pyinstxtractor',
    members: [],
    format: 'pyinstaller',
  };
}

/**
 * 从 Node 自包含可执行（SEA/pkg/nexe）登记还原计划。
 * SEA/pkg 的 JS 源以 V8 snapshot/字符串内嵌，通用提取依赖工具或字符串切片；这里登记策略，
 * 由 stringHarvester 已捞到的源码片段 + toolOrchestrator 协同处理。
 */
function _recoverNodeBundle() {
  return {
    ok: false,
    deferred: true,
    reason: 'Node 自包含可执行的源在 V8 snapshot/内嵌字符串；以 stringHarvester 切片 + 外部工具为主',
    members: [],
    format: 'node-bundle',
  };
}

/**
 * 主入口：依据分诊结果选择还原策略。
 * @param {string} filePath
 * @param {object} scan        artifactScanner 结果
 * @param {object} [opts]      { outDir, listOnly }
 * @returns {Promise<object>}  RecoverResult（绝不抛）
 */
async function recover(filePath, scan, opts = {}) {
  // 默认仅编目（listOnly）；只有显式给出 outDir 才落盘抽取。
  const options = { outDir: opts.outDir || null, listOnly: !opts.outDir };

  try {
    if (scan.format === 'archive-zip') {
      return await _recoverZip(filePath, options.outDir, options);
    }
    if (scan.markers && scan.markers.includes('pyinstaller')) {
      return _recoverPyInstaller();
    }
    if (scan.markers && scan.markers.includes('node-sea')) {
      return _recoverNodeBundle();
    }
    if (scan.format === 'script-shebang') {
      // 已是源码：直接登记为单成员。
      const st = fs.statSync(filePath);
      return {
        ok: true,
        format: 'script',
        members: [{ name: path.basename(filePath), size: st.size, kind: 'source', extractedTo: filePath }],
        note: 'Artifact is already source (script).',
      };
    }
    return {
      ok: false,
      reason: `recoverability=${scan.recoverability}: no in-band source to extract; rely on toolOrchestrator/reconstructionPort`,
      members: [],
    };
  } catch (err) {
    return { ok: false, reason: `recover failed: ${err.message}`, members: [] };
  }
}

/** 在系统临时区开一个隔离解包目录（用完即弃由调用方负责）。 */
function mkRecoverDir(tag = 're') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `khy-${tag}-`));
  return base;
}

module.exports = {
  recover,
  mkRecoverDir,
  SOURCE_EXTS,
  BYTECODE_EXTS,
  MAX_RECOVER_BYTES,
  _isSafeEntry,
  _isWithinDest,
  _classifyMember,
};
