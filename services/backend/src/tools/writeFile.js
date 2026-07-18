const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
let _fileHistory;
try { _fileHistory = require('../services/fileHistoryService'); } catch { _fileHistory = null; }

module.exports = defineTool({
  name: 'writeFile',
  description: 'Write content to a file on the filesystem',
  category: 'filesystem',
  risk: 'high',
  isReadOnly: false,
  isDestructive: (input) => {
    // Overwriting an existing file is destructive
    if (!input?.path) return false;
    try {
      const resolved = require('path').resolve(
        process.env.KHYQUANT_CWD || process.cwd(), input.path
      );
      return require('fs').existsSync(resolved);
    } catch { return false; }
  },
  isConcurrencySafe: false,

  // Chapter 5 additions
  maxResultSizeChars: 1000, // write results are tiny

  inputSchema: {
    path: { type: 'string', required: true, description: 'File path (relative to CWD or absolute)' },
    content: { type: 'string', required: true, description: 'Content to write' },
  },

  async validateInput(input) {
    const { validateNotUNCPath, validateNoPathTraversal, composeValidations } = require('./inputValidators');
    return composeValidations(
      validateNotUNCPath(input.path),
      validateNoPathTraversal(input.path),
    );
  },

  getActivityDescription(input) {
    return `写入文件：${input.path || 'file'}`;
  },

  async execute(params, context) {
    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      // Expand environment variables in path (%USERNAME%, $HOME, ~)
      let rawPath = params.path;
      if (process.platform === 'win32') {
        rawPath = rawPath.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
      } else {
        rawPath = rawPath.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
      }
      if (rawPath.startsWith('~')) {
        rawPath = path.join(require('os').homedir(), rawPath.slice(1));
      }
      // Map a desktop-alias folder (e.g. ~/桌面) to the OS-canonical desktop so
      // "save it to my desktop" lands where the GUI shows it. Best-effort no-op.
      try { rawPath = require('./_userDirs').normalizeDesktopPath(rawPath); } catch { /* ignore */ }

      // [SAFE] Re-validate AFTER variable/~ expansion. validateInput() ran the
      // path-confinement check on the RAW params.path, but the expansions above
      // can inject an absolute system path (or `..` segments) that were invisible
      // at validation time: e.g. "%SystemRoot%\\System32\\x" or "$FOO/passwd"
      // where the variable is a literal segment under cwd at check time, then
      // expands to a path that escapes the project / trusted user roots into a
      // system location. That is an Agent-controlled sandbox escape / privilege
      // escalation. Re-run the same confinement (and UNC) check on the expanded
      // path and refuse before any write. Legitimate writes under the user's
      // home/Desktop/Documents/Downloads still pass unchanged.
      {
        const { validateNotUNCPath, validateNoPathTraversal } = require('./inputValidators');
        const uncCheck = validateNotUNCPath(rawPath);
        if (!uncCheck.valid) return { success: false, error: uncCheck.message };
        const confineCheck = validateNoPathTraversal(rawPath);
        if (!confineCheck.valid) return { success: false, error: confineCheck.message };
      }

      const filePath = path.resolve(cwd, rawPath);
      const dir = path.dirname(filePath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Take snapshot before overwrite
      if (_fileHistory && fs.existsSync(filePath)) {
        try { _fileHistory.takeSnapshot(filePath, { reason: 'writeFile' }); } catch { /* non-critical */ }
      }

      fs.writeFileSync(filePath, params.content, 'utf-8');
      const bytes = Buffer.byteLength(params.content, 'utf-8');
      return { success: true, path: filePath, bytes };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
