const { BaseTool } = require('../_baseTool');
const { resolveToolTimeoutMs, withDeadline } = require('../_toolTimeout');

class STTExtendedTool extends BaseTool {
  static toolName = 'STTExtended';
  static category = 'multimodal';
  static risk = 'low';
  static aliases = ['stt', 'speech_to_text', 'transcribe'];
  static searchHint = 'speech to text transcription audio';
  static shouldDefer = false;

  isReadOnly() {
    return true;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Transcribe audio to text using multiple providers.

Supported providers:
- "deepgram" — Deepgram Nova-2
- "elevenlabs" — ElevenLabs STT
- "whisper" — OpenAI Whisper

Returns transcribed text.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        audioData: {
          type: 'string',
          description: 'Base64 encoded audio data',
        },
        provider: {
          type: 'string',
          enum: ['deepgram', 'elevenlabs', 'whisper', 'auto'],
          description: 'STT provider (default: auto)',
        },
        language: {
          type: 'string',
          description: 'Language hint (e.g., "zh", "en", "auto")',
        },
      },
      required: ['audioData'],
    };
  }

  async execute(params) {
    const timeoutMs = resolveToolTimeoutMs({
      paramMs: params?.timeoutMs,
      envKey: 'KHY_STT_EXTENDED_TIMEOUT_MS',
      defaultMs: 60000,
      min: 1000,
      max: 120000,
    });

    try {
      const stt = require('../../services/sttProviders');

      let provider = params.provider || 'auto';
      if (provider === 'auto') {
        for (const p of stt.listProviders()) {
          if (stt.isProviderConfigured(p.id)) {
            provider = p.id;
            break;
          }
        }
        if (provider === 'auto') {
          return { success: false, error: 'No STT provider configured. Set KHY_STT_DEEPGRAM_API_KEY, KHY_STT_ELEVENLABS_API_KEY, or KHY_STT_OPENAI_API_KEY.' };
        }
      }

      const audioBuffer = Buffer.from(params.audioData, 'base64');

      const result = await withDeadline(
        () => stt.transcribe(provider, audioBuffer, {
          language: params.language,
        }),
        timeoutMs
      );

      if (result?.__timedOut) {
        return { success: false, error: `STT timeout after ${timeoutMs}ms` };
      }

      return result;
    } catch (err) {
      return { success: false, error: `STT error: ${err.message}` };
    }
  }

  getActivityDescription(input) {
    return `语音转文字`;
  }
}

module.exports = STTExtendedTool;
