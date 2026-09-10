const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class GoogleGenAITool extends BaseTool {
  static toolName = 'GoogleGenAI';
  static category = 'ai';
  static risk = 'low';
  static aliases = ['google_genai', 'gemini', 'imagen'];
  static searchHint = 'google genai gemini imagen vision';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Google GenAI services — Gemini, Imagen, Vision, and Embeddings.

Operations:
- "generate" — Text generation with Gemini
- "imagen" — Image generation with Imagen
- "vision" — Image analysis with Gemini Vision
- "embed" — Text embedding with Gemini`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['generate', 'imagen', 'vision', 'embed'],
          description: 'Operation to perform',
        },
        prompt: {
          type: 'string',
          description: 'Text prompt (for generate/imagen/vision)',
        },
        imageData: {
          type: 'string',
          description: 'Base64 image data (for vision)',
        },
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Texts to embed (for embed)',
        },
        model: {
          type: 'string',
          description: 'Model to use',
        },
      },
      required: ['operation'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_GOOGLE_GENAI_TIMEOUT_MS',
      defaultMs: 60000,
      min: 1000,
      max: 120000,
    });

    try {
      const googleGenAI = require('../../services/googleGenAI');

      if (!googleGenAI.isConfigured()) {
        return { success: false, error: 'Google API Key not configured. Set GOOGLE_API_KEY or GEMINI_API_KEY.' };
      }

      switch (params.operation) {
        case 'generate':
          if (!params.prompt) return { success: false, error: 'prompt is required' };
          return await withDeadline(
            () => googleGenAI.geminiFlashGenerate(params.prompt, { model: params.model }),
            timeoutMs
          );

        case 'imagen':
          if (!params.prompt) return { success: false, error: 'prompt is required' };
          return await withDeadline(
            () => googleGenAI.imagenGenerate(params.prompt, { model: params.model }),
            timeoutMs
          );

        case 'vision':
          if (!params.imageData || !params.prompt) return { success: false, error: 'imageData and prompt are required' };
          return await withDeadline(
            () => googleGenAI.geminiVisionAnalyze(params.imageData, params.prompt, { model: params.model }),
            timeoutMs
          );

        case 'embed':
          if (!params.texts) return { success: false, error: 'texts is required' };
          return await withDeadline(
            () => googleGenAI.geminiEmbed(params.texts, { model: params.model }),
            timeoutMs
          );

        default:
          return { success: false, error: `Unknown operation: ${params.operation}` };
      }
    } catch (err) {
      return { success: false, error: `Google GenAI error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `Google GenAI：${input.operation || ''}`;
  }
}

module.exports = GoogleGenAITool;
