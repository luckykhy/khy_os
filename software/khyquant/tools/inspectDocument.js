/**
 * inspectDocument — read-only **format inspector** (the counterpart to renderDocument).
 *
 * Answers "what is this file, and exactly how is it formatted?" across the project's
 * file types. It NEVER writes — it only reports:
 *
 *   - Precise file format: by extension AND content magic (md/docx/pdf/.c/.cpp/.java/
 *     .moon/.mbt/...), flagging extension↔content mismatches (e.g. a .txt that is really
 *     a PDF). Backed by the single-source fileFormatDetector.
 *   - Document formatting attributes the user cares about: font (ascii + eastAsia),
 *     font size, heading-1 style, first-line indent (cm + CJK chars), line spacing,
 *     page size/margins. For .docx/.pdf this runs the deterministic Python inspector
 *     (docInspect.py); plain text / Markdown / source are inspected in-process and
 *     report a structural outline (visual formatting is N/A and labelled as such).
 *
 * Routing:
 *   docx / pdf  → spawn docInspect.py (needs a Python interpreter; for docx also
 *                 python-docx, for pdf also PyMuPDF — missing deps fail soft with an
 *                 install hint, never a crash).
 *   everything  → in-process via fileFormatDetector + a light outline (no Python).
 *     else
 */
const { defineTool } = require('./_baseTool');
const { spawn } = require('child_process');
const { safeKill } = require('./platformUtils');
const path = require('path');
const fs = require('fs');

const { detectFile } = require('../services/formatInspect/fileFormatDetector');

const DOC_INSPECT = path.join(__dirname, '../services/docInspect.py');
const IDLE_TIMEOUT_MS = 60000;
const PY_FORMATS = new Set(['docx', 'pdf']);

const _resolvePath = require('../utils/resolveUserPath');

/** Run docInspect.py with a sliding idle timeout that resets on output. */
function _runInspect(pythonPath, absPath) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const child = spawn(pythonPath, [DOC_INSPECT, 'inspect', absPath], { env });

    let stdout = '';
    let stderr = '';
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        safeKill(child);
        reject(new Error('Document inspection idle-timed out (60s with no output)'));
      }, IDLE_TIMEOUT_MS);
    };
    arm();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; arm(); });
    child.stderr.on('data', (d) => { stderr += d; arm(); });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Python process error: ${err.message}`));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        if (code !== 0) { reject(new Error(`Python exit code ${code}: ${stderr || stdout}`)); return; }
        reject(new Error(`Failed to parse inspector output: ${e.message}`));
      }
    });
  });
}

/** In-process structural inspection for text / markdown / source (no Python needed). */
function _inspectTextInProcess(absPath, fmt) {
  let content;
  try { content = fs.readFileSync(absPath, 'utf-8'); } catch (e) {
    return { success: false, error: `read failed: ${e.message}` };
  }
  const lines = content.split(/\r?\n/);
  const isMarkdown = fmt.format === 'markdown';
  const outline = [];
  if (isMarkdown) {
    for (const ln of lines) {
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(ln);
      if (m) outline.push({ level: m[1].length, text: m[2].slice(0, 120) });
    }
  }
  const paragraphs = content.split(/\n\s*\n/).filter((p) => p.trim());
  return {
    success: true,
    format: fmt.format,
    note: '纯文本/源码无字体字号等视觉格式属性；以下为结构信息。',
    summary: {
      lineCount: lines.length,
      paragraphCount: paragraphs.length,
      charCount: content.length,
      headingCount: outline.length,
    },
    outline: outline.slice(0, 200),
  };
}

module.exports = defineTool({
  name: 'inspectDocument',
  description:
    "Inspect a file's precise FORMAT without modifying it. Reports the exact file format " +
    '(by extension AND content magic — md/docx/pdf/.c/.cpp/.java/.moon/.mbt/…, flagging any ' +
    "extension↔content mismatch), and for documents the formatting attributes a user asks about: " +
    'font (ascii + CJK eastAsia), font size, heading-1 style, first-line indent, line spacing, and ' +
    'page size/margins. Use before editing a document, to answer "what font/size/indent/spacing does ' +
    'this use?", or to reproduce a document\'s style. Read-only. .docx/.pdf need Python (missing libs ' +
    'fail soft with an install hint); text/markdown/source are inspected without Python.',
  category: 'filesystem',
  risk: 'low',
  isReadOnly: true,
  isConcurrencySafe: true,

  aliases: ['inspect_document', 'inspect_format', 'doc_format', 'read_format'],
  searchHint: 'inspect format font size heading indent line spacing docx pdf 字体 字号 一级标题 首行缩进 行距 格式 识别',

  inputSchema: {
    file_path: {
      type: 'string',
      required: true,
      description: 'Path to the file to inspect. e.g. ~/Desktop/report.docx or an absolute path.',
    },
  },

  getActivityDescription(input) {
    return `检查格式：${input?.file_path ? path.basename(input.file_path) : 'file'}`;
  },
  getToolUseSummary(input) {
    if (!input?.file_path) return null;
    return `检查文件格式：${path.basename(input.file_path)}`;
  },

  async execute(params) {
    const { file_path } = params || {};
    if (!file_path) return { success: false, error: 'file_path is required' };

    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const absPath = _resolvePath(file_path, cwd);

      // Read-access policy: reads default to globally readable; out-of-scope reads
      // escalate to approval (KHY_STRICT_READ_BOUNDARY=1) rather than hard-failing.
      {
        const { validateNotUNCPath, validateReadAccess } = require('./inputValidators');
        const unc = validateNotUNCPath(absPath);
        if (!unc.valid) return { success: false, error: unc.message };
        const access = validateReadAccess(absPath);
        if (!access.valid) return { success: false, error: access.message, approvable: access.approvable };
      }

      if (!fs.existsSync(absPath)) return { success: false, error: `File not found: ${absPath}` };

      // 读前防卡死统一前检(FIFO/设备/Windows 保留名/阻塞伪文件)—— 必须在 detectFile/readFileSync 触碰字节之前。
      try {
        const stat = fs.statSync(absPath);
        const { classifyPreReadHang } = require('./filePreReadHangGuard');
        const hang = classifyPreReadHang({ absPath, stat, env: process.env });
        if (hang && hang.blocked) return { success: false, error: hang.error, blockedRead: hang.kind };
      } catch { /* stat/判定失败 → 回退历史行为 */ }

      // 1) Precise format identification (single source).
      const fmt = detectFile(absPath);
      const detection = {
        format: fmt.format,
        language: fmt.language,
        category: fmt.category,
        mime: fmt.mime,
        isBinary: fmt.isBinary,
        confidence: fmt.confidence,
        mismatch: fmt.mismatch,
        sizeBytes: fmt.size,
      };
      if (fmt.mismatch) {
        detection.mismatchHint =
          `扩展名声称「${fmt.extFormat}」但内容实为「${fmt.magicFormat}」——以内容为准。`;
      }

      // 2) Format attributes.
      if (PY_FORMATS.has(fmt.format)) {
        if (!fs.existsSync(DOC_INSPECT)) {
          return { success: true, detection, formatting: null,
            note: 'docInspect.py 缺失，无法提取 docx/pdf 详细格式；已返回格式识别结果。' };
        }
        const { findPython } = require('../utils/pythonPath');
        let pythonPath;
        try { pythonPath = findPython(); } catch { pythonPath = null; }
        if (!pythonPath) {
          return {
            success: true,
            detection,
            formatting: null,
            needsDep: true,
            hint: '提取 docx/pdf 详细格式需要 Python 解释器。请安装 Python 3 后重试；' +
              'docx 另需 pip install khy-os[doc]（python-docx），pdf 另需 pymupdf。',
          };
        }
        try {
          const formatting = await _runInspect(pythonPath, absPath);
          return { success: true, detection, formatting };
        } catch (err) {
          return { success: true, detection, formatting: null, error: err.message,
            hint: 'docx 需 python-docx（pip install khy-os[doc]），pdf 需 pymupdf。' };
        }
      }

      // 3) Text / markdown / source — in-process, no Python.
      if (fmt.isBinary) {
        return { success: true, detection, formatting: null,
          note: '二进制文件，无文本结构可提取。' };
      }
      const formatting = _inspectTextInProcess(absPath, fmt);
      return { success: true, detection, formatting };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
