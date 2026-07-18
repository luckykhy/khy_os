/**
 * replaceAtLocation — 文本文件的**精确定位替换**工具。
 *
 * 当某个词在文件中多次出现时，按「第几段 / 第几句 / 第几次出现」精确替换那一处，
 * 不会像普通 find/replace 那样误伤全文其它相同的词。
 *
 * 仅作用于文本类文件（md / txt / 源码等）。docx/pdf 等二进制文档请用 inspectDocument
 * 查看格式、renderDocument 重排——本工具会基于格式识别器拒绝二进制以防破坏。
 */
const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const { replaceAtLocation, locateWord } = require('../services/formatInspect/textAddress');
const { detectFile } = require('../services/formatInspect/fileFormatDetector');
let _fileHistory;
try { _fileHistory = require('../services/fileHistoryService'); } catch { _fileHistory = null; }

module.exports = defineTool({
  name: 'replaceAtLocation',
  description:
    'Precisely replace a word at a specific location in a TEXT file (Markdown/txt/source), ' +
    'addressed by paragraph and/or sentence and occurrence — e.g. "the 1st `value` in paragraph 2, ' +
    'sentence 2". Unlike find/replace, it only touches the targeted location and leaves every other ' +
    'identical word unchanged. Use when the same term appears many times but only one specific spot ' +
    'must change. Binary documents (.docx/.pdf) are rejected — inspect/typeset those with the doc tools.',
  category: 'filesystem',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: false,

  aliases: ['replace_at', 'precise_replace', 'replace_word_at'],
  searchHint: 'precise positional replace word paragraph sentence occurrence 精确 定位 替换 第几段 第几句',

  inputSchema: {
    file_path: { type: 'string', required: true, description: 'Path to the text file to edit.' },
    word: { type: 'string', required: true, description: 'The exact word/term to replace.' },
    replacement: { type: 'string', required: true, description: 'Replacement text (empty string deletes the word).' },
    paragraph: { type: 'number', required: false, description: '1-based paragraph index to scope the replacement. Omit for whole-document scope.' },
    sentence: { type: 'number', required: false, description: '1-based sentence index within the paragraph (requires paragraph).' },
    occurrence: { type: 'string', required: false, description: 'Which occurrence within the scope: a 1-based number (default 1) or "all".' },
    preview: { type: 'boolean', required: false, description: 'If true, do not write — only report where the word occurs (paragraph/sentence coordinates).' },
  },

  getActivityDescription(input) {
    return `精确替换：${input?.file_path ? path.basename(input.file_path) : 'file'}`;
  },
  getToolUseSummary(input) {
    if (!input?.file_path) return null;
    const loc = input.paragraph ? `第${input.paragraph}段${input.sentence ? `第${input.sentence}句` : ''}` : '全文';
    return `在 ${path.basename(input.file_path)} ${loc} 替换「${input.word}」`;
  },

  async execute(params) {
    const { file_path, word, replacement, paragraph, sentence, occurrence, preview } = params || {};
    if (!file_path) return { success: false, error: 'file_path is required' };
    if (!preview && (typeof word !== 'string' || typeof replacement !== 'string')) {
      return { success: false, error: 'word and replacement are required (replacement may be an empty string).' };
    }

    try {
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      let rawPath = file_path;
      if (rawPath.startsWith('~')) rawPath = path.join(require('os').homedir(), rawPath.slice(1));
      try { rawPath = require('./_userDirs').normalizeDesktopPath(rawPath); } catch { /* ignore */ }

      // 路径封禁（对齐 editFile）
      {
        const { validateNotUNCPath, validateNoPathTraversal } = require('./inputValidators');
        const unc = validateNotUNCPath(rawPath);
        if (!unc.valid) return { success: false, error: unc.message };
        const confine = validateNoPathTraversal(rawPath);
        if (!confine.valid) return { success: false, error: confine.message };
      }

      const absPath = path.resolve(cwd, rawPath);
      if (!fs.existsSync(absPath)) return { success: false, error: `File not found: ${absPath}` };

      // 读前防卡死统一前检(FIFO/设备/Windows 保留名/阻塞伪文件)—— 必须在 detectFile/readFileSync 触碰字节之前。
      try {
        const stat = fs.statSync(absPath);
        const { classifyPreReadHang } = require('./filePreReadHangGuard');
        const hang = classifyPreReadHang({ absPath, stat, env: process.env });
        if (hang && hang.blocked) return { success: false, error: hang.error, blockedRead: hang.kind };
      } catch { /* stat/判定失败 → 回退历史行为 */ }

      // 防呆：基于格式识别器拒绝二进制/二进制文档，避免破坏 docx/pdf。
      const fmt = detectFile(absPath);
      if (fmt.isBinary || ['docx', 'pdf', 'doc', 'xlsx', 'pptx', 'rtf'].includes(fmt.format)) {
        return {
          success: false,
          error: `replaceAtLocation 只支持文本文件；检测到「${fmt.format}」（二进制文档）。`,
          hint: '请用 inspectDocument 查看其格式，用 renderDocument 重新排版生成。',
          detectedFormat: fmt.format,
        };
      }

      const original = fs.readFileSync(absPath, 'utf-8');

      // 预览模式：只报告坐标，不写盘。
      if (preview) {
        const locs = locateWord(original, word);
        return {
          success: true,
          preview: true,
          word,
          occurrences: locs.length,
          locations: locs.slice(0, 200),
          message: `「${word}」在 ${path.basename(absPath)} 共出现 ${locs.length} 次。`,
        };
      }

      const occ = (occurrence === 'all') ? 'all' : (occurrence != null ? Number(occurrence) : undefined);
      const result = replaceAtLocation(original, { word, replacement, paragraph, sentence, occurrence: occ });
      if (!result.ok) {
        return { success: false, error: result.error, hint: result.hint, available: result.available };
      }
      if (result.text === original) {
        return { success: false, error: '替换后内容无变化（word 与 replacement 可能相同）。' };
      }

      if (_fileHistory) {
        try { _fileHistory.takeSnapshot(absPath, { reason: 'replaceAtLocation', content: original }); } catch { /* non-critical */ }
      }
      fs.writeFileSync(absPath, result.text, 'utf-8');

      return {
        success: true,
        file: absPath,
        replaced: result.replaced,
        scope: result.scope,
        message: `已在 ${path.basename(absPath)} 精确替换 ${result.replaced} 处（${_scopeText(result.scope)}）。`,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});

function _scopeText(scope) {
  if (!scope) return '全文';
  if (scope.kind === 'sentence') return `第${scope.paragraph}段第${scope.sentence}句`;
  if (scope.kind === 'paragraph') return `第${scope.paragraph}段`;
  return '全文';
}
