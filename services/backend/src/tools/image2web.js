const path = require('path');
const { defineTool } = require('./_baseTool');
const imageToWebService = require('../services/imageToWebService');

module.exports = defineTool({
  name: 'image2web',
  description: 'Convert a webpage screenshot image to runnable HTML/CSS, optionally saving to a file',
  category: 'analysis',
  risk: 'medium',
  isReadOnly: (input) => !(input && (input.save === true || input.outputPath)),
  isConcurrencySafe: false,

  aliases: [
    'image_to_web',
    'screenshot_to_html',
    'web_rebuild',
    'ui_to_html',
  ],
  searchHint: 'convert screenshot to runnable html css webpage',

  inputSchema: {
    imagePath: { type: 'string', required: false, description: 'Image file path (png/jpg/jpeg/gif/webp)' },
    useClipboard: { type: 'boolean', required: false, description: 'Read image from clipboard instead of imagePath' },
    prompt: { type: 'string', required: false, description: 'Extra restoration instruction, e.g. responsive, pixel-perfect' },
    outputPath: { type: 'string', required: false, description: 'Save HTML to this path' },
    save: { type: 'boolean', required: false, description: 'Whether to save HTML to file (default false for tool calls)' },
    overwrite: { type: 'boolean', required: false, description: 'Overwrite outputPath if file already exists' },
  },

  async validateInput(input) {
    const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
    const useClipboard = Boolean(input && input.useClipboard);
    const imagePath = String((input && input.imagePath) || '').trim();
    const outputPath = String((input && input.outputPath) || '').trim();

    if (!useClipboard && !imagePath) {
      return { valid: false, message: 'imagePath is required when useClipboard is false' };
    }

    return composeValidations(
      imagePath ? validateNotDevicePath(imagePath) : { valid: true },
      imagePath ? validateNotUNCPath(imagePath) : { valid: true },
      outputPath ? validateNotUNCPath(outputPath) : { valid: true },
    );
  },

  getActivityDescription(input) {
    if (input && input.useClipboard) return '将剪贴板截图转换为 HTML';
    const p = input && input.imagePath ? path.basename(input.imagePath) : 'image';
    return `将 ${p} 转换为可运行 HTML`;
  },

  getToolUseSummary(input) {
    if (!input) return null;
    const src = input.useClipboard ? '剪贴板' : (input.imagePath || 'image');
    const out = input.outputPath ? ` -> ${input.outputPath}` : '';
    return `图片转网页：${src}${out}`;
  },

  async execute(params) {
    const save = params.save === true || Boolean(params.outputPath);
    const result = await imageToWebService.convertImageToWeb({
      imagePath: params.imagePath,
      useClipboard: Boolean(params.useClipboard),
      prompt: params.prompt,
      outputPath: params.outputPath,
      overwrite: Boolean(params.overwrite),
      save,
      cwd: process.env.KHYQUANT_CWD || process.cwd(),
    });

    if (!result.success) {
      return {
        success: false,
        error: result.error || 'image2web failed',
        provider: result.provider,
        model: result.model,
        rawReply: result.rawReply,
      };
    }

    const meta = [
      result.provider ? `provider=${result.provider}` : '',
      result.model ? `model=${result.model}` : '',
      result.saved && result.outputPath ? `output=${result.outputPath}` : '',
    ].filter(Boolean).join(' | ');

    const content = result.saved
      ? `HTML generated and saved to: ${result.outputPath}\n\n${result.html}`
      : result.html;

    return {
      success: true,
      content,
      html: result.html,
      saved: Boolean(result.saved),
      outputPath: result.outputPath || null,
      autoRenamed: Boolean(result.autoRenamed),
      sourcePath: result.sourcePath,
      provider: result.provider,
      model: result.model,
      meta,
    };
  },
});
