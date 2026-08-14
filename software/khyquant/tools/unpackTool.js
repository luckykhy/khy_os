'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineTool } = require('./_baseTool');

const _expandPath = require('../utils/expandEnvPath');

// ── Security: path traversal + symlink + size guard (DeepSeek-TUI aligned) ──

/** Max total uncompressed size (10 MiB default, env override KHY_UNPACK_MAX_BYTES). */
const MAX_UNPACK_BYTES = parseInt(process.env.KHY_UNPACK_MAX_BYTES, 10) || 10 * 1024 * 1024;

// ── Self-remediation gates (generic-extractor fallback + gated auto-install) ──
//
// 「遇到未知格式时 khy 自己想办法解决」：内建认不出的归档/压缩格式(.7z/.rar/.bz2/
// .xz/.zst/.cab/.iso/.deb/.rpm…)不再直接判 Unsupported，而是回退到机器上已装的通用
// 解包器(7z/bsdtar/unar)。这层默认开；门关 → detectGenericFormat 短路，逐字节回退到
// 旧的「Unsupported archive format」行为。
function _genericFallbackEnabled() {
  const v = String(process.env.KHY_UNPACK_GENERIC || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

// 装解包器是「在用户机器上装软件」的动系统动作，对齐红线「禁止 AI 擅自动手」：默认**关**
// (opt-in，仅 1/true/on/yes 开)，且额外要求本次调用显式 install:true(模型须先在对话里
// 征询用户点头才传该参数)。二者同时满足才代为安装并重试；否则只回精确安装命令「指路」。
function _autoInstallEnabled() {
  const v = String(process.env.KHY_UNPACK_AUTO_INSTALL || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Check if a path is safe (no traversal, no absolute, no symlinks).
 * Rejects: '..', absolute paths, Windows prefix components.
 */
function _isSafePath(entryPath) {
  if (!entryPath || typeof entryPath !== 'string') return false;
  if (path.isAbsolute(entryPath)) return false;
  const segments = entryPath.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '..') return false;
    if (seg === '.') continue; // allow './' prefix
    // Windows: reject drive letters like C:
    if (/^[A-Za-z]:/.test(seg)) return false;
  }
  return true;
}

/**
 * Validate that a resolved path stays within the intended destination.
 */
function _isWithinDest(resolvedPath, destDir) {
  const normalDest = path.resolve(destDir) + path.sep;
  const normalPath = path.resolve(resolvedPath);
  return normalPath.startsWith(normalDest) || normalPath === path.resolve(destDir);
}

// ── ZIP extraction (uses node-stream-zip, already a dependency) ──

async function _extractZip(zipPath, outputDir, listOnly) {
  const StreamZip = require('node-stream-zip');
  const zip = new StreamZip.async({ file: zipPath });

  try {
    const entries = await zip.entries();
    const entryList = Object.values(entries);

    // Security: validate all entries before extraction
    let totalUncompressed = 0;
    for (const e of entryList) {
      if (!_isSafePath(e.name)) {
        throw new Error(`Path traversal rejected: ${e.name}`);
      }
      if (e.isSymbolicLink) {
        throw new Error(`Symlink rejected: ${e.name}`);
      }
      totalUncompressed += e.size || 0;
    }
    if (totalUncompressed > MAX_UNPACK_BYTES) {
      throw new Error(`Archive too large: ${(totalUncompressed / 1024 / 1024).toFixed(1)} MiB exceeds ${(MAX_UNPACK_BYTES / 1024 / 1024).toFixed(0)} MiB limit`);
    }

    if (listOnly) {
      const items = entryList
        .filter(e => !e.isDirectory)
        .map(e => ({ name: e.name, size: e.size }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        format: 'zip',
        totalFiles: items.length,
        totalSize: items.reduce((s, e) => s + e.size, 0),
        entries: items.slice(0, 200),
        truncated: items.length > 200,
      };
    }

    fs.mkdirSync(outputDir, { recursive: true });
    await zip.extract(null, outputDir);

    // Post-extraction: verify all files are within outputDir
    const _verifyDir = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (!_isWithinDest(full, outputDir)) {
          throw new Error(`Extracted file escaped destination: ${full}`);
        }
        // Reject symlinks that were created during extraction
        if (e.isSymbolicLink()) {
          fs.unlinkSync(full);
        }
        if (e.isDirectory()) _verifyDir(full);
      }
    };
    _verifyDir(outputDir);

    // Detect single-root structure and unwrap if needed
    const topLevel = fs.readdirSync(outputDir);
    let finalDir = outputDir;
    if (topLevel.length === 1) {
      const single = path.join(outputDir, topLevel[0]);
      if (fs.statSync(single).isDirectory()) {
        finalDir = single;
      }
    }

    return {
      format: 'zip',
      outputDir: finalDir,
      totalFiles: entryList.filter(e => !e.isDirectory).length,
    };
  } finally {
    await zip.close();
  }
}

// ── TAR / TAR.GZ / TGZ extraction (uses shell tar command) ──

async function _extractTar(tarPath, outputDir, listOnly) {
  const { execFile } = require('child_process');
  const { searchExecutable } = require('./platformUtils');

  if (!searchExecutable('tar')) {
    throw new Error(process.platform === 'win32'
      ? 'tar 命令未找到。需要 Windows 10 1803+ 或安装 Git for Windows。'
      : 'tar 命令未找到。请安装: sudo apt install tar');
  }

  if (listOnly) {
    const args = ['-tf', tarPath];
    return new Promise((resolve, reject) => {
      execFile('tar', args, { maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error(`tar list failed: ${err.message}`));
        const items = stdout.trim().split('\n').filter(Boolean)
          .filter(e => !e.endsWith('/'))
          .map(name => ({ name, size: 0 }));
        resolve({
          format: 'tar',
          totalFiles: items.length,
          entries: items.slice(0, 200),
          truncated: items.length > 200,
        });
      });
    });
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const args = ['-xf', tarPath, '-C', outputDir];
  return new Promise((resolve, reject) => {
    execFile('tar', args, { maxBuffer: 2 * 1024 * 1024 }, (err) => {
      if (err) return reject(new Error(`tar extract failed: ${err.message}`));
      let fileCount = 0;
      try {
        const countFiles = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) countFiles(path.join(dir, e.name));
            else fileCount++;
          }
        };
        countFiles(outputDir);
      } catch { /* best effort */ }
      resolve({ format: 'tar', outputDir, totalFiles: fileCount });
    });
  });
}

// ── GZ extraction (single file, uses Node.js built-in zlib) ──

async function _extractGz(gzPath, outputDir, listOnly) {
  const zlib = require('zlib');
  const baseName = path.basename(gzPath, '.gz');

  if (listOnly) {
    const stat = fs.statSync(gzPath);
    return {
      format: 'gz',
      totalFiles: 1,
      entries: [{ name: baseName, size: stat.size }],
      truncated: false,
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, baseName);
  const input = fs.createReadStream(gzPath);
  const gunzip = zlib.createGunzip();
  const output = fs.createWriteStream(outPath);

  return new Promise((resolve, reject) => {
    input.pipe(gunzip).pipe(output);
    output.on('finish', () => resolve({
      format: 'gz',
      outputDir,
      totalFiles: 1,
      outputFile: outPath,
    }));
    output.on('error', reject);
    gunzip.on('error', reject);
    input.on('error', reject);
  });
}

// ── ASAR extraction (Electron custom container, native parser — NOT zip) ──

// asar 是 Electron 自定义容器（非 zip，无 PK 魔数），node-stream-zip 读不了。
// asarArchive 叶只解析头（size pickle + header pickle 的 JSON 树 + 文件区基址），
// 这里按 {offset,size} 从数据区切出字节写盘，复用 zip 那套 _isSafePath/_isWithinDest/
// MAX_UNPACK_BYTES 安全护栏。`unpacked:true` 成员不在归档内，存在同级
// `<archive>.unpacked/`；符号链接（info.link）一律跳过不落盘（不在磁盘造 symlink）。
async function _extractAsar(asarPath, outputDir, listOnly) {
  const { parseHeaderSize, parseHeader, flattenEntries } = require('../services/reverseEngineer/asarArchive');

  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(8);
    if (fs.readSync(fd, head, 0, 8, 0) < 8) throw new Error('不是有效的 asar 归档：文件过短');
    const headerSize = parseHeaderSize(head);
    if (headerSize == null) throw new Error('不是有效的 asar 归档：头长度字段畸形');

    const headerBuf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuf, 0, headerSize, 8) < headerSize) {
      throw new Error('不是有效的 asar 归档：头部读取不完整');
    }
    const parsed = parseHeader(headerBuf, headerSize);
    if (!parsed) throw new Error('不是有效的 asar 归档：头部 JSON 解析失败');

    const allEntries = flattenEntries(parsed.header);
    const files = allEntries.filter(e => e.type === 'file');

    // Security: validate every path before doing anything on disk.
    for (const e of files) {
      if (!_isSafePath(e.path)) throw new Error(`Path traversal rejected: ${e.path}`);
    }
    const packed = files.filter(e => !e.unpacked);
    const totalSize = packed.reduce((s, e) => s + (e.size || 0), 0);

    if (listOnly) {
      const items = files
        .map(e => ({ name: e.path, size: e.size || 0 }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        format: 'asar',
        totalFiles: items.length,
        totalSize: items.reduce((s, e) => s + e.size, 0),
        entries: items.slice(0, 200),
        truncated: items.length > 200,
      };
    }

    if (totalSize > MAX_UNPACK_BYTES) {
      throw new Error(`Archive too large: ${(totalSize / 1024 / 1024).toFixed(1)} MiB exceeds ${(MAX_UNPACK_BYTES / 1024 / 1024).toFixed(0)} MiB limit`);
    }

    fs.mkdirSync(outputDir, { recursive: true });
    const unpackedRoot = `${asarPath}.unpacked`;
    let written = 0;
    for (const e of files) {
      const destPath = path.join(outputDir, e.path);
      if (!_isWithinDest(destPath, outputDir)) {
        throw new Error(`Extracted file escaped destination: ${e.path}`);
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      if (e.unpacked) {
        // Lives in the sibling <archive>.unpacked/ tree, not inside the container.
        const src = path.join(unpackedRoot, e.path);
        if (fs.existsSync(src)) { fs.copyFileSync(src, destPath); written++; }
        continue;
      }
      if (e.offset == null) continue; // fail-closed: skip malformed entry, never fabricate bytes
      const buf = Buffer.alloc(e.size || 0);
      if (e.size > 0) fs.readSync(fd, buf, 0, e.size, parsed.dataOffset + e.offset);
      fs.writeFileSync(destPath, buf);
      written++;
    }

    return { format: 'asar', outputDir, totalFiles: written };
  } finally {
    fs.closeSync(fd);
  }
}

// ── GENERIC fallback (external extractor: 7z / bsdtar / unar — self-remediation) ──

const genericExtractor = require('../services/reverseEngineer/genericExtractor');

/**
 * Post-extraction security walk for the generic path (mirrors _extractZip's inline
 * verify): reject any file that escaped outputDir, strip symlinks created during
 * extraction. fail-closed — throws on escape.
 */
function _verifyNoEscape(dir, outputDir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (!_isWithinDest(full, outputDir)) {
      throw new Error(`Extracted file escaped destination: ${full}`);
    }
    if (e.isSymbolicLink()) { fs.unlinkSync(full); continue; }
    if (e.isDirectory()) _verifyNoEscape(full, outputDir);
  }
}

/** Sum regular-file bytes under a tree (post-extraction size guard). */
function _sumTreeSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += _sumTreeSize(full);
    else if (e.isFile()) { try { total += fs.statSync(full).size; } catch { /* best effort */ } }
  }
  return total;
}

/** Count regular files under a tree. */
function _countTreeFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += _countTreeFiles(path.join(dir, e.name));
    else if (e.isFile()) n++;
  }
  return n;
}

/** Render the "no extractor installed — here's how" guidance (the "指路" path). */
function _formatInstallGuidance(fmt, inst, autoInstallHint) {
  const lines = [];
  lines.push(`格式 ${fmt} 需要通用解包器（7z / bsdtar / unar），但本机未找到。`);
  if (inst.command) {
    lines.push('', `安装命令（已探测到 ${inst.manager}）：`, `  ${inst.command}`);
  } else if (inst.options && inst.options.length) {
    lines.push('', '按平台任选其一安装：');
    for (const opt of inst.options) lines.push(`  ${opt}`);
  }
  if (autoInstallHint) {
    lines.push('', autoInstallHint);
  } else {
    lines.push('', '装好后重跑 unpack 即可。');
  }
  return lines.join('\n');
}

/**
 * Generic-extractor path: try a system extractor for a format the built-in
 * handlers don't cover. On missing extractor, either return install guidance
 * ("指路") or — only when the auto-install gate is on AND the caller passed
 * install:true — run the platform install command once and retry.
 */
async function _extractGeneric(archivePath, outputDir, listOnly, params) {
  const fmt = genericExtractor.detectGenericFormat(archivePath);
  let picked = genericExtractor.pickExtractor(fmt);

  if (!picked) {
    const inst = genericExtractor.buildInstallCommand(fmt);
    const mayInstall = _autoInstallEnabled() && params && params.install === true && !!inst.command;
    if (!mayInstall) {
      const hint = inst.command
        ? '要 khy 代为安装，请在确认后带 install:true 重试（需 KHY_UNPACK_AUTO_INSTALL=1）。'
        : null;
      return { __unremediable: true, message: _formatInstallGuidance(fmt, inst, hint) };
    }
    // Gated + explicitly authorized install, then retry once.
    const installed = await _runInstall(inst.command);
    if (!installed.ok) {
      return { __unremediable: true, message: `安装失败：${installed.error}\n可手动执行：\n  ${inst.command}` };
    }
    picked = genericExtractor.pickExtractor(fmt);
    if (!picked) {
      return { __unremediable: true, message: `安装命令已执行但仍未探测到可用解包器。请检查：\n  ${inst.command}` };
    }
  }

  if (listOnly) {
    const r = await genericExtractor.listWith(picked.kind, picked.bin, archivePath);
    if (!r.ok) throw new Error(`列举失败 (${picked.bin}): ${r.error}`);
    const items = (r.entries || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    return {
      format: `${fmt.slice(1)} via ${picked.kind}`,
      totalFiles: items.length,
      totalSize: items.reduce((s, e) => s + (e.size || 0), 0),
      entries: items.slice(0, 200),
      truncated: items.length > 200,
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const r = await genericExtractor.extractWith(picked.kind, picked.bin, archivePath, outputDir);
  if (!r.ok) throw new Error(`解包失败 (${picked.bin}): ${r.error}`);

  // Post-extraction security + size guard (external tools bypass our per-entry checks).
  _verifyNoEscape(outputDir, outputDir);
  const total = _sumTreeSize(outputDir);
  if (total > MAX_UNPACK_BYTES) {
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new Error(`Archive too large: ${(total / 1024 / 1024).toFixed(1)} MiB exceeds ${(MAX_UNPACK_BYTES / 1024 / 1024).toFixed(0)} MiB limit`);
  }

  return { format: `${fmt.slice(1)} via ${picked.kind}`, outputDir, totalFiles: _countTreeFiles(outputDir) };
}

/** Run a shell install command (system-modifying; only reached under the auto-install gate + explicit consent). */
function _runInstall(command) {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    try {
      exec(command, { timeout: 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err) => {
        if (err) return resolve({ ok: false, error: (err.stderr || err.message || String(err)).slice(0, 2000) });
        resolve({ ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

// ── Format detection ── A Python wheel
// (.whl), Python egg (.egg), Java jar/war/ear, Android apk, NuGet .nupkg, browser
// extension .xpi / .vsix are all standard ZIP archives — node-stream-zip reads
// them by central directory regardless of extension, so detecting them as 'zip'
// lets `unpack` handle them directly instead of failing with "Unsupported format".
const ZIP_FAMILY_EXT = [
  '.zip', '.whl', '.egg', '.jar', '.war', '.ear', '.apk', '.nupkg', '.xpi', '.vsix',
];

function _detectFormat(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.asar')) return 'asar'; // Electron container — native parser, NOT zip
  if (ZIP_FAMILY_EXT.some(ext => lower.endsWith(ext))) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar';
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tar.xz') || lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.gz')) return 'gz';
  // Self-remediation fallback: a format the built-in handlers don't cover but a
  // system extractor (7z/bsdtar/unar) can. Gate off → byte-revert to null.
  if (_genericFallbackEnabled() && genericExtractor.detectGenericFormat(lower)) return 'generic';
  return null;
}

function _defaultOutputDir(filePath) {
  const dir = path.dirname(filePath);
  let base = path.basename(filePath);
  // Strip all archive extensions
  base = base.replace(/\.(tar\.gz|tar\.bz2|tar\.xz|tgz|tar|zip|whl|egg|jar|war|ear|apk|nupkg|xpi|vsix|asar|gz|bz2|xz|7z|rar|zst|lz4|lzma|cab|iso|deb|rpm)$/i, '');
  return path.join(dir, base);
}

module.exports = defineTool({
  name: 'unpack',
  description: 'Extract archive files (ZIP, WHL, JAR, EGG, NUPKG and other zip-family packages, Electron ASAR, plus TAR, TAR.GZ, TGZ, GZ). Formats the built-in handlers do not cover (7Z, RAR, BZ2, XZ, ZST, LZ4, CAB, ISO, DEB, RPM) fall back to a system extractor (7z/bsdtar/unar); if none is installed, unpack returns the exact install command. Can list contents or extract to a directory.',
  category: 'filesystem',
  risk: 'medium',
  aliases: ['unpack_archive', 'extract', 'unzip', 'decompress'],
  searchHint: 'extract unpack unzip decompress archive tar gz zip tgz',
  isReadOnly: (input) => !!input?.list_only,
  isDestructive: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 8000,

  inputSchema: {
    file_path: {
      type: 'string',
      required: true,
      description: 'Path to the archive file (.zip, .whl, .jar, .egg, .nupkg, .xpi, .vsix, .asar, .tar, .tar.gz, .tgz, .gz)',
    },
    output_dir: {
      type: 'string',
      required: false,
      description: 'Directory to extract files into. Defaults to a folder named after the archive in the same directory.',
    },
    list_only: {
      type: 'boolean',
      required: false,
      description: 'If true, only list archive contents without extracting.',
    },
    install: {
      type: 'boolean',
      required: false,
      description: 'For formats needing an external extractor that is NOT installed: set true to let khy run the platform install command and retry. Requires KHY_UNPACK_AUTO_INSTALL=1 and the user\'s explicit confirmation — installing software modifies the system, so ask the user first. Default false: unpack only returns the exact install command.',
    },
  },

  async validateInput(input) {
    if (!input?.file_path) {
      return { valid: false, message: 'file_path is required' };
    }
    const expanded = _expandPath(input.file_path);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    if (!fs.existsSync(resolved)) {
      return { valid: false, message: `File not found: ${resolved}` };
    }
    if (!fs.statSync(resolved).isFile()) {
      return { valid: false, message: `Not a file: ${resolved}` };
    }
    const format = _detectFormat(resolved);
    if (!format) {
      return { valid: false, message: `Unsupported archive format: ${path.extname(resolved)}. Supported: .zip / .whl / .jar / .egg / .nupkg / .xpi / .vsix (zip-family), .asar (Electron), .tar, .tar.gz, .tgz, .gz; plus .7z / .rar / .bz2 / .xz / .zst / .lz4 / .cab / .iso / .deb / .rpm via a system extractor (7z/bsdtar/unar).` };
    }
    return { valid: true };
  },

  getActivityDescription(input) {
    const name = path.basename(input?.file_path || 'archive');
    return input?.list_only ? `Listing ${name}` : `Extracting ${name}`;
  },

  async execute(params) {
    const expanded = _expandPath(params.file_path);
    const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    // 读前防卡死前检(execute chokepoint)—— 与 inspectDocument/editFile/exploreTool/replaceAtLocation 同构。
    // validateInput.isFile() 只在 registry 分发路径拦特殊文件(source-dependent);把守卫落在 execute 体内可
    // source-无关地防住「流式解包」(createReadStream→gunzip 对 FIFO/阻塞伪文件会永久卡死),对未来 builtin
    // 暴露/直调 execute 亦稳。命中即干净拒绝;族门关或判定失败 → 回退历史行为(byte-revert)。
    try {
      const stat = fs.statSync(resolved);
      const { classifyPreReadHang } = require('./filePreReadHangGuard');
      const hang = classifyPreReadHang({ absPath: resolved, stat, env: process.env });
      if (hang && hang.blocked) return { success: false, error: hang.error, blockedRead: hang.kind };
    } catch { /* stat/判定失败 → 回退历史行为 */ }
    const format = _detectFormat(resolved);
    const listOnly = !!params.list_only;
    const outputDir = params.output_dir
      ? (path.isAbsolute(params.output_dir) ? params.output_dir : path.resolve(params.output_dir))
      : _defaultOutputDir(resolved);

    // [SAFE] The per-entry guards (_isSafePath / _isWithinDest) only stop an entry
    // from escaping outputDir — they do nothing about WHERE outputDir itself points.
    // An Agent-supplied absolute output_dir ("/etc/cron.d", "<otheruser>/.ssh") lets
    // a perfectly "safe" archive drop authorized_keys / crontab / .bashrc straight
    // into a system or another user's directory: the destination base is the escape,
    // not the members. Confine the extraction root to the project tree or the user's
    // own home/Desktop/Documents/Downloads (same check writeFile/editFile enforce)
    // before any file is created. Listing writes nothing, so it stays unconfined.
    if (!listOnly) {
      const { validateNotUNCPath, validateNoPathTraversal } = require('./inputValidators');
      const uncCheck = validateNotUNCPath(params.output_dir);
      if (!uncCheck.valid) return { success: false, error: uncCheck.message };
      const confineCheck = validateNoPathTraversal(outputDir);
      if (!confineCheck.valid) return { success: false, error: confineCheck.message };
    }

    try {
      let result;
      if (format === 'zip') {
        result = await _extractZip(resolved, outputDir, listOnly);
      } else if (format === 'tar') {
        result = await _extractTar(resolved, outputDir, listOnly);
      } else if (format === 'gz') {
        result = await _extractGz(resolved, outputDir, listOnly);
      } else if (format === 'asar') {
        result = await _extractAsar(resolved, outputDir, listOnly);
      } else if (format === 'generic') {
        result = await _extractGeneric(resolved, outputDir, listOnly, params);
        // No extractor installed (and not authorized to install): surface the
        // precise install guidance instead of a flat failure.
        if (result && result.__unremediable) {
          return { success: false, error: result.message };
        }
      } else {
        return { success: false, error: `Unsupported format: ${format}` };
      }

      if (listOnly) {
        const lines = [`Archive: ${path.basename(resolved)} (${result.format})`, `Files: ${result.totalFiles}`];
        if (result.totalSize) lines.push(`Total size: ${(result.totalSize / 1024).toFixed(1)} KB`);
        lines.push('');
        for (const e of result.entries) {
          const sizeStr = e.size > 0 ? ` (${(e.size / 1024).toFixed(1)} KB)` : '';
          lines.push(`  ${e.name}${sizeStr}`);
        }
        if (result.truncated) lines.push(`  ... (showing first 200 of ${result.totalFiles})`);
        return { success: true, output: lines.join('\n') };
      }

      return {
        success: true,
        output: `Extracted ${result.totalFiles} file(s) to: ${result.outputDir || outputDir}`,
      };
    } catch (err) {
      return { success: false, error: `Extraction failed: ${err.message}` };
    }
  },
});
