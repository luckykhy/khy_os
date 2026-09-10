const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class TTSExtendedTool extends BaseTool {
  static toolName = 'TTSExtended';
  static category = 'multimodal';
  static risk = 'low';
  static aliases = ['tts', 'text_to_speech', 'speak'];
  static searchHint = 'text to speech synthesis voice';
  static shouldDefer = false;

  isReadOnly() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Convert text to speech using multiple providers.

Supported providers:
- "openai" — OpenAI TTS
- "elevenlabs" — ElevenLabs TTS

Returns audio data in the specified format.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to convert to speech',
        },
        provider: {
          type: 'string',
          enum: ['openai', 'elevenlabs', 'auto'],
          description: 'TTS provider (default: auto)',
        },
        voice: {
          type: 'string',
          description: 'Voice name/id (provider-specific)',
        },
        format: {
          type: 'string',
          enum: ['mp3', 'opus', 'aac', 'wav'],
          description: 'Audio format (default: mp3)',
        },
      },
      required: ['text'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_TTS_EXTENDED_TIMEOUT_MS',
      defaultMs: 30000,
      min: 1000,
      max: 60000,
    });

    try {
      const tts = require('../../services/ttsProviders');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        for (const p of tts.listProviders()) {
          if (tts.isProviderConfigured(p.id)) {
            provider = p.id;
            break;
          }
        }
        if (provider === 'auto') {
          return { success: false, error: 'No TTS provider configured. Set KHY_TTS_OPENAI_API_KEY or KHY_TTS_ELEVENLABS_API_KEY.' };
        }
      }

      const result = await withDeadline(
        () => tts.synthesize(provider, params.text, {
          voice: params.voice,
          format: params.format,
        }),
        timeoutMs
      );

      if (result?.__timedOut) {
        return { success: false, error: `TTS timeout after ${timeoutMs}ms` };
      }

      return result;
    } catch (err) {
      return { success: false, error: `TTS error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `语音合成：${input.text?.slice(0, 40) || ''}`;
  }
}

module.exports = TTSExtendedTool;
