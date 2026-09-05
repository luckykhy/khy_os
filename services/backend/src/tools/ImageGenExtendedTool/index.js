const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class ImageGenExtendedTool extends BaseTool {
  static toolName = 'ImageGenExtended';
  static category = 'multimodal';
  static risk = 'low';
  static aliases = ['image_gen', 'gen_image', 'create_image'];
  static searchHint = 'image generation create picture art';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Generate images from text prompts using multiple providers.

Supported providers:
- "flux" — Flux models (fast, high quality)
- "stable_diffusion" — Stable Diffusion XL
- "gemini_imagen" — Google Gemini Imagen
- "dalle" — OpenAI DALL-E 3

Returns generated image URLs or base64 data.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the image to generate',
        },
        provider: {
          type: 'string',
          enum: ['flux', 'stable_diffusion', 'gemini_imagen', 'dalle', 'auto'],
          description: 'Image generation provider (default: auto)',
        },
        size: {
          type: 'string',
          description: 'Image size (e.g., "1024x1024", "1536x1024"). Provider-dependent.',
        },
        numImages: {
          type: 'number',
          description: 'Number of images to generate (default: 1, max: 4)',
          minimum: 1,
          maximum: 4,
        },
      },
      required: ['prompt'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_IMAGE_GEN_EXTENDED_TIMEOUT_MS',
      defaultMs: 120000,
      min: 1000,
      max: 300000,
    });

    try {
      const imageGen = require('../../services/imageGenProviders');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        // Auto-select first configured provider
        for (const p of imageGen.listProviders()) {
          if (imageGen.isProviderConfigured(p.id)) {
            provider = p.id;
            break;
          }
        }
        if (provider === 'auto') {
          return { success: false, error: 'No image generation provider configured. Set KHY_IMAGE_GEN_FLUX_API_KEY, KHY_IMAGE_GEN_SD_API_KEY, KHY_IMAGE_GEN_GEMINI_API_KEY, or OPENAI_API_KEY.' };
        }
      }

      const result = await withDeadline(
        () => imageGen.generateImage(provider, params.prompt, {
          size: params.size,
          numImages: params.numImages,
        }),
        timeoutMs
      );

      if (result?.__timedOut) {
        return { success: false, error: `Image generation timeout after ${timeoutMs}ms` };
      }

      return result;
    } catch (err) {
      return { success: false, error: `Image generation error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `生成图片：${input.prompt?.slice(0, 40) || ''}`;
  }
}

module.exports = ImageGenExtendedTool;
