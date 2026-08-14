/**
 * createDocument — Create Word (.docx) documents from text content.
 *
 * Wraps docHelper.py text2docx. Designed for small local models (Qwen 7B etc.)
 * that need a single tool call to produce documents, rather than orchestrating
 * multi-step writeFile + binary conversion.
 *
 * Supports:
 *   - Plain text with newline paragraph separation
 *   - Markdown-like headings (# Title → bold paragraph)
 *   - ~ and $HOME expansion, %USERPROFILE% on Windows
 *   - Auto-generates filename if only a directory is given
 */
const { defineTool } = require('./_baseTool');
const { spawn } = require('child_process');
const { safeKill } = require('./platformUtils');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DOC_HELPER = path.join(__dirname, '../services/docHelper.py');
const MAX_TEXT_SIZE = 2 * 1024 * 1024; // 2 MB text limit

let _enabled = null;
function _checkEnabled() {
  if (!fs.existsSync(DOC_HELPER)) return false;
  try {
    require('child_process').execFileSync('python3', ['--version'], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    try {
      require('child_process').execFileSync('python', ['--version'], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch { return false; }
  }
}

function _resolvePath(rawPath, cwd) {
  let p = String(rawPath || '');
  if (process.platform === 'win32') {
    p = p.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
  } else {
    p = p.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
  }
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  // Map a desktop-alias folder to the OS-canonical desktop (best-effort no-op).
  try { p = require('./_userDirs').normalizeDesktopPath(path.resolve(cwd, p)); } catch { /* ignore */ }
  return path.resolve(cwd, p);
}

/**
 * Run docHelper.py text2docx via stdin (avoids shell argument length limits).
 */
function _runText2Docx(pythonPath, text, outputPath) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const child = spawn(pythonPath, [DOC_HELPER, 'text2docx', text, outputPath], { env });

    let stdout = '';
    let stderr = '';
    let _timer = setTimeout(() => {
      safeKill(child);
      reject(new Error('Document creation timed out (60s)'));
    }, 60000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('error', err => {
      clearTimeout(_timer);
      reject(new Error(`Python process error: ${err.message}`));
    });

    child.on('close', code => {
      clearTimeout(_timer);
      if (code !== 0) {
        reject(new Error(`Python exit code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(`Failed to parse output: ${e.message}`));
      }
    });
  });
}

module.exports = defineTool({
  name: 'createDocument',
  description: 'Create a Word (.docx) document from text content and save to the specified path. Supports Chinese and English text. Use this to create reports, articles, or any formatted document.',
  category: 'filesystem',
  risk: 'medium',
  isReadOnly: false,
  isEnabled() {
    if (_enabled === null) _enabled = _checkEnabled();
    return _enabled;
  },
  isConcurrencySafe: true,

  aliases: ['create_document', 'create_docx', 'write_docx', 'create_word'],
  searchHint: 'create write word document docx report article',

  inputSchema: {
    content: {
      type: 'string',
      required: true,
      description: 'The text content for the document. Use newlines to separate paragraphs.',
    },
    outputPath: {
      type: 'string',
      required: true,
      description: 'Where to save the .docx file. Can use ~/Desktop/report.docx or absolute path.',
    },
    title: {
      type: 'string',
      required: false,
      description: 'Optional document title (prepended as the first paragraph).',
    },
  },

  async validateInput(input) {
    const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
    return composeValidations(
      input.outputPath ? validateNotUNCPath(input.outputPath) : { valid: true },
      input.outputPath ? validateNotDevicePath(input.outputPath) : { valid: true },
    );
  },

  getActivityDescription(input) {
    const name = input?.outputPath ? path.basename(input.outputPath) : 'document';
    return `创建文档：${name}`;
  },

  getToolUseSummary(input) {
    if (!input?.outputPath) return null;
    return `创建 Word 文档：${input.outputPath}`;
  },

  async execute(params) {
    if (!params?.content || !String(params.content).trim()) {
      return { success: false, error: 'Document content is required' };
    }
    if (!params?.outputPath) {
      return { success: false, error: 'Output path is required' };
    }

    const content = String(params.content);
    if (Buffer.byteLength(content, 'utf-8') > MAX_TEXT_SIZE) {
      return { success: false, error: 'Content too large (max 2MB text)' };
    }

    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    let outputPath = _resolvePath(params.outputPath, cwd);

    // Auto-append .docx if missing
    if (!/\.docx$/i.test(outputPath)) {
      outputPath += '.docx';
    }

    // [SAFE] validateInput() only ran UNC/device checks on the RAW outputPath,
    // but _resolvePath() above expands ~, $VAR/%VAR% and path.resolve()s to an
    // ABSOLUTE host path that was invisible at validation time. Without this,
    // the Agent could write a .docx anywhere it pleases — clobber the user's
    // existing documents, drop a file into a watched/auto-run directory, or fill
    // a system location (Agent privilege escalation / arbitrary write). Re-confine
    // the EXPANDED path to the project tree or the user's own home/Desktop/
    // Documents/Downloads, mirroring the writeFile/editFile/scaffold fixes. The
    // documented use case (~/Desktop/report.docx) still passes unchanged.
    {
      const { validateNoPathTraversal } = require('./inputValidators');
      const confineCheck = validateNoPathTraversal(outputPath);
      if (!confineCheck.valid) return { success: false, error: confineCheck.message };
    }

    // Build final text: optional title + content
    let finalText = content;
    if (params.title) {
      finalText = `${params.title}\n\n${content}`;
    }

    const { findPython } = require('../utils/pythonPath');
    const pythonPath = findPython();

    try {
      const result = await _runText2Docx(pythonPath, finalText, outputPath);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
