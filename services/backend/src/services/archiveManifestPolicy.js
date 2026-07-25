'use strict';

/**
 * archiveManifestPolicy.js — 纯叶子:压缩包(archive / 压缩包 / 归档)输入的「识别 + 清单格式」单一真源。
 *
 * 背景:当用户**同时**给 khy 图片 + 文档 + 压缩包 + 自然语言时,前三类里只有「图片 / 文档」
 * 被既有多模态摄入识别,**压缩包此前完全无识别**——既不在 EXT_MIME_MAP,内联检测直接拒绝、
 * 显式附件落入 kind='unknown' 被 `未识别媒体类型` 静默丢弃。模型永远看不到压缩包存在或内容。
 * 本叶子把「什么算压缩包 / 用哪种策略列目录 / 哪些条目值得窥探 / 清单怎么呈现给模型」收口为
 * 单一真源;真正的解压/列表 I/O 由薄层 archiveInspectService 完成。
 *
 * 契约:零 I/O(只读 process.env 做门控,不碰 fs/网络/子进程)、确定性(无时钟/随机)、
 * 绝不抛(fail-soft 返回安全值)、env 门控 KHY_ARCHIVE_INSPECT 默认开。
 *
 * 全局门控惯例:khyos 所有 KHY_* 开关读法为 `!FALSY.has(v)`,FALSY = {0,false,off,no}。
 * 门控关 → isArchivePath/isArchiveMime/mimeForArchive 返 false/''、archiveStrategyForPath 返 ''、
 * buildArchiveManifest 返 ''(=压缩包不被识别,摄入层逐字节回退到「unknown→丢弃」的今日行为)。
 *
 * 安全设计(由本叶子的策略约束 + 薄层执行共同保证):
 *  - 只**列目录 / 内存窥探**,绝不把条目落盘解压 → 无路径穿越(zip-slip)写入风险。
 *  - 窥探有严格上限(条目数 / 每条字节 / 字符)→ 防 zip-bomb 在读取侧炸内存。
 *  - 仅窥探文本类条目(扩展名白名单),二进制条目只列名不读。
 */

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);

function isEnabled(env = process.env) {
  const raw = env && env.KHY_ARCHIVE_INSPECT;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 上限常量(确定性、可被 env 覆盖但有下限保护) ─────────────────────────────
function _intEnv(env, key, dflt, min) {
  const n = parseInt(String((env && env[key]) || ''), 10);
  return Math.max(min, Number.isFinite(n) && n > 0 ? n : dflt);
}
function manifestMaxEntries(env = process.env) { return _intEnv(env, 'KHY_ARCHIVE_MANIFEST_MAX_ENTRIES', 40, 1); }
function peekMaxFiles(env = process.env) { return _intEnv(env, 'KHY_ARCHIVE_PEEK_MAX_FILES', 3, 0); }
function peekMaxBytes(env = process.env) { return _intEnv(env, 'KHY_ARCHIVE_PEEK_MAX_BYTES', 8192, 256); }
function peekMaxChars(env = process.env) { return _intEnv(env, 'KHY_ARCHIVE_PEEK_MAX_CHARS', 1500, 64); }

// ── 扩展名 → 列表策略 ────────────────────────────────────────────────────────
// 'zip'        : node-stream-zip 列中央目录 + 内存窥探(零落盘)
// 'tar'        : node-tar 同步列条目(.tar / .tar.gz / .tgz;gzip 由 node-tar 自动识别)
// 'unsupported': 识别为压缩包但当前无零依赖列表手段(诚实说明,不静默丢弃)
// ''           : 非压缩包
function archiveStrategyForPath(filePath, env = process.env) {
  try {
    if (!isEnabled(env)) return '';
    const lower = String(filePath || '').toLowerCase().trim();
    if (!lower) return '';
    // 复合扩展名优先(.tar.gz 必须先于 .gz 判定)。
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) return 'tar';
    if (lower.endsWith('.zip')) return 'zip';
    if (
      lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2') || lower.endsWith('.tar.xz')
      || lower.endsWith('.7z') || lower.endsWith('.rar') || lower.endsWith('.bz2')
      || lower.endsWith('.gz') || lower.endsWith('.xz')
    ) return 'unsupported';
    return '';
  } catch {
    return '';
  }
}

function isArchivePath(filePath, env = process.env) {
  return archiveStrategyForPath(filePath, env) !== '';
}

// ── mime 归一 ────────────────────────────────────────────────────────────────
function mimeForArchive(filePath, env = process.env) {
  try {
    if (!isEnabled(env)) return '';
    const lower = String(filePath || '').toLowerCase().trim();
    if (!lower) return '';
    if (lower.endsWith('.zip')) return 'application/zip';
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.gz')) return 'application/gzip';
    if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2') || lower.endsWith('.bz2')) return 'application/x-bzip2';
    if (lower.endsWith('.tar.xz') || lower.endsWith('.xz')) return 'application/x-xz';
    if (lower.endsWith('.tar')) return 'application/x-tar';
    if (lower.endsWith('.7z')) return 'application/x-7z-compressed';
    if (lower.endsWith('.rar')) return 'application/vnd.rar';
    return '';
  } catch {
    return '';
  }
}

// 已知压缩包 mime(供显式附件按 mimeType 分类时识别;门控关恒 false)。
const _ARCHIVE_MIMES = new Set([
  'application/zip', 'application/x-zip-compressed', 'application/zip-compressed',
  'application/x-tar', 'application/gzip', 'application/x-gzip',
  'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar-compressed',
  'application/x-bzip2', 'application/x-bzip', 'application/x-xz',
]);

function isArchiveMime(mimeType, env = process.env) {
  try {
    if (!isEnabled(env)) return false;
    return _ARCHIVE_MIMES.has(String(mimeType || '').trim().toLowerCase());
  } catch {
    return false;
  }
}

// ── 条目窥探选择(确定性) ────────────────────────────────────────────────────
const _TEXT_LIKE_ENTRY_EXT = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml',
  '.log', '.ini', '.cfg', '.conf', '.toml', '.env', '.properties',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.bash',
  '.html', '.htm', '.css', '.scss', '.sql', '.gradle', '.kt', '.swift', '.r',
]);

function _entryExt(name) {
  const s = String(name || '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const base = slash >= 0 ? s.slice(slash + 1) : s;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

function isTextLikeEntry(name) {
  try {
    return _TEXT_LIKE_ENTRY_EXT.has(_entryExt(name));
  } catch {
    return false;
  }
}

/**
 * 从条目列表里确定性挑出「值得窥探」的小文本条目(按给定顺序,文本类 + 0<size<=maxBytes)。
 * @param {Array<{name:string,size:number,isDirectory?:boolean}>} entries
 * @returns {Array<{name:string,size:number}>}
 */
function selectPeekEntries(entries, opts = {}) {
  try {
    const env = opts.env || process.env;
    const maxPeek = Number.isFinite(opts.maxPeek) ? Math.max(0, opts.maxPeek) : peekMaxFiles(env);
    const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(1, opts.maxBytes) : peekMaxBytes(env);
    if (maxPeek <= 0 || !Array.isArray(entries)) return [];
    const out = [];
    for (const e of entries) {
      if (out.length >= maxPeek) break;
      if (!e || e.isDirectory) continue;
      const size = Number(e.size || 0) || 0;
      if (size <= 0 || size > maxBytes) continue;
      if (!isTextLikeEntry(e.name)) continue;
      out.push({ name: String(e.name), size });
    }
    return out;
  } catch {
    return [];
  }
}

// ── 字节格式化(确定性) ──────────────────────────────────────────────────────
function _formatBytes(n, env = process.env) {
  // 字节→人类可读单一真源:门控 KHY_CC_FORMAT 开 → 走 CC `formatFileSize` 同口径
  // (与 health/storage/multimodal/aiUploadStore 等所有展示面统一);关 → 逐字节回退本地旧口径。
  // ccFormat 亦为纯叶子,叶子→叶子相对 require 合规。
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../cli/ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(Number(n || 0) || 0);
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  const bytes = Number(n || 0) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function _clipText(text, maxChars) {
  const s = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!s) return '';
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n...[truncated]` : s;
}

/**
 * 构建注入提示词的 `[Archive Contents]` 清单块(单一真源)。门控关 → ''。
 * @param {object} a
 * @param {string} a.name
 * @param {string} a.mimeType
 * @param {Array<{name:string,size:number,isDirectory?:boolean}>} [a.entries]  已列出的条目(可被截断前的列表)
 * @param {number} [a.totalEntries]  压缩包内文件总数(用于「... N more」)
 * @param {Array<{name:string,text:string}>} [a.peeks]  内存窥探到的小文本条目
 * @param {string} [a.error]  列表失败/不支持时的诚实原因
 * @returns {string}
 */
function buildArchiveManifest(a = {}) {
  try {
    const env = a.env || process.env;
    if (!isEnabled(env)) return '';
    const name = String(a.name || 'archive').trim() || 'archive';
    const mimeType = String(a.mimeType || 'application/octet-stream').trim() || 'application/octet-stream';
    const entries = Array.isArray(a.entries) ? a.entries.filter(e => e && !e.isDirectory) : [];
    const total = Number.isFinite(a.totalEntries) ? a.totalEntries : entries.length;
    const maxEntries = manifestMaxEntries(env);
    const maxChars = peekMaxChars(env);

    const lines = [];
    if (a.error && entries.length === 0) {
      // 识别为压缩包,但无法列出内容 —— 诚实说明,绝不静默丢弃,也绝不臆测内容。
      lines.push(`[Archive Contents] ${name} (${mimeType})`);
      lines.push(`khy 已识别这是一个压缩包,但无法直接列出它的内容(${a.error})。`);
      lines.push('请勿臆测压缩包里有什么。可让用户:① 改用 .zip / .tar / .tar.gz 重新打包后发送;② 解压后把需要的文件直接发给我;③ 告知里面的关键文件清单。');
      return lines.join('\n');
    }

    lines.push(`[Archive Contents] ${name} (${mimeType}, ${total} ${total === 1 ? 'entry' : 'entries'})`);
    lines.push('以下是该压缩包的目录清单(仅列目录,**未解压**):');

    // 抓重点层:门控 KHY_FILE_SALIENCE 开 → 先按内在重要性重排+分组摘要(压缩包常含大量文件,
    // 原「前 N 原序 + 还有 N」把入口/README/manifest 淹没)。关 / 不可用 → 逐字节回退原序 slice。
    let salienceBlock = '';
    try {
      const fileSalience = require('./fileSalience'); // 叶子→叶子相对 require 合规
      if (fileSalience.isEnabled(env)) {
        const summary = fileSalience.summarizeListing(entries, { env, total, fallbackShown: maxEntries });
        salienceBlock = fileSalience.renderSalienceBlock(summary, { env });
      }
    } catch { salienceBlock = ''; }

    if (salienceBlock) {
      lines.push(salienceBlock);
    } else {
      // 逐字节回退:原「前 maxEntries 条(原序)+ 还有 N 个文件」。
      const shown = entries.slice(0, maxEntries);
      for (const e of shown) {
        lines.push(`- ${String(e.name)} (${_formatBytes(e.size, env)})`);
      }
      if (total > shown.length) {
        lines.push(`- ... 还有 ${total - shown.length} 个文件`);
      }
    }

    const peeks = Array.isArray(a.peeks) ? a.peeks.filter(p => p && p.text) : [];
    for (const p of peeks) {
      const body = _clipText(p.text, maxChars);
      if (!body) continue;
      lines.push('');
      lines.push(`[Archive Entry] ${String(p.name)}`);
      lines.push('```text');
      lines.push(body);
      lines.push('```');
    }

    lines.push('');
    lines.push('上面是压缩包内容的清单与少量文本预览。如需深入分析某个未预览的文件,请让用户指明该文件,或说明你需要其完整内容;**绝不**凭文件名臆测其内容。');
    return lines.join('\n');
  } catch {
    return '';
  }
}

module.exports = {
  isEnabled,
  manifestMaxEntries,
  peekMaxFiles,
  peekMaxBytes,
  peekMaxChars,
  archiveStrategyForPath,
  isArchivePath,
  mimeForArchive,
  isArchiveMime,
  isTextLikeEntry,
  selectPeekEntries,
  buildArchiveManifest,
  _formatBytes, // exported for ccFormat file-size SSOT routing test
};
