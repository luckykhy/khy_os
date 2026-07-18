'use strict';

/**
 * fileFormatDetector.js — 项目文件格式**精确识别**单一真源。
 *
 * 目标（来自 /goal「khy 需要精确项目中的文件格式」）：对 md/docx/pdf/.c/.cpp/.java/
 * .moon/.mbt 等，既看扩展名也看内容魔数，给出精确格式 + 语言 + 大类，并在
 * 「扩展名与真实内容不一致」时显式标记（如 .txt 实为 docx）。纯 JS、零依赖、可测。
 *
 * 设计：
 *   - EXT_FORMAT：扩展名 → {format, language, category, mime} 单源（种子自
 *     projectMetadataService.SOURCE_LANG，补齐文档/数据类）。
 *   - MAGIC：缓冲区魔数嗅探（复用 imageService.detectFormat 的思路），含 OOXML
 *     (docx/xlsx/pptx) 在 zip 内的内容类型识别。
 *   - isBinary：NUL 字节 + 不可打印比例启发。
 *   - 调和：magic 胜出（高置信），否则回落扩展名（中置信）；冲突即 mismatch=true。
 */

const fs = require('fs');
const path = require('path');

// ── 扩展名 → 格式画像（单一真源；code 类语言种子对齐 SOURCE_LANG） ──
const EXT_FORMAT = {
  // 代码
  '.js': { format: 'javascript', language: 'javascript', category: 'code', mime: 'text/javascript' },
  '.mjs': { format: 'javascript', language: 'javascript', category: 'code', mime: 'text/javascript' },
  '.cjs': { format: 'javascript', language: 'javascript', category: 'code', mime: 'text/javascript' },
  '.ts': { format: 'typescript', language: 'typescript', category: 'code', mime: 'text/typescript' },
  '.tsx': { format: 'typescript', language: 'typescript', category: 'code', mime: 'text/typescript' },
  '.jsx': { format: 'javascript', language: 'javascript', category: 'code', mime: 'text/javascript' },
  '.py': { format: 'python', language: 'python', category: 'code', mime: 'text/x-python' },
  '.go': { format: 'go', language: 'go', category: 'code', mime: 'text/x-go' },
  '.rs': { format: 'rust', language: 'rust', category: 'code', mime: 'text/x-rust' },
  '.java': { format: 'java', language: 'java', category: 'code', mime: 'text/x-java' },
  '.c': { format: 'c', language: 'c', category: 'code', mime: 'text/x-c' },
  '.h': { format: 'c-header', language: 'c', category: 'code', mime: 'text/x-c' },
  '.cpp': { format: 'cpp', language: 'cpp', category: 'code', mime: 'text/x-c++' },
  '.cc': { format: 'cpp', language: 'cpp', category: 'code', mime: 'text/x-c++' },
  '.cxx': { format: 'cpp', language: 'cpp', category: 'code', mime: 'text/x-c++' },
  '.hpp': { format: 'cpp-header', language: 'cpp', category: 'code', mime: 'text/x-c++' },
  '.rb': { format: 'ruby', language: 'ruby', category: 'code', mime: 'text/x-ruby' },
  '.php': { format: 'php', language: 'php', category: 'code', mime: 'text/x-php' },
  '.cs': { format: 'csharp', language: 'csharp', category: 'code', mime: 'text/x-csharp' },
  '.kt': { format: 'kotlin', language: 'kotlin', category: 'code', mime: 'text/x-kotlin' },
  '.swift': { format: 'swift', language: 'swift', category: 'code', mime: 'text/x-swift' },
  '.vue': { format: 'vue', language: 'vue', category: 'code', mime: 'text/x-vue' },
  // MoonBit：仓库用 .mbt，用户口径含 .moon —— 两者都支持。
  '.mbt': { format: 'moonbit', language: 'moonbit', category: 'code', mime: 'text/x-moonbit' },
  '.moon': { format: 'moonbit', language: 'moonbit', category: 'code', mime: 'text/x-moonbit' },
  '.sh': { format: 'shell', language: 'shell', category: 'code', mime: 'text/x-shellscript' },
  // 文档
  '.md': { format: 'markdown', language: 'markdown', category: 'document', mime: 'text/markdown' },
  '.markdown': { format: 'markdown', language: 'markdown', category: 'document', mime: 'text/markdown' },
  '.docx': { format: 'docx', language: null, category: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.doc': { format: 'msword', language: null, category: 'document', mime: 'application/msword' },
  '.pdf': { format: 'pdf', language: null, category: 'document', mime: 'application/pdf' },
  '.txt': { format: 'text', language: null, category: 'document', mime: 'text/plain' },
  '.rtf': { format: 'rtf', language: null, category: 'document', mime: 'application/rtf' },
  '.tex': { format: 'latex', language: 'latex', category: 'document', mime: 'text/x-tex' },
  '.html': { format: 'html', language: 'html', category: 'document', mime: 'text/html' },
  '.htm': { format: 'html', language: 'html', category: 'document', mime: 'text/html' },
  // 数据/配置
  '.json': { format: 'json', language: 'json', category: 'data', mime: 'application/json' },
  '.yaml': { format: 'yaml', language: 'yaml', category: 'data', mime: 'application/yaml' },
  '.yml': { format: 'yaml', language: 'yaml', category: 'data', mime: 'application/yaml' },
  '.toml': { format: 'toml', language: 'toml', category: 'data', mime: 'application/toml' },
  '.csv': { format: 'csv', language: null, category: 'data', mime: 'text/csv' },
  '.xml': { format: 'xml', language: 'xml', category: 'data', mime: 'application/xml' },
  '.xlsx': { format: 'xlsx', language: null, category: 'data', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.pptx': { format: 'pptx', language: null, category: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  // 二进制/产物
  '.png': { format: 'png', language: null, category: 'image', mime: 'image/png' },
  '.jpg': { format: 'jpeg', language: null, category: 'image', mime: 'image/jpeg' },
  '.jpeg': { format: 'jpeg', language: null, category: 'image', mime: 'image/jpeg' },
  '.gif': { format: 'gif', language: null, category: 'image', mime: 'image/gif' },
  '.webp': { format: 'webp', language: null, category: 'image', mime: 'image/webp' },
  '.zip': { format: 'zip', language: null, category: 'archive', mime: 'application/zip' },
  '.iso': { format: 'iso', language: null, category: 'archive', mime: 'application/x-iso9660-image' },
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', 'coverage', '.venv', 'venv', '__pycache__',
  '.idea', '.vscode', '.ai', 'vendor', '.pytest_cache', '.mypy_cache',
  'bin', 'obj', '.gradle', '.terraform', 'tmp', '.tox', 'site-packages',
]);

const UNKNOWN = { format: 'unknown', language: null, category: 'unknown', mime: 'application/octet-stream' };

/** 由扩展名画像。无扩展名 / 未登记 → unknown。 */
function fromExtension(ext) {
  const e = String(ext || '').toLowerCase();
  const key = e.startsWith('.') ? e : (e ? `.${e}` : '');
  return EXT_FORMAT[key] ? { ...EXT_FORMAT[key] } : { ...UNKNOWN };
}

/**
 * 魔数嗅探：仅看缓冲区内容，返回精确 format 或 null（无法判定）。
 * @param {Buffer} buf  文件头部（建议 ≥16KB，含 OOXML 时最好再带尾部）
 */
function detectByMagic(buf) {
  if (!buf || !buf.length) return null;
  const b = buf;
  const startsWith = (sig) => b.length >= sig.length && sig.every((v, i) => b[i] === v);

  // PDF: %PDF-
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return { format: 'pdf', category: 'document', mime: 'application/pdf' };
  // ELF
  if (startsWith([0x7f, 0x45, 0x4c, 0x46])) return { format: 'elf', category: 'binary', mime: 'application/x-elf' };
  // PE (MZ)
  if (startsWith([0x4d, 0x5a])) return { format: 'pe', category: 'binary', mime: 'application/x-dosexec' };
  // 图片
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return { format: 'png', category: 'image', mime: 'image/png' };
  if (startsWith([0xff, 0xd8, 0xff])) return { format: 'jpeg', category: 'image', mime: 'image/jpeg' };
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return { format: 'gif', category: 'image', mime: 'image/gif' };
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && b.length >= 12 && b.slice(8, 12).toString('latin1') === 'WEBP') {
    return { format: 'webp', category: 'image', mime: 'image/webp' };
  }
  // RTF: {\rtf
  if (b.slice(0, 5).toString('latin1') === '{\\rtf') return { format: 'rtf', category: 'document', mime: 'application/rtf' };
  // ZIP family (PK\x03\x04 / PK\x05\x06 空档案)
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06])) {
    const text = b.toString('latin1');
    // OOXML 在 zip 内的内容类型标识（头部本地文件名 + 内容类型 XML）。
    if (text.includes('word/document.xml') || text.includes('wordprocessingml')) {
      return { format: 'docx', category: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    }
    if (text.includes('xl/workbook.xml') || text.includes('spreadsheetml')) {
      return { format: 'xlsx', category: 'data', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    }
    if (text.includes('ppt/presentation.xml') || text.includes('presentationml')) {
      return { format: 'pptx', category: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
    }
    return { format: 'zip', category: 'archive', mime: 'application/zip' };
  }
  return null;
}

/** NUL 字节 / 高比例不可打印 → 二进制。仅看前若干字节。 */
function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  const n = Math.min(buf.length, 8192);
  let nonText = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true; // NUL → 几乎必为二进制
    // 允许常见文本控制符 \t \n \r \f；其余 <0x20 计为不可打印
    if (c < 0x09 || (c > 0x0d && c < 0x20)) nonText++;
  }
  return nonText / n > 0.30;
}

/** 读头部 + 尾部窗口（OOXML 内容类型可能落在中央目录/尾部）。永不抛。 */
function _readHeadTail(absPath, headBytes = 16384, tailBytes = 4096) {
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const st = fs.fstatSync(fd);
    // 纵深防卡死：只有**普通文件**才继续读。字符/块设备节点、socket 等在 open 成功后 readSync
    // 仍可能永久阻塞（如 /dev 下某些节点），会锁死调用方事件循环（用户诉求：阅读工具不得因不
    // 支持的文件类型长时间卡死）。fstat 已在手，免费判型后对非普通文件即刻退回空缓冲，使 detectFile
    // 天然不会挂起。普通文件路径逐字节等价。（FIFO 在 openSync 阶段即阻塞，由上游调用方的
    // specialFileReadGuard/pseudoFileReadGuard 前置拦截；此处是最后一道纵深防线。）
    if (!st.isFile()) return { buf: Buffer.alloc(0), size: 0 };
    const size = st.size;
    const head = Buffer.alloc(Math.min(headBytes, size));
    if (head.length) fs.readSync(fd, head, 0, head.length, 0);
    if (size <= headBytes) return { buf: head, size };
    const tail = Buffer.alloc(Math.min(tailBytes, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return { buf: Buffer.concat([head, tail]), size };
  } catch {
    return { buf: Buffer.alloc(0), size: 0 };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * 识别一个缓冲区（已知名字）。调和扩展名与魔数。
 * @returns {{name,ext,format,language,category,mime,isBinary,confidence,mismatch,magicFormat,extFormat}}
 */
function detectBuffer(buf, name = '') {
  const ext = path.extname(String(name || '')).toLowerCase();
  const byExt = fromExtension(ext);
  const magic = detectByMagic(buf);
  const binary = magic ? (magic.category === 'binary' || magic.category === 'image' || magic.category === 'archive' || magic.format === 'pdf' || magic.format === 'docx' || magic.format === 'xlsx' || magic.format === 'pptx') : looksBinary(buf);

  let chosen, confidence, mismatch = false;
  if (magic) {
    chosen = { format: magic.format, language: byExt.language && byExt.format === magic.format ? byExt.language : (EXT_FORMAT[`.${magic.format}`]?.language ?? null), category: magic.category, mime: magic.mime };
    confidence = 'magic';
    // 扩展名声称的格式与真实内容冲突（且扩展名是已登记的具体格式）。
    if (byExt.format !== 'unknown' && byExt.format !== magic.format && !_compatible(byExt.format, magic.format)) {
      mismatch = true;
    }
  } else {
    chosen = byExt;
    confidence = byExt.format === 'unknown' ? 'unknown' : 'extension';
  }

  return {
    name: name || '',
    ext,
    format: chosen.format,
    language: chosen.language ?? null,
    category: chosen.category,
    mime: chosen.mime,
    isBinary: binary,
    confidence,
    mismatch,
    magicFormat: magic ? magic.format : null,
    extFormat: byExt.format,
  };
}

// docx 也是 zip；zip↔docx/xlsx/pptx 不算冲突。文本类彼此不冲突由 magic=null 兜底。
function _compatible(a, b) {
  const zipFam = new Set(['zip', 'docx', 'xlsx', 'pptx']);
  if (zipFam.has(a) && zipFam.has(b)) return true;
  return false;
}

/** 识别磁盘上的单个文件。 */
function detectFile(absPath) {
  const { buf, size } = _readHeadTail(absPath);
  const res = detectBuffer(buf, absPath);
  res.path = absPath;
  res.size = size;
  return res;
}

/**
 * 盘点一个项目目录的文件格式分布（精确识别项目中的文件格式）。
 * @param {string} rootDir
 * @param {{maxFiles?:number, maxDepth?:number, sniff?:boolean}} [opts]
 *   sniff=true 时对每个文件读魔数（更精确但更慢）；默认 false 仅按扩展名分类。
 * @returns {{root, totalFiles, byCategory, byFormat, byLanguage, mismatches, truncated, files}}
 */
function inspectProject(rootDir, opts = {}) {
  const maxFiles = opts.maxFiles || 5000;
  const maxDepth = opts.maxDepth ?? 12;
  const sniff = !!opts.sniff;
  const byCategory = {}, byFormat = {}, byLanguage = {};
  const mismatches = [];
  const files = [];
  let total = 0, truncated = false;

  const walk = (dir, depth) => {
    if (truncated || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (truncated) return;
      const name = ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        walk(path.join(dir, name), depth + 1);
      } else if (ent.isFile()) {
        if (total >= maxFiles) { truncated = true; return; }
        total++;
        const abs = path.join(dir, name);
        const info = sniff ? detectFile(abs) : (() => {
          const byExt = fromExtension(path.extname(name));
          return { name, ext: path.extname(name).toLowerCase(), format: byExt.format, language: byExt.language, category: byExt.category, mime: byExt.mime, confidence: byExt.format === 'unknown' ? 'unknown' : 'extension', mismatch: false, path: abs };
        })();
        byCategory[info.category] = (byCategory[info.category] || 0) + 1;
        byFormat[info.format] = (byFormat[info.format] || 0) + 1;
        if (info.language) byLanguage[info.language] = (byLanguage[info.language] || 0) + 1;
        if (info.mismatch) mismatches.push({ path: abs, extFormat: info.extFormat, magicFormat: info.magicFormat });
        files.push({ path: abs, format: info.format, category: info.category });
      }
    }
  };
  walk(rootDir, 0);

  return { root: rootDir, totalFiles: total, byCategory, byFormat, byLanguage, mismatches, truncated, files };
}

module.exports = {
  EXT_FORMAT,
  SKIP_DIRS,
  fromExtension,
  detectByMagic,
  looksBinary,
  detectBuffer,
  detectFile,
  inspectProject,
};
