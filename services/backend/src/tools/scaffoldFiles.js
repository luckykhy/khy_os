const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineTool } = require('./_baseTool');

const _expandPath = require('../utils/expandEnvPath');

function _normalizeDirectories(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .map(v => String(v || '').trim())
    .filter(Boolean))];
}

function _normalizeFiles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const p = entry.trim();
      if (!p) continue;
      out.push({ path: p, content: '' });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const p = String(entry.path || entry.file_path || '').trim();
    if (!p) continue;
    const content = entry.content === undefined || entry.content === null
      ? ''
      : String(entry.content);
    out.push({ path: p, content });
  }
  return out;
}

function _inScope(target, scopeRoot) {
  const rel = path.relative(scopeRoot, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = defineTool({
  name: 'scaffoldFiles',
  description: 'Batch-create project folders and files in one call, with configurable parallel file writes.',
  category: 'filesystem',
  risk: 'high',
  aliases: [
    'scaffold_files',
    'create_project_structure',
    'project_scaffold',
    'batch_create_files',
  ],
  searchHint: 'scaffold project folders files batch parallel create structure',
  alwaysLoad: true,
  maxResultSizeChars: 3000,

  isReadOnly: false,
  isDestructive: (input) => {
    if (!input || input.overwrite !== true) return false;
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const rootPath = path.resolve(cwd, _expandPath(input.root || '.'));
    const files = _normalizeFiles(input.files);
    return files.some((f) => {
      try {
        return fs.existsSync(path.resolve(rootPath, f.path));
      } catch {
        return false;
      }
    });
  },
  isConcurrencySafe: false,

  async prompt() {
    return [
      'Create project folders/files in one batch with optional parallel writes.',
      'Use this when the user asks for project scaffolding or creating many files quickly.',
      'Input tips:',
      '- root: workspace-relative root directory (default ".")',
      '- directories: list of directories to create recursively',
      '- files: list of { path, content } entries',
      '- overwrite: false by default (existing files are skipped)',
      '- writeConcurrency: 1-16 (default 4) for parallel file writes',
      'NO god components: each generated file must hold ONE cohesive responsibility.',
      'Split by responsibility (routes/, services/, models/, components/) instead of',
      'piling routing+persistence+rendering into one large file. A single file over the',
      'project size ceiling is rejected — emit several focused files, not one monolith.',
    ].join('\n');
  },

  inputSchema: {
    root: {
      type: 'string',
      required: false,
      description: 'Root directory relative to current workspace. Defaults to "."',
    },
    directories: {
      type: 'array',
      required: false,
      description: 'Directory list to create recursively (paths relative to root).',
      items: { type: 'string' },
    },
    files: {
      type: 'array',
      required: false,
      description: 'File list. Each item: { path, content }. Paths are relative to root.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to root.' },
          content: { type: 'string', description: 'File content (empty string if omitted).' },
        },
        required: ['path'],
      },
    },
    overwrite: {
      type: 'boolean',
      required: false,
      description: 'Whether existing files can be overwritten. Default false.',
    },
    writeConcurrency: {
      type: 'number',
      required: false,
      description: 'Parallel write workers for file creation. Default 4, range 1-16.',
    },
  },

  async validateInput(input) {
    try {
      const { validateNotUNCPath, validateNoPathTraversal, composeValidations } = require('./inputValidators');
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const rootRaw = String(input?.root || '.').trim() || '.';
      const rootCheck = composeValidations(
        validateNotUNCPath(rootRaw),
        validateNoPathTraversal(rootRaw, cwd),
      );
      if (!rootCheck.valid) return rootCheck;

      const dirs = _normalizeDirectories(input?.directories);
      const files = _normalizeFiles(input?.files);
      if (dirs.length === 0 && files.length === 0) {
        return { valid: false, message: 'Provide at least one directory or file entry.' };
      }

      const rootPath = path.resolve(cwd, _expandPath(rootRaw));
      const checkPath = (p) => composeValidations(
        validateNotUNCPath(p),
        validateNoPathTraversal(path.join(rootRaw, p), cwd),
      );

      for (const d of dirs) {
        const verdict = checkPath(d);
        if (!verdict.valid) return verdict;
        const abs = path.resolve(rootPath, d);
        if (!_inScope(abs, rootPath)) {
          return { valid: false, message: `Directory path escapes root: ${d}` };
        }
      }
      for (const f of files) {
        const verdict = checkPath(f.path);
        if (!verdict.valid) return verdict;
        const abs = path.resolve(rootPath, f.path);
        if (!_inScope(abs, rootPath)) {
          return { valid: false, message: `File path escapes root: ${f.path}` };
        }
      }

      const rawConcurrency = Number(input?.writeConcurrency);
      if (input?.writeConcurrency !== undefined) {
        if (!Number.isFinite(rawConcurrency) || rawConcurrency < 1 || rawConcurrency > 16) {
          return { valid: false, message: 'writeConcurrency must be a number between 1 and 16.' };
        }
      }
      return { valid: true };
    } catch (err) {
      return { valid: false, message: err.message || 'Invalid scaffold input.' };
    }
  },

  getActivityDescription(input) {
    const root = String(input?.root || '.');
    const dirCount = Array.isArray(input?.directories) ? input.directories.length : 0;
    const fileCount = Array.isArray(input?.files) ? input.files.length : 0;
    return `生成脚手架：${root} 下 ${dirCount} 个目录，${fileCount} 个文件`;
  },

  async execute(params) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const rootPath = path.resolve(cwd, _expandPath(params.root || '.'));

      // [SAFE] validateInput() ran validateNoPathTraversal on the RAW params.root,
      // but _expandPath() above expands env vars (%SystemRoot%, $VAR) and ~ AFTER
      // that check. A root like "%SystemRoot%\\Temp\\x" passes validation as a
      // literal segment under cwd, then expands to C:\Windows\Temp — escaping the
      // sandbox so every scaffolded directory/file lands in a system location
      // (Agent privilege escalation). The per-file _inScope() guard only confines
      // entries RELATIVE to rootPath; it cannot catch an escaped rootPath itself.
      // Re-confine the EXPANDED root before any mkdir/write, mirroring the
      // writeFile/editFile/unpack fixes. Scaffolding under the project or the
      // user's home/Desktop/Documents/Downloads still passes unchanged.
      {
        const { validateNoPathTraversal } = require('./inputValidators');
        const confineCheck = validateNoPathTraversal(rootPath);
        if (!confineCheck.valid) return { success: false, error: confineCheck.message };
      }

      const overwrite = params.overwrite === true;
      const writeConcurrency = Math.max(1, Math.min(16, Number(params.writeConcurrency) || 4));
      const directories = _normalizeDirectories(params.directories);
      const files = _normalizeFiles(params.files);

      const createdDirectories = [];
      const createdFiles = [];
      const overwrittenFiles = [];
      const skippedFiles = [];
      const failedFiles = [];

      if (!fs.existsSync(rootPath)) {
        fs.mkdirSync(rootPath, { recursive: true });
        createdDirectories.push(path.relative(cwd, rootPath) || '.');
      }

      for (const relDir of directories) {
        const absDir = path.resolve(rootPath, relDir);
        if (!_inScope(absDir, rootPath)) {
          return { success: false, error: `Directory path escapes root: ${relDir}` };
        }
        if (!fs.existsSync(absDir)) {
          fs.mkdirSync(absDir, { recursive: true });
          createdDirectories.push(path.relative(cwd, absDir));
        }
      }

      const jobs = files.map((entry) => async () => {
        try {
          const absPath = path.resolve(rootPath, entry.path);
          if (!_inScope(absPath, rootPath)) {
            failedFiles.push({ path: entry.path, error: 'Path escapes root.' });
            return;
          }
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            createdDirectories.push(path.relative(cwd, dir));
          }
          const exists = fs.existsSync(absPath);
          if (exists && !overwrite) {
            skippedFiles.push(path.relative(cwd, absPath));
            return;
          }
          await fs.promises.writeFile(absPath, entry.content, 'utf-8');
          if (exists) overwrittenFiles.push(path.relative(cwd, absPath));
          else createdFiles.push(path.relative(cwd, absPath));
        } catch (err) {
          failedFiles.push({ path: entry.path, error: err.message || 'write failed' });
        }
      });

      let index = 0;
      const workers = Array.from({ length: Math.min(writeConcurrency, jobs.length || 1) }, async () => {
        while (index < jobs.length) {
          const current = index;
          index += 1;
          await jobs[current]();
        }
      });
      await Promise.all(workers);

      if (failedFiles.length > 0) {
        return {
          success: false,
          error: `Failed to create ${failedFiles.length} files.`,
          failedFiles,
          root: rootPath,
          createdDirectories: [...new Set(createdDirectories)].sort(),
          createdFiles: createdFiles.sort(),
          overwrittenFiles: overwrittenFiles.sort(),
          skippedFiles: skippedFiles.sort(),
        };
      }

      return {
        success: true,
        root: rootPath,
        writeConcurrency,
        createdDirectoryCount: [...new Set(createdDirectories)].length,
        createdFileCount: createdFiles.length,
        overwrittenFileCount: overwrittenFiles.length,
        skippedFileCount: skippedFiles.length,
        createdDirectories: [...new Set(createdDirectories)].sort(),
        createdFiles: createdFiles.sort(),
        overwrittenFiles: overwrittenFiles.sort(),
        skippedFiles: skippedFiles.sort(),
      };
    } catch (err) {
      return { success: false, error: err.message || 'scaffoldFiles failed.' };
    }
  },
});
