'use strict';

/**
 * fileFormatData.js — pure-literal data leaf for fileFormatDetector.
 *
 * Extension→format profile (EXT_FORMAT), the project-scan skip list (SKIP_DIRS)
 * and the UNKNOWN fallback are literal-only, zero-require and never mutated.
 * Hoisted verbatim so the detector's functions (which read them read-only via
 * closure) stay the single behavioral source. Host re-requires these by the same
 * identifiers and re-exports EXT_FORMAT / SKIP_DIRS unchanged (same reference).
 */

// ── 扩展名 → 格式画像（单一真源；code 类语言种子对齐 SOURCE_LANG） ──
const EXT_FORMAT = {
  // 代码
  '.js': {
    format: 'javascript',
    language: 'javascript',
    category: 'code',
    mime: 'text/javascript',
  },
  '.mjs': {
    format: 'javascript',
    language: 'javascript',
    category: 'code',
    mime: 'text/javascript',
  },
  '.cjs': {
    format: 'javascript',
    language: 'javascript',
    category: 'code',
    mime: 'text/javascript',
  },
  '.ts': {
    format: 'typescript',
    language: 'typescript',
    category: 'code',
    mime: 'text/typescript',
  },
  '.tsx': {
    format: 'typescript',
    language: 'typescript',
    category: 'code',
    mime: 'text/typescript',
  },
  '.jsx': {
    format: 'javascript',
    language: 'javascript',
    category: 'code',
    mime: 'text/javascript',
  },
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
  '.markdown': {
    format: 'markdown',
    language: 'markdown',
    category: 'document',
    mime: 'text/markdown',
  },
  '.docx': {
    format: 'docx',
    language: null,
    category: 'document',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
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
  '.xlsx': {
    format: 'xlsx',
    language: null,
    category: 'data',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  '.pptx': {
    format: 'pptx',
    language: null,
    category: 'document',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  // 二进制/产物
  '.png': { format: 'png', language: null, category: 'image', mime: 'image/png' },
  '.jpg': { format: 'jpeg', language: null, category: 'image', mime: 'image/jpeg' },
  '.jpeg': { format: 'jpeg', language: null, category: 'image', mime: 'image/jpeg' },
  '.gif': { format: 'gif', language: null, category: 'image', mime: 'image/gif' },
  '.webp': { format: 'webp', language: null, category: 'image', mime: 'image/webp' },
  '.zip': { format: 'zip', language: null, category: 'archive', mime: 'application/zip' },
  '.iso': {
    format: 'iso',
    language: null,
    category: 'archive',
    mime: 'application/x-iso9660-image',
  },
};

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  '.ai',
  'vendor',
  '.pytest_cache',
  '.mypy_cache',
  'bin',
  'obj',
  '.gradle',
  '.terraform',
  'tmp',
  '.tox',
  'site-packages',
]);

const UNKNOWN = {
  format: 'unknown',
  language: null,
  category: 'unknown',
  mime: 'application/octet-stream',
};

module.exports = { EXT_FORMAT, SKIP_DIRS, UNKNOWN };
