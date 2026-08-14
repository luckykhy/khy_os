/**
 * renderDocument — deterministic, template-driven document typesetting.
 *
 * The format-control counterpart to createDocument. Where createDocument dumps
 * one paragraph per newline with ZERO style control, renderDocument enforces the
 * "content vs. style separation" architecture:
 *
 *   model → SEMANTIC content only (Markdown or the document AST)
 *   tool  → parse to AST, REJECT any raw format code (LaTeX/HTML/docx-XML),
 *           resolve a style template, hand {ast, template, output} to the
 *           deterministic Python renderer (docTypeset.py / python-docx)
 *   render→ apply page/paragraph/font/pagination rules, verify (A4, eastAsia,
 *           heading sizes), patch mismatches in place — never bounce to the model
 *
 * The model never writes \textbf, \newpage, <b>, setFont, or any presentation
 * code. Formatting lives entirely in the template (src/templates/docstyles/*.json)
 * and is applied by program, deterministically.
 *
 * 防呆 honored here (tool layer only; scheduler untouched):
 *   - Intercepts raw typesetting/markup codes → forces structured input.
 *   - Page breaks come ONLY from the structured `pagebreak` block or the
 *     template's page-break-before policy, never from whitespace.
 *   - Chinese eastAsia handling is enforced downstream in docTypeset.py.
 */
const { defineTool } = require('./_baseTool');
const { spawn } = require('child_process');
const { safeKill } = require('./platformUtils');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { markdownToAst } = require('../services/typeset/markdownToAst');
const { validateDocument } = require('../services/typeset/contentSchema');
const { resolveTemplate, listTemplates } = require('../services/typeset/styleTemplates');

const DOC_TYPESET = path.join(__dirname, '../services/docTypeset.py');
const MAX_CONTENT_SIZE = 4 * 1024 * 1024; // 4 MB structured content cap
const IDLE_TIMEOUT_MS = 60000;

let _enabled = null;
function _checkEnabled() {
  if (!fs.existsSync(DOC_TYPESET)) return false;
  for (const py of ['python3', 'python']) {
    try {
      require('child_process').execFileSync(py, ['--version'], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch { /* try next */ }
  }
  return false;
}

const _resolvePath = require('../utils/resolveUserPath');

/**
 * Coerce the model-supplied `content` into a validated document AST.
 * Accepts: a document-AST object, an AST JSON string, or a Markdown string.
 * @returns {{ast?: object, error?: string}}
 */
function _toAst(content, title) {
  let ast = null;

  if (content && typeof content === 'object' && !Array.isArray(content)) {
    ast = content;
  } else if (typeof content === 'string') {
    const trimmed = content.trim();
    // Try AST JSON first (object with a blocks array); otherwise treat as Markdown.
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && Array.isArray(parsed.blocks)) ast = parsed;
      } catch { /* not JSON → fall through to Markdown */ }
    }
    if (!ast) ast = markdownToAst(content);
  } else {
    return { error: 'content must be a Markdown string or a document AST object/JSON' };
  }

  if (title && !ast.title) ast.title = String(title);

  // 防呆 interception: structural validation + reject any smuggled format code.
  const v = validateDocument(ast);
  if (!v.valid) return { error: v.error };
  return { ast };
}

/** Run docTypeset.py with an idle (sliding) timeout that resets on output. */
function _runTypeset(pythonPath, payloadPath) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const child = spawn(pythonPath, [DOC_TYPESET, 'render', payloadPath], { env });

    let stdout = '';
    let stderr = '';
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        safeKill(child);
        reject(new Error('Document typesetting idle-timed out (60s with no output)'));
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
      if (code !== 0) {
        reject(new Error(`Python exit code ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(`Failed to parse renderer output: ${e.message}`));
      }
    });
  });
}

module.exports = defineTool({
  name: 'renderDocument',
  description:
    'Typeset a polished Word (.docx) document from SEMANTIC content using a style ' +
    'template. You provide only the content — as Markdown (#, ##, lists, > quotes, ' +
    'tables, ``` code) or a document AST — and NEVER any formatting code. All fonts, ' +
    'sizes, margins, line spacing, indentation, and page breaks come from the template ' +
    '(default | gbt7714 | ieee). Use this for papers, theses, and reports that need ' +
    'precise, consistent formatting. To force a page break, use a `[[newpage]]` line ' +
    '(Markdown) or a {"type":"pagebreak"} block (AST) — never blank lines.',
  category: 'filesystem',
  risk: 'medium',
  isReadOnly: false,
  isEnabled() {
    if (_enabled === null) _enabled = _checkEnabled();
    return _enabled;
  },
  isConcurrencySafe: true,

  aliases: ['typeset_document', 'render_document', 'render_docx', 'create_paper', 'typeset_docx'],
  searchHint: 'typeset format paper thesis report docx word academic gb7714 ieee style template 排版 论文 格式',

  inputSchema: {
    content: {
      type: 'string',
      required: true,
      description:
        'SEMANTIC content only: Markdown (preferred) or a document AST as JSON. ' +
        'Use # / ## for headings, - or 1. for lists, > for quotes, | for tables, ``` for code, ' +
        '**bold**/*italic* for emphasis, and a [[newpage]] line to force a page break. ' +
        'Do NOT include any LaTeX (\\textbf, \\newpage), HTML tags (<b>), or other format codes — they are rejected.',
    },
    outputPath: {
      type: 'string',
      required: true,
      description: 'Where to save the .docx. e.g. ~/Desktop/paper.docx or an absolute path.',
    },
    template: {
      type: 'string',
      required: false,
      description: 'Style template: "default" (general A4), "gbt7714" (国标中文学术), or "ieee". ' +
        'May also be an absolute path to a custom JSON template. Defaults to "default".',
    },
    title: {
      type: 'string',
      required: false,
      description: 'Optional document title, rendered with the template title style.',
    },
    overrides: {
      type: 'object',
      required: false,
      description: 'Optional partial template object to deep-merge over the chosen template, ' +
        'e.g. {"paragraph":{"lineSpacing":2}}. Lets you tweak any single style key without restating the baseline.',
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
    const tpl = input?.template || 'default';
    return `排版文档：${name}（模板 ${tpl}）`;
  },

  getToolUseSummary(input) {
    if (!input?.outputPath) return null;
    return `按模板排版文档：${input.outputPath}`;
  },

  async execute(params) {
    if (!params?.content || (typeof params.content === 'string' && !params.content.trim())) {
      return { success: false, error: 'Document content is required' };
    }
    if (!params?.outputPath) {
      return { success: false, error: 'Output path is required' };
    }
    if (typeof params.content === 'string' && Buffer.byteLength(params.content, 'utf-8') > MAX_CONTENT_SIZE) {
      return { success: false, error: 'Content too large (max 4MB)' };
    }

    // 1) Content → validated AST (rejects any raw format code — 防呆 interception).
    const { ast, error: astError } = _toAst(params.content, params.title);
    if (astError) {
      return {
        success: false,
        error: `Structured-content check failed: ${astError}`,
        hint: 'Emit semantic content only (Markdown headings/lists/tables or a document AST). ' +
          'Formatting is applied by the template — do not write format codes.',
      };
    }

    // 2) Resolve the style template (+ optional overrides).
    const { template, error: tplError, source } = resolveTemplate(params.template, params.overrides);
    if (tplError) {
      return {
        success: false,
        error: tplError,
        availableTemplates: listTemplates().map((t) => t.name),
      };
    }

    // 3) Resolve + confine the output path (mirrors createDocument's expanded-path
    //    re-confinement: validateInput only saw the raw path).
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    let outputPath = _resolvePath(params.outputPath, cwd);
    if (!/\.docx$/i.test(outputPath)) outputPath += '.docx';
    {
      const { validateNoPathTraversal } = require('./inputValidators');
      const confine = validateNoPathTraversal(outputPath);
      if (!confine.valid) return { success: false, error: confine.message };
    }

    // 4) Hand {ast, template, output} to the deterministic renderer via a temp
    //    payload file (avoids shell arg-length limits for large content).
    const payloadPath = path.join(
      os.tmpdir(),
      `khy-typeset-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`,
    );
    try {
      fs.writeFileSync(payloadPath, JSON.stringify({ ast, template, output: outputPath }), 'utf-8');
    } catch (e) {
      return { success: false, error: `Could not stage render payload: ${e.message}` };
    }

    const { findPython } = require('../utils/pythonPath');
    const pythonPath = findPython();
    try {
      const result = await _runTypeset(pythonPath, payloadPath);
      if (result && result.success) {
        result.template = source;
      }
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      try { fs.unlinkSync(payloadPath); } catch { /* best-effort temp cleanup */ }
    }
  },
});
