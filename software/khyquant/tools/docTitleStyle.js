/**
 * docTitleStyle — restyle a Word (.docx) title/heading/caption to a given font
 * size and color. The first instance of the capability-as-code convention:
 * one shared core (cli/handlers/doc.js `runTitleStyle`) is exposed as both the
 * `khy doc title` CLI command and this agent tool, with co-located tests, and
 * ships with the product via the wheel — rather than living as an assistant
 * memory note.
 *
 * Targets the title either by exact text (`match`) or by paragraph style
 * (`style`, defaulting to the built-in Title/Heading/Caption set, including the
 * localized Chinese style names). Font size/color are applied to every run of
 * the matching paragraph (Word may split a heading across runs).
 */
const { defineTool } = require('./_baseTool');
const path = require('path');


let _enabled = null;
const _checkEnabled = require('../utils/docHelperEnabled');

module.exports = defineTool({
  name: 'docTitleStyle',
  description:
    'Restyle a Word (.docx) document\'s title/heading/caption: set its font SIZE (points) ' +
    'and/or COLOR (hex). Target the title by exact text (`match`) or by paragraph style ' +
    '(`style`, e.g. "Title"/"Heading 1"/"标题"; defaults to the built-in title/heading/caption ' +
    'styles). Writes to `output` (defaults to a sibling *.styled.docx, never overwriting the ' +
    'source). Needs Python + python-docx (pip install khy-os[doc]); fails soft with an install hint.',
  category: 'filesystem',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: true,
  isEnabled() {
    if (_enabled === null) _enabled = _checkEnabled();
    return _enabled;
  },

  aliases: ['doc_title_style', 'restyle_title', 'set_title_font'],
  searchHint: 'word docx title heading caption font size color 标题 表题 字号 颜色 字体 重排',

  inputSchema: {
    path: {
      type: 'string',
      required: true,
      description: 'Path to the input .docx file. e.g. ~/Desktop/report.docx',
    },
    output: {
      type: 'string',
      required: false,
      description: 'Where to save the result. Defaults to a sibling *.styled.docx.',
    },
    match: {
      type: 'string',
      required: false,
      description: 'Exact title text to target (stripped). Use this for a specific heading.',
    },
    style: {
      type: 'string',
      required: false,
      description: 'Paragraph style name to target (e.g. "Title", "Heading 1", "标题"). Omit to target all title/heading/caption styles.',
    },
    size: {
      type: 'number',
      required: false,
      description: 'Font size in points (e.g. 18 for 小二, 16 for 三号).',
    },
    color: {
      type: 'string',
      required: false,
      description: 'Hex color, 3 or 6 digits, with or without "#" (e.g. C00000 for dark red).',
    },
  },

  capability: {
    summary: 'Word 标题/表题改字号与颜色（python-docx，按样式或文本定位，含中文样式名）',
    learnedFrom: '2026-06 用户教学:把 Word 文档的标题/表题改成指定字号与颜色',
    tests: ['tests/docTitleStyle.test.js'],
    surfaces: ['cli', 'agent', 'mcp'],
  },

  async validateInput(input) {
    const { validateNotUNCPath, validateNotDevicePath, composeValidations } = require('./inputValidators');
    return composeValidations(
      input.path ? validateNotUNCPath(input.path) : { valid: true },
      input.path ? validateNotDevicePath(input.path) : { valid: true },
      input.output ? validateNotUNCPath(input.output) : { valid: true },
    );
  },

  getActivityDescription(input) {
    const name = input?.path ? path.basename(input.path) : 'document';
    return `重排标题样式：${name}`;
  },
  getToolUseSummary(input) {
    if (!input?.path) return null;
    return `重排 Word 标题字号/颜色：${path.basename(input.path)}`;
  },

  async execute(params) {
    if (!params?.path) return { success: false, error: 'Input .docx path is required' };
    if (params.size === undefined && !params.color) {
      return { success: false, error: 'Provide size and/or color to change.' };
    }
    try {
      const { runTitleStyle } = require('../cli/handlers/doc');
      const result = await runTitleStyle(params);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
});
