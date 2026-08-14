/**
 * convertFile — unified file-format conversion. The second instance of the
 * capability-as-code convention (DESIGN-ARCH-059): one shared core
 * (cli/handlers/convert.js `runConvert`) is exposed as both the `khy convert`
 * CLI command and this agent tool, with co-located tests, shipping with the
 * product via the wheel rather than living as an assistant memory note.
 *
 * Supported conversions (source → target):
 *   image → pdf   (single, or multiple/dir merged into one multi-page PDF)
 *   image → txt   (OCR)
 *   pdf   → txt   (text-layer extraction; scanned PDFs rejected with a hint)
 *   pdf   → docx  (via pdf2docx)
 *   docx  → txt
 *   txt   → docx
 *
 * Needs Python + the document extras (pip install khy-os[doc]); fails soft with
 * an install hint when a backing library is missing.
 */
const { defineTool } = require('./_baseTool');
const path = require('path');


let _enabled = null;
const _checkEnabled = require('../utils/docHelperEnabled');

module.exports = defineTool({
  name: 'convertFile',
  description:
    'Convert a file between common formats. Supported: image→PDF (one image, or ' +
    'multiple images / a folder merged into a single multi-page PDF), image→TXT (OCR), ' +
    'PDF→TXT (text-layer extraction), PDF→Word(.docx), Word(.docx)→TXT, TXT→Word(.docx). ' +
    'Pass `to` to pick the target explicitly, or it is inferred from the output extension ' +
    '/ source type. Writes to `output` (defaults to a sibling file with the target ' +
    'extension, never overwriting the source). Needs Python + python libs (pip install ' +
    'khy-os[doc]); fails soft with an install hint.',
  category: 'filesystem',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: true,
  isEnabled() {
    if (_enabled === null) _enabled = _checkEnabled();
    return _enabled;
  },

  aliases: ['convert', 'convert_file', 'file_convert', 'to_pdf', 'to_txt', 'image_to_pdf'],
  searchHint: 'convert format image pdf txt docx word ocr merge 图片 转 合并 文本 可编辑 格式转换',

  inputSchema: {
    input: {
      type: 'string',
      required: true,
      description:
        'Path to the input file. For image→PDF you may pass multiple comma-separated ' +
        'image paths, or a folder of images, to merge them into one PDF. e.g. ~/Desktop/a.png',
    },
    output: {
      type: 'string',
      required: false,
      description: 'Where to save the result. Defaults to a sibling file with the target extension.',
    },
    to: {
      type: 'string',
      required: false,
      enum: ['pdf', 'txt', 'docx'],
      description: 'Target format. If omitted, inferred from the output extension or the source type.',
    },
  },

  async validateInput(input) {
    const { validateNotUNCPath, validateNotDevicePath, composeValidations } = require('./inputValidators');
    // `input` may be a comma-separated list for image merges; the runConvert
    // core resolves+confines each path. Here we only sanity-check the obvious.
    const first = String(input.input || '').split(',')[0].trim();
    return composeValidations(
      first ? validateNotUNCPath(first) : { valid: true },
      first ? validateNotDevicePath(first) : { valid: true },
      input.output ? validateNotUNCPath(input.output) : { valid: true },
    );
  },

  capability: {
    summary: '统一格式转换:图片→PDF(可多图合并)/图片→可编辑TXT(OCR)/PDF→TXT/PDF→Word/Word→TXT/TXT→Word',
    learnedFrom: '2026-06 用户教学:图片转PDF或转可编辑txt等格式转换',
    tests: ['tests/convertFile.test.js'],
    surfaces: ['cli', 'agent', 'mcp'],
  },

  getActivityDescription(input) {
    const name = input?.input ? path.basename(String(input.input).split(',')[0]) : 'file';
    return `格式转换：${name}`;
  },
  getToolUseSummary(input) {
    if (!input?.input) return null;
    const name = path.basename(String(input.input).split(',')[0]);
    return input.to ? `转换为 ${input.to}：${name}` : `格式转换：${name}`;
  },

  async execute(params) {
    if (!params?.input) return { success: false, error: 'Input file (or images) is required' };
    try {
      const { runConvert } = require('../cli/handlers/convert');
      return await runConvert(params);
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
