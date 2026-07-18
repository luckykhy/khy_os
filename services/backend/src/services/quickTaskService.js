'use strict';

const fs = require('fs');
const path = require('path');
const { getDesktopPath, isSubpath } = require('../utils/pathCompat');

const DESKTOP_CATEGORY_RULES = [
  { folder: 'KHY-Documents', exts: new Set(['.txt', '.md', '.rtf', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.json', '.xml', '.yml', '.yaml']) },
  { folder: 'KHY-Images', exts: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic']) },
  { folder: 'KHY-Videos', exts: new Set(['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm']) },
  { folder: 'KHY-Audio', exts: new Set(['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a']) },
  { folder: 'KHY-Archives', exts: new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz']) },
  { folder: 'KHY-Code', exts: new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.rs', '.vue', '.html', '.css', '.scss', '.sql', '.sh']) },
  { folder: 'KHY-Executables', exts: new Set(['.lnk', '.url', '.desktop', '.appimage', '.exe', '.msi', '.bat', '.cmd']) },
];

const QUICK_CREATE_STOP_WORDS = new Set([
  'file', 'folder', 'directory', 'dir',
  '文件', '文件夹', '目录',
  'and', 'or', 'with',
  '和', '与', '以及',
  '一个', '一', 'the',
]);

// 收敛到 utils/collapseWhitespaceLoose 单一真源(逐字节委托,调用点不变)
const _cleanInput = require('../utils/collapseWhitespaceLoose');

function _resolveDesktopDir(options = {}) {
  const fromOpt = String(options.desktopDir || '').trim();
  if (fromOpt) return path.resolve(fromOpt);
  const fromEnv = String(process.env.KHY_QUICK_TASK_DESKTOP_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(getDesktopPath());
}

function _isDesktopOrganizeIntent(text = '') {
  const t = String(text || '');
  if (!/(桌面|desktop)/i.test(t)) return false;
  if (!/(整理|归类|分类|收拾|整顿|organize|organise|categorize|categorise|sort)/i.test(t)) return false;

  // If user clearly asks deletion, do not hijack to no-delete quick path.
  if (/(删除|清空|remove|delete|trash)/i.test(t) && !/(不删除|不要删除|只分类|no delete|without delete)/i.test(t)) {
    return false;
  }
  return true;
}

function _isQuickCreateIntent(text = '') {
  const t = String(text || '');
  if (t.length > 220 || /\n/.test(t)) return false;
  if (!/(创建|新建|生成|create|make)/i.test(t)) return false;
  if (!/(文件|file|文件夹|目录|folder|directory|dir)/i.test(t)) return false;
  // Coding-heavy requests should stay in normal AI/tool loop.
  if (/(实现|编写|重构|修复|代码|函数|class|api|接口|算法|单元测试|fix|refactor|implement|code|function|test)/i.test(t)) {
    return false;
  }
  return true;
}

function _stripWrapQuotes(raw = '') {
  return String(raw || '').replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
}

function _sanitizeEntityName(raw = '', fallback = '') {
  let out = _stripWrapQuotes(raw).replace(/[，。；;!！?？]+$/g, '').trim();
  if (!out) return fallback;
  if (out.length > 120) out = out.slice(0, 120);
  if (/^[=:：]+$/.test(out)) return fallback;
  if (QUICK_CREATE_STOP_WORDS.has(out.toLowerCase())) return fallback;
  return out;
}

function _extractNamedValue(text = '', patterns = []) {
  for (const pattern of patterns) {
    const m = String(text || '').match(pattern);
    if (m && m[1]) return _sanitizeEntityName(m[1], '');
  }
  return '';
}

function _looksInvalidExtractedName(name = '', kind = 'generic') {
  const raw = String(name || '').trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  if (QUICK_CREATE_STOP_WORDS.has(lower)) return true;
  if (/^(和|与|以及|and|or)$/i.test(raw)) return true;
  if (kind === 'file' && /(文件夹|目录|folder|directory|dir)/i.test(raw)) return true;
  if (kind === 'folder' && /(\bfile\b|文件(?!夹))/i.test(raw)) return true;
  if (/^(和|与|以及|and|or)[\s_-]*(文件|文件夹|目录|file|folder|directory|dir)/i.test(raw)) return true;
  return false;
}

function _extractFileName(text = '') {
  const direct = _extractNamedValue(text, [
    /(?:文件(?!夹)|\bfile\b)\s*(?:名|name)?\s*(?:是|为|:|：|=)?\s*["'`“”]([^"'`“”]{1,120})["'`“”]/i,
    /(?:文件(?!夹)|\bfile\b)\s*(?:名|name)?\s*(?:是|为|:|：|=)?\s*([^\s,，。;；]{1,120})/i,
  ]);
  if (direct && !_looksInvalidExtractedName(direct, 'file')) return direct;

  const quoted = _extractNamedValue(text, [
    /["'`“”]([^"'`“”]{1,120}\.[A-Za-z0-9_-]{1,10})["'`“”]/,
  ]);
  if (quoted && !_looksInvalidExtractedName(quoted, 'file')) return quoted;
  return '';
}

function _extractFolderName(text = '') {
  const direct = _extractNamedValue(text, [
    /(?:文件夹|目录|folder|directory|dir)\s*(?:名|name)?\s*(?:是|为|:|：|=)?\s*["'`“”]([^"'`“”]{1,120})["'`“”]/i,
    /(?:文件夹|目录|folder|directory|dir)\s*(?:名|name)?\s*(?:是|为|:|：|=)?\s*([^\s,，。;；]{1,120})/i,
  ]);
  if (direct && !_looksInvalidExtractedName(direct, 'folder')) return direct;

  const quoted = _extractNamedValue(text, [
    /["'`“”]([^"'`“”]{1,120})["'`“”]/,
  ]);
  if (quoted && !_looksInvalidExtractedName(quoted, 'folder')) return quoted;
  return '';
}

function _resolveCreateBaseDir(text = '', options = {}) {
  if (/(桌面|desktop)/i.test(String(text || ''))) return _resolveDesktopDir(options);
  return path.resolve(options.cwd || process.cwd());
}

function _nextAvailablePath(targetPath = '') {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 1; i <= 9999; i++) {
    const candidate = path.join(dir, `${base}_${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

function _resolveSafeTarget(baseDir = '', relativeName = '') {
  const raw = String(relativeName || '').trim();
  if (!raw) return '';
  const candidateAbs = path.resolve(baseDir, raw);
  if (candidateAbs === baseDir || isSubpath(baseDir, candidateAbs)) return candidateAbs;
  throw new Error(`Target path escapes base directory: ${raw}`);
}

function _getCategoryFolder(fileName = '') {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (!ext) return 'KHY-Others';
  for (const rule of DESKTOP_CATEGORY_RULES) {
    if (rule.exts.has(ext)) return rule.folder;
  }
  return 'KHY-Others';
}

function detectQuickTask(input = '', options = {}) {
  const text = _cleanInput(input);
  if (!text) return null;

  if (_isDesktopOrganizeIntent(text)) {
    return {
      type: 'desktop_organize',
      label: '桌面只分类不删除',
      sourceDir: _resolveDesktopDir(options),
      noDelete: true,
      cooperative: false,
    };
  }

  if (_isQuickCreateIntent(text)) {
    const baseDir = _resolveCreateBaseDir(text, options);
    const fileName = _extractFileName(text) || 'quick_note.txt';
    const folderName = _extractFolderName(text) || 'quick_folder';
    const wantFile = /(文件(?!夹)|\bfile\b)/i.test(text);
    const wantFolder = /(文件夹|目录|folder|directory|dir)/i.test(text);

    return {
      type: 'create_entries',
      label: '快速创建文件与目录',
      baseDir,
      createFile: wantFile,
      createFolder: wantFolder,
      fileName,
      folderName,
      cooperative: false,
    };
  }

  // Tier 1 确定性任务（正则提取、计算、文件操作等）
  try {
    const { detectDeterministic } = require('./localBrainService');
    const det = detectDeterministic(input, options);
    if (det) return det;
  } catch { /* localBrainService not available — non-blocking */ }

  return null;
}

function _emitStatus(onStatus, payload) {
  if (typeof onStatus !== 'function') return;
  try { onStatus(payload || {}); } catch { /* non-blocking */ }
}

function executeDesktopOrganize(plan = {}, options = {}) {
  const sourceDir = path.resolve(plan.sourceDir || _resolveDesktopDir(options));
  const onStatus = options.onStatus;
  const result = {
    type: 'desktop_organize',
    success: true,
    sourceDir,
    noDelete: true,
    stats: { scanned: 0, moved: 0, skipped: 0, failed: 0, createdDirs: 0 },
    moved: [],
    skipped: [],
    errors: [],
  };

  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    return {
      ...result,
      success: false,
      error: `Desktop directory not found: ${sourceDir}`,
    };
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry && entry.isFile() && !entry.name.startsWith('.'));
  result.stats.scanned = entries.length;

  _emitStatus(onStatus, {
    level: 'active',
    action: '扫描桌面文件',
    target: sourceDir,
    progress: `0/${entries.length}`,
  });

  const createdDirSet = new Set();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const srcPath = path.join(sourceDir, entry.name);
    const bucket = _getCategoryFolder(entry.name);
    const targetDir = path.join(sourceDir, bucket);
    const baseTarget = path.join(targetDir, entry.name);

    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        if (!createdDirSet.has(targetDir)) {
          createdDirSet.add(targetDir);
          result.stats.createdDirs++;
        }
      }
      const targetPath = _nextAvailablePath(baseTarget);
      fs.renameSync(srcPath, targetPath);
      result.stats.moved++;
      result.moved.push({ from: srcPath, to: targetPath, category: bucket });
      _emitStatus(onStatus, {
        level: 'active',
        action: '分类移动文件',
        target: entry.name,
        progress: `${i + 1}/${entries.length}`,
        detail: `目标目录 ${bucket}`,
      });
    } catch (err) {
      result.stats.failed++;
      result.errors.push({
        file: entry.name,
        error: String(err && err.message ? err.message : err || 'move failed'),
      });
      _emitStatus(onStatus, {
        level: 'active',
        action: '分类移动文件',
        target: entry.name,
        progress: `${i + 1}/${entries.length}`,
        detail: `失败: ${result.errors[result.errors.length - 1].error}`,
      });
    }
  }

  result.stats.skipped = result.stats.scanned - result.stats.moved - result.stats.failed;
  result.success = result.stats.failed === 0;

  _emitStatus(onStatus, {
    level: result.success ? 'success' : 'error',
    action: '桌面分类完成',
    target: sourceDir,
    progress: `扫描 ${result.stats.scanned} · 移动 ${result.stats.moved} · 跳过 ${result.stats.skipped} · 失败 ${result.stats.failed}`,
  });

  return result;
}

function executeCreateEntries(plan = {}, options = {}) {
  const baseDir = path.resolve(plan.baseDir || options.cwd || process.cwd());
  const onStatus = options.onStatus;
  const result = {
    type: 'create_entries',
    success: true,
    baseDir,
    created: [],
    skipped: [],
    errors: [],
  };

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  _emitStatus(onStatus, {
    level: 'active',
    action: '准备创建资源',
    target: baseDir,
    progress: '0/2',
  });

  const wantsFolder = plan.createFolder !== false;
  const wantsFile = plan.createFile !== false;

  if (wantsFolder) {
    try {
      const requested = _sanitizeEntityName(plan.folderName || 'quick_folder', 'quick_folder');
      const folderPath = _resolveSafeTarget(baseDir, requested);
      const finalFolder = _nextAvailablePath(folderPath);
      fs.mkdirSync(finalFolder, { recursive: true });
      result.created.push({ kind: 'folder', path: finalFolder });
      _emitStatus(onStatus, {
        level: 'active',
        action: '创建目录',
        target: requested,
        progress: wantsFile ? '1/2' : '1/1',
        detail: finalFolder,
      });
    } catch (err) {
      result.success = false;
      result.errors.push({ kind: 'folder', error: String(err && err.message ? err.message : err || 'create folder failed') });
    }
  }

  if (wantsFile) {
    try {
      const requested = _sanitizeEntityName(plan.fileName || 'quick_note.txt', 'quick_note.txt');
      const filePath = _resolveSafeTarget(baseDir, requested);
      const finalFile = _nextAvailablePath(filePath);
      const fileDir = path.dirname(finalFile);
      if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
      fs.writeFileSync(finalFile, '', { encoding: 'utf8', flag: 'wx' });
      result.created.push({ kind: 'file', path: finalFile });
      _emitStatus(onStatus, {
        level: 'active',
        action: '创建文件',
        target: requested,
        progress: wantsFolder ? '2/2' : '1/1',
        detail: finalFile,
      });
    } catch (err) {
      result.success = false;
      result.errors.push({ kind: 'file', error: String(err && err.message ? err.message : err || 'create file failed') });
    }
  }

  _emitStatus(onStatus, {
    level: result.success ? 'success' : 'error',
    action: '资源创建完成',
    target: baseDir,
    progress: `已创建 ${result.created.length} 项 · 失败 ${result.errors.length} 项`,
  });

  return result;
}

function executeQuickTask(plan = {}, options = {}) {
  if (!plan || !plan.type) {
    return { success: false, error: 'Invalid quick task plan' };
  }

  if (plan.type === 'desktop_organize') return executeDesktopOrganize(plan, options);
  if (plan.type === 'create_entries') return executeCreateEntries(plan, options);

  // Tier 1 确定性任务 — 委托 localBrainService
  try {
    const { executeDeterministic } = require('./localBrainService');
    return executeDeterministic(plan, options);
  } catch { /* fallthrough */ }

  return { success: false, error: `Unsupported quick task type: ${plan.type}` };
}

function formatQuickTaskResult(result = {}) {
  if (!result || typeof result !== 'object') return '';
  if (result.type === 'desktop_organize') {
    const stats = result.stats || {};
    const head = `桌面整理完成（只分类移动，不删除文件）。`;
    const summary = `扫描 ${Number(stats.scanned || 0)} 个，移动 ${Number(stats.moved || 0)} 个，跳过 ${Number(stats.skipped || 0)} 个，失败 ${Number(stats.failed || 0)} 个。`;
    if (!Array.isArray(result.moved) || result.moved.length === 0) return `${head}\n${summary}`;
    const sample = result.moved.slice(0, 6).map(item => `- ${path.basename(item.from)} -> ${path.basename(path.dirname(item.to))}/`);
    const more = result.moved.length > sample.length ? `\n- ... 其余 ${result.moved.length - sample.length} 个文件已分类` : '';
    return `${head}\n${summary}\n${sample.join('\n')}${more}`;
  }

  if (result.type === 'create_entries') {
    const created = Array.isArray(result.created) ? result.created : [];
    const lines = created.map((item) => `- ${item.kind === 'folder' ? '目录' : '文件'}: ${item.path}`);
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const errLines = errors.map((item) => `- 失败(${item.kind || 'item'}): ${item.error}`);
    const statusLine = errors.length > 0
      ? `快速创建部分完成：成功 ${created.length} 项，失败 ${errors.length} 项。`
      : `快速创建完成：成功创建 ${created.length} 项。`;
    return [statusLine, ...lines, ...errLines].filter(Boolean).join('\n');
  }

  // Tier 1 确定性任务 — 委托 localBrainService
  try {
    const { formatDeterministicResult } = require('./localBrainService');
    const formatted = formatDeterministicResult(result);
    if (formatted) return formatted;
  } catch { /* fallthrough */ }

  return result.error ? `快速任务失败: ${result.error}` : '快速任务已执行。';
}

module.exports = {
  detectQuickTask,
  executeQuickTask,
  formatQuickTaskResult,
  // Export internals for targeted unit tests.
  _internals: {
    _isDesktopOrganizeIntent,
    _isQuickCreateIntent,
    _extractFileName,
    _extractFolderName,
  },
};
