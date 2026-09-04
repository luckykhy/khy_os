'use strict';

const {
  CLAUDE_OPUS_MODELS,
  CLAUDE_SONNET_MODELS,
  CLAUDE_HAIKU_MODELS,
  EMBEDDING_MODELS,
  LOCAL_BRAIN_MODELS,
  LOCAL_BRAIN_GGUF_FILES,
  OLLAMA_DEFAULT_MODELS,
  IDE_DEFAULT_MODELS,
  RELAY_DEFAULT_MODELS,
  CODEX_PROBE_MODELS,
  CODEX_AGENT_MODELS,
  LIGHTWEIGHT_AGENT_MODELS,
  FREE_GOOGLE_MODELS,
  FREE_GROQ_MODELS,
  OPENAI_DIRECT_MODELS,
  ANTHROPIC_DIRECT_MODELS,
  QWEN_DIRECT_MODELS,
  ZHIPU_DIRECT_MODELS,
  primaryOf,
  PRIMARY,
} = require('../../src/constants/models');

describe('models', () => {
  describe('model arrays', () => {
    test('CLAUDE_OPUS_MODELS has correct value', () => {
      expect(CLAUDE_OPUS_MODELS).toEqual(['claude-opus-4-8']);
    });

    test('CLAUDE_SONNET_MODELS has correct value', () => {
      expect(CLAUDE_SONNET_MODELS).toEqual(['claude-sonnet-4-6']);
    });

    test('CLAUDE_HAIKU_MODELS has correct value', () => {
      expect(CLAUDE_HAIKU_MODELS).toEqual(['claude-haiku-4-5-latest']);
    });

    test('EMBEDDING_MODELS has correct value', () => {
      expect(EMBEDDING_MODELS).toEqual(['nomic-embed-text']);
    });

    test('LOCAL_BRAIN_MODELS has correct value', () => {
      expect(LOCAL_BRAIN_MODELS).toEqual(['qwen3.5:4b']);
    });

    test('LOCAL_BRAIN_GGUF_FILES has correct values', () => {
      expect(LOCAL_BRAIN_GGUF_FILES).toEqual([
        'qwen3.5-4b.gguf',
        'qwen3.5-4b-ollama.gguf',
        'qwen3.5-4b-export.gguf',
      ]);
    });

    test('OLLAMA_DEFAULT_MODELS has correct value', () => {
      expect(OLLAMA_DEFAULT_MODELS).toEqual(['qwen2.5:7b']);
    });

    test('IDE_DEFAULT_MODELS has correct value', () => {
      expect(IDE_DEFAULT_MODELS).toEqual(['gpt-4o']);
    });

    test('RELAY_DEFAULT_MODELS has correct values', () => {
      expect(RELAY_DEFAULT_MODELS).toEqual(['claude-sonnet-4-6', 'claude-sonnet-4-20250514']);
    });

    test('CODEX_PROBE_MODELS has correct value', () => {
      expect(CODEX_PROBE_MODELS).toEqual(['o4-mini']);
    });

    test('CODEX_AGENT_MODELS has correct value', () => {
      expect(CODEX_AGENT_MODELS).toEqual(['gpt-5-codex']);
    });

    test('LIGHTWEIGHT_AGENT_MODELS has correct values', () => {
      expect(LIGHTWEIGHT_AGENT_MODELS).toEqual([
        'claude-haiku-4-5-latest',
        'claude-haiku-3.5',
        'gemini-2.0-flash',
      ]);
    });

    test('FREE_GOOGLE_MODELS has correct value', () => {
      expect(FREE_GOOGLE_MODELS).toEqual(['gemini-2.5-flash']);
    });

    test('FREE_GROQ_MODELS has correct value', () => {
      expect(FREE_GROQ_MODELS).toEqual(['llama-3.3-70b-versatile']);
    });

    test('OPENAI_DIRECT_MODELS has correct value', () => {
      expect(OPENAI_DIRECT_MODELS).toEqual(['gpt-3.5-turbo']);
    });

    test('ANTHROPIC_DIRECT_MODELS has correct value', () => {
      expect(ANTHROPIC_DIRECT_MODELS).toEqual(['claude-3-sonnet-20240229']);
    });

    test('QWEN_DIRECT_MODELS has correct value', () => {
      expect(QWEN_DIRECT_MODELS).toEqual(['qwen-turbo']);
    });

    test('ZHIPU_DIRECT_MODELS has correct value', () => {
      expect(ZHIPU_DIRECT_MODELS).toEqual(['glm-4']);
    });
  });

  describe('primaryOf', () => {
    test('returns first element of array', () => {
      expect(primaryOf(['a', 'b', 'c'])).toBe('a');
    });

    test('returns empty string for empty array', () => {
      expect(primaryOf([])).toBe('');
    });

    test('returns empty string for non-array', () => {
      expect(primaryOf(null)).toBe('');
      expect(primaryOf(undefined)).toBe('');
      expect(primaryOf('string')).toBe('');
      expect(primaryOf(123)).toBe('');
    });
  });

  describe('PRIMARY', () => {
    test('has correct opus value', () => {
      expect(PRIMARY.opus).toBe('claude-opus-4-8');
    });

    test('has correct sonnet value', () => {
      expect(PRIMARY.sonnet).toBe('claude-sonnet-4-6');
    });

    test('has correct haiku value', () => {
      expect(PRIMARY.haiku).toBe('claude-haiku-4-5-latest');
    });

    test('has correct embedding value', () => {
      expect(PRIMARY.embedding).toBe('nomic-embed-text');
    });

    test('has correct localBrain value', () => {
      expect(PRIMARY.localBrain).toBe('qwen3.5:4b');
    });

    test('has correct ollama value', () => {
      expect(PRIMARY.ollama).toBe('qwen2.5:7b');
    });

    test('has correct ide value', () => {
      expect(PRIMARY.ide).toBe('gpt-4o');
    });

    test('has correct relay value', () => {
      expect(PRIMARY.relay).toBe('claude-sonnet-4-6');
    });

    test('has correct codexProbe value', () => {
      expect(PRIMARY.codexProbe).toBe('o4-mini');
    });

    test('has correct freeGoogle value', () => {
      expect(PRIMARY.freeGoogle).toBe('gemini-2.5-flash');
    });

    test('has correct freeGroq value', () => {
      expect(PRIMARY.freeGroq).toBe('llama-3.3-70b-versatile');
    });

    test('has correct openaiDirect value', () => {
      expect(PRIMARY.openaiDirect).toBe('gpt-3.5-turbo');
    });

    test('has correct anthropicDirect value', () => {
      expect(PRIMARY.anthropicDirect).toBe('claude-3-sonnet-20240229');
    });

    test('has correct qwenDirect value', () => {
      expect(PRIMARY.qwenDirect).toBe('qwen-turbo');
    });

    test('has correct zhipuDirect value', () => {
      expect(PRIMARY.zhipuDirect).toBe('glm-4');
    });
  });
});
