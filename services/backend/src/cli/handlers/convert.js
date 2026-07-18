'use strict';

/**
 * Convert Command Handler — `khy convert …`.
 *
 * The unified file-format conversion capability (DESIGN-ARCH-059, second
 * instance). One shared core, `runConvert()`, is exposed as both the
 * `khy convert` CLI command and the agent tool `tools/convertFile.js`, so the
 * format routing, validation and path-confinement live in exactly one place
 * (mirroring the doc.js → docTitleStyle pattern).
 *
 *   convert <input> [--output out] [--to pdf|txt|docx]
 *
 * Supported conversions (source → target):
 *   image → pdf   (single, or multiple/dir merged into one multi-page PDF)
 *   image → txt   (OCR; multiple images are OCR'd and concatenated)
 *   pdf   → txt   (text-layer extraction; scanned PDFs are rejected with a hint)
 *   pdf   → docx  (layout-preserving, via pdf2docx)
 *   docx  → txt   (paragraph text)
 *   txt   → docx  (one paragraph per line)
 *
 * @module handlers/convert
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { safeKill } = require('../../tools/platformUtils');

const DOC_HELPER = path.join(__dirname, '../../services/docHelper.py');
const IDLE_TIMEOUT_MS = 120000;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.tif', '.webp']);
const TARGET_EXT = { pdf: '.pdf', txt: '.txt', docx: '.docx' };

// from-kind → default target when neither --to nor an output extension is given.
const DEFAULT_TARGET = { image: 'pdf', pdf: 'txt', docx: 'txt', txt: 'docx' };

/** Expand ~ / $VAR / %VAR% and resolve against cwd (mirrors doc.js). */
const _resolvePath = require('../../utils/resolveUserPath');

/** Classify a path by extension into a conversion source-kind. */
function _kindOf(p) {
  const ext = path.extname(p).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.txt' || ext === '.text' || ext === '.md') return 'txt';
  return null;
}

/**
 * Normalize the `input` option into an ordered list of absolute file paths.
 * Accepts: an array, a comma-separated string, a single file, or a directory
 * (directories are enumerated for images, sorted by name for predictability).
 */
function _resolveInputs(rawInput, cwd) {
  let items;
  if (Array.isArray(rawInput)) {
    items = rawInput;
  } else if (typeof rawInput === 'string' && rawInput.includes(',')) {
    items = rawInput.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    items = [rawInput];
  }
  const resolved = items.map((it) => _resolvePath(it, cwd));

  // A single directory → enumerate its image files, sorted by name.
  if (resolved.length === 1) {
    try {
      if (fs.existsSync(resolved[0]) && fs.statSync(resolved[0]).isDirectory()) {
        const dir = resolved[0];
        const imgs = fs.readdirSync(dir)
          .filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()))
          .sort((a, b) => a.localeCompare(b))
          .map((n) => path.join(dir, n));
        return imgs; // may be empty → caller reports "no images found"
      }
    } catch { /* fall through to file list */ }
  }
  return resolved;
}

/** Spawn docHelper.py <sub> with an idle timeout; resolve parsed JSON. */
function _spawnHelper(pythonPath, sub, argv, deps = {}) {
  const spawnImpl = deps.spawn || spawn;
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const child = spawnImpl(pythonPath, [DOC_HELPER, sub, ...argv], { env });

    let stdout = '';
    let stderr = '';
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        safeKill(child);
        reject(new Error(`Conversion idle-timed out (${IDLE_TIMEOUT_MS / 1000}s with no output)`));
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
        reject(new Error(`Failed to parse output: ${e.message}`));
      }
    });
  });
}

function _supportedList() {
  return 'image→pdf, image→txt, pdf→txt, pdf→docx, docx→txt, txt→docx';
}

/**
 * Core capability: convert a file (or images) to a target format.
 * Returns a structured result; never throws. Called by both the CLI handler
 * and the agent tool.
 *
 * @param {object} opts
 * @param {string|string[]} opts.input - Input file, comma-separated files, a
 *                                        directory of images, or an array.
 * @param {string} [opts.output]        - Output path; defaults derived from target.
 * @param {'pdf'|'txt'|'docx'} [opts.to]- Explicit target format (else inferred).
 * @param {object} [deps]               - Test seam: { spawn, findPython }.
 * @returns {Promise<object>} { success, output?, error?, ... }
 */
async function runConvert(opts = {}, deps = {}) {
  const rawInput = opts.input != null ? opts.input : opts.path;
  if (rawInput == null || rawInput === '' || (Array.isArray(rawInput) && rawInput.length === 0)) {
    return { success: false, error: 'Input file (or images) is required.' };
  }

  const cwd = process.env.KHYQUANT_CWD || process.cwd();
  const inputs = _resolveInputs(rawInput, cwd);
  if (inputs.length === 0) {
    return { success: false, error: 'No convertible files found (empty directory or no images).' };
  }

  // Source kind comes from the first input; for a merge they should all match.
  const fromKind = _kindOf(inputs[0]);
  if (!fromKind) {
    return {
      success: false,
      error: `Unsupported input type: ${path.basename(inputs[0])}. Supported sources: image / pdf / docx / txt.`,
    };
  }

  // Target: explicit --to wins, else output extension, else per-source default.
  let to = opts.to ? String(opts.to).toLowerCase().replace(/^\./, '') : null;
  if (!to && opts.output) {
    const ext = path.extname(String(opts.output)).toLowerCase();
    to = { '.pdf': 'pdf', '.txt': 'txt', '.docx': 'docx' }[ext] || null;
  }
  if (!to) to = DEFAULT_TARGET[fromKind];
  if (!TARGET_EXT[to]) {
    return { success: false, error: `Unsupported target format: ${to}. Use one of: pdf, txt, docx.` };
  }

  const pair = `${fromKind}->${to}`;
  const SUPPORTED = new Set([
    'image->pdf', 'image->txt', 'pdf->txt', 'pdf->docx', 'docx->txt', 'txt->docx',
  ]);
  if (!SUPPORTED.has(pair)) {
    return {
      success: false,
      error: `No conversion from ${fromKind} to ${to}. Supported: ${_supportedList()}.`,
    };
  }

  // Default output path (never silently overwrites the source).
  const firstBase = inputs[0].slice(0, inputs[0].length - path.extname(inputs[0]).length);
  let outputRaw = opts.output;
  if (!outputRaw) {
    if (fromKind === 'image' && to === 'pdf' && inputs.length > 1) {
      outputRaw = firstBase + '.merged' + TARGET_EXT[to];
    } else {
      outputRaw = firstBase + TARGET_EXT[to];
    }
  }
  const outputPath = _resolvePath(outputRaw, cwd);

  // Confine the WRITE target to the project tree / the user's own dirs. The
  // resolved absolute path was invisible to any earlier schema validation, so
  // an Agent could otherwise clobber files anywhere. Mirrors doc.js.
  {
    const { validateNoPathTraversal, validateNotUNCPath } = require('../../tools/inputValidators');
    const unc = validateNotUNCPath(outputPath);
    if (!unc.valid) return { success: false, error: unc.message };
    const confine = validateNoPathTraversal(outputPath);
    if (!confine.valid) return { success: false, error: confine.message };
  }

  // Existence check for non-directory single inputs (images may come from a dir).
  for (const p of inputs) {
    if (!fs.existsSync(p)) return { success: false, error: `File not found: ${p}` };
  }

  let pythonPath;
  try {
    const findPython = deps.findPython || require('../../utils/pythonPath').findPython;
    pythonPath = findPython();
  } catch {
    pythonPath = null;
  }
  if (!pythonPath) {
    return {
      success: false,
      needsDep: true,
      error: '格式转换需要 Python 解释器。请安装 Python 3 后重试,并 pip install khy-os[doc]。',
      hint: 'pip install khy-os[doc]',
    };
  }

  try {
    // image → txt is special: docHelper `ocr` prints text to JSON (no file),
    // so OCR each image and write the concatenated text here.
    if (pair === 'image->txt') {
      const lang = opts.lang || 'chi_sim+eng';
      const parts = [];
      for (const img of inputs) {
        const r = await _spawnHelper(pythonPath, 'ocr', [img, lang], deps);
        if (!r || r.success === false) {
          return r || { success: false, error: 'OCR failed' };
        }
        parts.push(r.text || '');
      }
      const text = parts.join('\n\n').trim();
      fs.writeFileSync(outputPath, text, 'utf-8');
      return {
        success: true,
        output: outputPath,
        images: inputs.length,
        chars: text.length,
        message: `OCR ${inputs.length} image(s) → ${path.basename(outputPath)} (${text.length} chars)`,
      };
    }

    // The remaining conversions map 1:1 onto a docHelper subcommand.
    let sub;
    let argv;
    switch (pair) {
      case 'image->pdf': sub = 'img2pdf'; argv = [outputPath, ...inputs]; break;
      case 'pdf->txt': sub = 'pdf2txt'; argv = [inputs[0], outputPath]; break;
      case 'pdf->docx': sub = 'pdf2word'; argv = [inputs[0], outputPath]; break;
      case 'docx->txt': sub = 'docx2txt'; argv = [inputs[0], outputPath]; break;
      case 'txt->docx': sub = 'txt2docx'; argv = [inputs[0], outputPath]; break;
      default:
        return { success: false, error: `No conversion from ${fromKind} to ${to}.` };
    }
    return await _spawnHelper(pythonPath, sub, argv, deps);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * CLI entry: `khy convert <input> [--output out] [--to pdf|txt|docx]`.
 * The input is a positional argument; flags arrive in `options`.
 * @param {object} parsed - { subCommand, args, options }
 * @returns {Promise<boolean>}
 */
async function handleConvert(parsed = {}) {
  const { printInfo, printError, printSuccess, printWarn } = require('../formatters');
  const options = parsed.options || {};
  const args = Array.isArray(parsed.args) ? parsed.args : [];

  // `convert` takes a positional input. Depending on the parser the first token
  // may land in subCommand or args[0]; accept both, plus --input.
  const positional = [];
  if (parsed.subCommand) positional.push(parsed.subCommand);
  positional.push(...args);

  const opts = {
    input: options.input || (positional.length > 1 ? positional : positional[0]),
    output: options.output,
    to: options.to,
    lang: options.lang,
  };

  if (opts.input == null || opts.input === '') {
    printError('用法: convert <文件|图片,图片,…|目录> [--output 输出路径] [--to pdf|txt|docx]');
    printInfo(`支持的转换: ${_supportedList()}`);
    return true;
  }

  const result = await runConvert(opts);
  if (result.success) {
    printSuccess(result.message || `已转换 → ${result.output}`);
    printInfo(`输出：${result.output}`);
  } else if (result.needsDep) {
    printWarn(result.error);
    if (result.hint) printInfo(result.hint);
  } else {
    printError(result.error || '格式转换失败');
    if (result.hint) printInfo(result.hint);
  }
  return true;
}

module.exports = { handleConvert, runConvert };
