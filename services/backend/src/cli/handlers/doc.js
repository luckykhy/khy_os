'use strict';

/**
 * Document Command Handler — `khy doc …`.
 *
 * Home of the document-editing capabilities. The first one is `doc title`:
 * restyle a Word (.docx) title/heading/caption to a given font size and color.
 *
 * This handler is the SINGLE shared core: both the CLI (`khy doc title`) and
 * the agent tool (`tools/docTitleStyle.js`) call `runTitleStyle()` here, so the
 * behavior, validation and path-confinement live in exactly one place
 * (mirroring the quote.js → handlers/data pattern).
 *
 *   doc title <input.docx> [--output out.docx] [--match "标题文字"]
 *             [--style "Title"] [--size 18] [--color C00000]
 *
 * @module handlers/doc
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { safeKill } = require('../../tools/platformUtils');

const DOC_HELPER = path.join(__dirname, '../../services/docHelper.py');
const IDLE_TIMEOUT_MS = 60000;

/** Expand ~ / $VAR / %VAR% and resolve against cwd (mirrors createDocument.js). */
const _resolvePath = require('../../utils/resolveUserPath');

/** Spawn docHelper.py title-style with an idle timeout; resolve parsed JSON. */
function _spawnTitleStyle(pythonPath, argv, deps = {}) {
  const spawnImpl = deps.spawn || spawn;
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    const child = spawnImpl(pythonPath, [DOC_HELPER, 'title-style', ...argv], { env });

    let stdout = '';
    let stderr = '';
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        safeKill(child);
        reject(new Error('Title restyle idle-timed out (60s with no output)'));
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

/**
 * Core capability: restyle a Word title/heading to a font size and/or color.
 * Returns a structured result; never throws. This is what both the CLI handler
 * and the agent tool call.
 *
 * @param {object} opts
 * @param {string} opts.path        - Input .docx path.
 * @param {string} [opts.output]    - Output path; defaults to a sibling *.styled.docx.
 * @param {string} [opts.match]     - Exact paragraph text to target.
 * @param {string} [opts.style]     - Explicit style name (else built-in title set).
 * @param {number|string} [opts.size] - Font size in points.
 * @param {string} [opts.color]     - Hex color (3/6 digits, with or without '#').
 * @param {object} [deps]           - Test seam: { spawn, findPython }.
 * @returns {Promise<object>} { success, output?, changed?, error?, ... }
 */
async function runTitleStyle(opts = {}, deps = {}) {
  const inputRaw = opts.path || opts.input;
  if (!inputRaw) return { success: false, error: 'Input .docx path is required' };
  if (opts.size === undefined && !opts.color) {
    return { success: false, error: 'Nothing to change: provide size and/or color.' };
  }

  const cwd = process.env.KHYQUANT_CWD || process.cwd();
  const inputPath = _resolvePath(inputRaw, cwd);

  // Default output: a sibling *.styled.docx so we never silently overwrite the source.
  let outputRaw = opts.output;
  if (!outputRaw) {
    const ext = path.extname(inputPath) || '.docx';
    outputRaw = inputPath.slice(0, inputPath.length - ext.length) + '.styled' + ext;
  }
  const outputPath = _resolvePath(outputRaw, cwd);

  // Confine BOTH paths to the project tree / user's own dirs — the resolved
  // absolute paths were invisible to any earlier schema validation, so an Agent
  // could otherwise read/clobber files anywhere. Mirrors createDocument.js.
  {
    const { validateNoPathTraversal, validateNotUNCPath } = require('../../tools/inputValidators');
    for (const p of [inputPath, outputPath]) {
      const unc = validateNotUNCPath(p);
      if (!unc.valid) return { success: false, error: unc.message };
      const confine = validateNoPathTraversal(p);
      if (!confine.valid) return { success: false, error: confine.message };
    }
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
      error: '修改 Word 标题需要 Python 解释器。请安装 Python 3 后重试，并 pip install khy-os[doc]。',
      hint: 'pip install khy-os[doc]',
    };
  }

  const argv = [inputPath, outputPath];
  if (opts.match) argv.push('--match', String(opts.match));
  if (opts.style) argv.push('--style', String(opts.style));
  if (opts.size !== undefined && opts.size !== null && String(opts.size) !== '') {
    argv.push('--size', String(opts.size));
  }
  if (opts.color) argv.push('--color', String(opts.color));

  try {
    return await _spawnTitleStyle(pythonPath, argv, deps);
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * CLI entry: `khy doc …`. Resolves params from the parsed command, runs the
 * capability core, and prints a human-readable result.
 * @param {object} parsed - { subCommand, args, options }
 * @returns {Promise<boolean>}
 */
async function handleDoc(parsed = {}) {
  const { printInfo, printError, printSuccess, printWarn } = require('../formatters');
  const sub = String(parsed.subCommand || '').toLowerCase();
  const args = Array.isArray(parsed.args) ? parsed.args : [];
  const options = parsed.options || {};

  if (sub !== 'title') {
    printError('用法: doc title <文件.docx> [--match 标题文字] [--style 样式] [--size 字号pt] [--color 颜色hex]');
    return true;
  }

  // Tool calls pass everything in `options`; CLI passes the input as the first
  // positional and the rest as --flags.
  const opts = {
    path: options.path || args[0],
    output: options.output,
    match: options.match,
    style: options.style,
    size: options.size,
    color: options.color,
  };

  if (!opts.path) {
    printError('用法: doc title <文件.docx> [--match 标题文字] [--size 18] [--color C00000]');
    return true;
  }

  const result = await runTitleStyle(opts);
  if (result.success) {
    printSuccess(result.message || `已重排标题样式 → ${result.output}`);
    printInfo(`输出：${result.output}`);
  } else if (result.needsDep) {
    printWarn(result.error);
  } else {
    printError(result.error || '标题重排失败');
    if (result.hint) printInfo(result.hint);
  }
  return true;
}

module.exports = { handleDoc, runTitleStyle };
