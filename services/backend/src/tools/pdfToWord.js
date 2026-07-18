const { defineTool } = require('./_baseTool');
const { spawn, execFileSync } = require('child_process');
const { safeKill } = require('./platformUtils');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DOC_HELPER = path.join(__dirname, '../services/docHelper.py');
const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50 MB

let _enabled = null;
const _checkEnabled = require('../utils/docHelperEnabled');

const resolvePath = require('../utils/resolveToolPath');

function runPython(pythonPath, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const child = spawn(pythonPath, args, { env });

    let stdout = '';
    let stderr = '';

    // Activity-aware idle timeout (resets on stdout/stderr data)
    let _idleTimer = null;
    const IDLE_MS = 120000;
    const _resetIdle = () => {
      if (_idleTimer) clearTimeout(_idleTimer);
      _idleTimer = setTimeout(() => {
        safeKill(child);
        reject(new Error(`Python PDF conversion idle timeout (${IDLE_MS / 1000}s without output)`));
      }, IDLE_MS);
    };
    _resetIdle();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; _resetIdle(); });
    child.stderr.on('data', d => { stderr += d; _resetIdle(); });

    child.on('error', err => {
      if (_idleTimer) clearTimeout(_idleTimer);
      reject(new Error(`Python process error: ${err.message}`));
    });

    child.on('close', code => {
      if (_idleTimer) clearTimeout(_idleTimer);
      if (code !== 0) {
        reject(new Error(`Python exit code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(`Failed to parse Python output: ${e.message}`));
      }
    });
  });
}

module.exports = defineTool({
  name: 'pdfToWord',
  description: 'Convert a PDF file to Word (.docx) format',
  category: 'filesystem',
  risk: 'medium',
  isReadOnly: false,
  isEnabled() {
    if (_enabled === null) _enabled = _checkEnabled();
    return _enabled;
  },
  isConcurrencySafe: true,

  aliases: ['pdf_to_word', 'pdf2word', 'pdf2docx'],
  searchHint: 'convert pdf to word docx document',

  inputSchema: {
    inputPath: { type: 'string', required: true, description: 'Path to the source PDF file' },
    outputPath: { type: 'string', required: false, description: 'Path for the output .docx file (default: same name with .docx extension)' },
  },

  async validateInput(input) {
    const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
    return composeValidations(
      validateNotDevicePath(input.inputPath),
      validateNotUNCPath(input.inputPath),
      input.outputPath ? validateNotUNCPath(input.outputPath) : { valid: true },
    );
  },

  getActivityDescription(input) {
    const name = input?.inputPath ? path.basename(input.inputPath) : 'file';
    return `转换 PDF 到 Word：${name}`;
  },

  getToolUseSummary(input) {
    if (!input?.inputPath) return null;
    return `PDF 转 Word：${input.inputPath}`;
  },

  async execute(params) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const inputPath = resolvePath(params.inputPath, cwd);
    const outputPath = params.outputPath
      ? resolvePath(params.outputPath, cwd)
      : inputPath.replace(/\.pdf$/i, '.docx');

    // [SAFE] validateInput() only ran UNC/device checks on the RAW inputPath and
    // never saw outputPath. resolvePath() expands ~/$VAR/%VAR% to an ABSOLUTE host
    // path. Without this the Agent could WRITE the .docx anywhere — clobber a
    // user's documents or seed a watched/auto-run dir (arbitrary write / privilege
    // escalation). Confine the expanded WRITE target to the project tree or the
    // user's own home/Desktop/Documents/Downloads, mirroring the createDocument
    // fix. (The inputPath READ is left unconfined: PDF tools legitimately convert
    // transient files under /tmp and session dirs, and the read is ext-gated.)
    {
      const { validateNoPathTraversal } = require('./inputValidators');
      const outCheck = validateNoPathTraversal(outputPath);
      if (!outCheck.valid) return { success: false, error: outCheck.message };
    }

    if (!fs.existsSync(inputPath)) {
      return { success: false, error: `File not found: ${inputPath}` };
    }

    const stat = fs.statSync(inputPath);
    if (stat.size > MAX_PDF_SIZE) {
      return { success: false, error: `PDF too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 50MB)` };
    }

    const { findPython } = require('../utils/pythonPath');
    const pythonPath = findPython();

    try {
      const result = await runPython(pythonPath, [DOC_HELPER, 'pdf2word', inputPath, outputPath]);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
