const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class OCRExtendedTool extends BaseTool {
  static toolName = 'OCRExtended';
  static category = 'multimodal';
  static risk = 'low';
  static aliases = ['ocr', 'recognize_text', 'extract_text'];
  static searchHint = 'ocr text extraction image document';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Extract text from images using OCR.

Supported providers:
- "azure" — Azure AI Vision
- "mistral" — Mistral OCR
- "vertex" — Vertex AI

Returns extracted text from the image.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        imageData: {
          type: 'string',
          description: 'Base64 encoded image data',
        },
        provider: {
          type: 'string',
          enum: ['azure', 'mistral', 'vertex', 'auto'],
          description: 'OCR provider (default: auto)',
        },
        language: {
          type: 'string',
          description: 'Language hint (e.g., "zh", "en")',
        },
      },
      required: ['imageData'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_OCR_EXTENDED_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 60000,
    });

    try {
      const ocr = require('../../services/ocrProviders');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        for (const p of ocr.listProviders()) {
          if (ocr.isProviderConfigured(p.id)) {
            provider = p.id;
            break;
          }
        }
        if (provider === 'auto') {
          return { success: false, error: 'No OCR provider configured. Set KHY_OCR_AZURE_VISION_API_KEY, KHY_OCR_MISTRAL_API_KEY, or KHY_OCR_VERTEX_API_KEY.' };
        }
      }

      const result = await withDeadline(
        () => ocr.recognize(provider, params.imageData, { language: params.language }),
        timeoutMs
      );

      if (result?.__timedOut) {
        return { success: false, error: `OCR timeout after ${timeoutMs}ms` };
      }

      return result;
    } catch (err) {
      return { success: false, error: `OCR error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `OCR 文字识别`;
  }
}

module.exports = OCRExtendedTool;
