const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class VideoGenExtendedTool extends BaseTool {
  static toolName = 'VideoGenExtended';
  static category = 'multimodal';
  static risk = 'low';
  static aliases = ['video_gen', 'gen_video', 'create_video'];
  static searchHint = 'video generation create clip animation';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Generate videos from text prompts using multiple providers.

Supported providers:
- "runway" — RunwayML Gen-3
- "sora" — OpenAI Sora
- "kling" — Kling AI

Returns task ID for async video generation.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the video to generate',
        },
        provider: {
          type: 'string',
          enum: ['runway', 'sora', 'kling', 'auto'],
          description: 'Video generation provider (default: auto)',
        },
        duration: {
          type: 'number',
          description: 'Video duration in seconds (default: 5)',
          minimum: 1,
          maximum: 30,
        },
        aspectRatio: {
          type: 'string',
          description: 'Aspect ratio (e.g., "16:9", "9:16", "1:1")',
        },
      },
      required: ['prompt'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_VIDEO_GEN_EXTENDED_TIMEOUT_MS',
      defaultMs: 120000,
      min: 1000,
      max: 300000,
    });

    try {
      const videoGen = require('../../services/videoGenProviders');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        for (const p of videoGen.listProviders()) {
          if (videoGen.isProviderConfigured(p.id)) {
            provider = p.id;
            break;
          }
        }
        if (provider === 'auto') {
          return { success: false, error: 'No video generation provider configured. Set KHY_VIDEO_GEN_RUNWAY_API_KEY, KHY_VIDEO_GEN_OPENAI_API_KEY, or KHY_VIDEO_GEN_KLING_API_KEY.' };
        }
      }

      const result = await withDeadline(
        () => videoGen.generateVideo(provider, params.prompt, {
          duration: params.duration,
          aspectRatio: params.aspectRatio,
        }),
        timeoutMs
      );

      if (result?.__timedOut) {
        return { success: false, error: `Video generation timeout after ${timeoutMs}ms` };
      }

      return result;
    } catch (err) {
      return { success: false, error: `Video generation error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `生成视频：${input.prompt?.slice(0, 40) || ''}`;
  }
}

module.exports = VideoGenExtendedTool;
