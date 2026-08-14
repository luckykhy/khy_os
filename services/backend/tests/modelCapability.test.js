'use strict';

/**
 * Unit tests for modelCapability — classify a model id into
 * text | audio | image | video. Pure function, no mocks needed; the only
 * external input is the KHY_MODEL_CAPABILITY_MAP env var, set per-test.
 */

const cap = require('../src/services/gateway/modelCapability');

beforeEach(() => {
  delete process.env.KHY_MODEL_CAPABILITY_MAP;
  cap.__resetCacheForTests();
});

afterEach(() => {
  delete process.env.KHY_MODEL_CAPABILITY_MAP;
  cap.__resetCacheForTests();
});

describe('source hint wins (origin-based)', () => {
  test('image/video source overrides any name', () => {
    expect(cap.classifyCapability('agnes-image-2.1-flash', { source: 'image' })).toBe('image');
    expect(cap.classifyCapability('agnes-video-v2.0', { source: 'video' })).toBe('video');
    // a chat-named model forced to image by origin
    expect(cap.classifyCapability('gpt-4o', { source: 'image' })).toBe('image');
  });
});

describe('Agnes triplet without source hint', () => {
  test('chat model → text, image/video names → regex buckets', () => {
    expect(cap.classifyCapability('agnes-2.0-flash')).toBe('text');
    expect(cap.classifyCapability('agnes-image-2.1-flash')).toBe('image');
    expect(cap.classifyCapability('agnes-video-v2.0')).toBe('video');
  });
});

describe('env override map', () => {
  test('KHY_MODEL_CAPABILITY_MAP pins capability (case-insensitive)', () => {
    process.env.KHY_MODEL_CAPABILITY_MAP = JSON.stringify({ 'my-weird-model': 'image' });
    expect(cap.classifyCapability('My-Weird-Model')).toBe('image');
  });

  test('invalid capability value in map is ignored → falls through to default', () => {
    process.env.KHY_MODEL_CAPABILITY_MAP = JSON.stringify({ 'x': 'hologram' });
    expect(cap.classifyCapability('x')).toBe('text');
  });

  test('malformed JSON map does not throw', () => {
    process.env.KHY_MODEL_CAPABILITY_MAP = '{not json';
    expect(cap.classifyCapability('whatever')).toBe('text');
  });
});

describe('regex heuristics', () => {
  test('image tokens', () => {
    for (const m of ['dall-e-3', 'sdxl-turbo', 'flux-pro', 'stable-diffusion-xl', 'imagen-3']) {
      expect(cap.classifyCapability(m)).toBe('image');
    }
  });
  test('video tokens', () => {
    for (const m of ['sora-1', 'kling-v1', 'veo-2', 'runway-gen3', 'luma-dream']) {
      expect(cap.classifyCapability(m)).toBe('video');
    }
  });
  test('audio tokens', () => {
    for (const m of ['whisper-large-v3', 'tts-1-hd', 'gpt-4o-realtime', 'voice-clone']) {
      expect(cap.classifyCapability(m)).toBe('audio');
    }
  });
  test('default text', () => {
    for (const m of ['gpt-4o', 'deepseek-chat', 'claude-opus-4', 'qwen-max']) {
      expect(cap.classifyCapability(m)).toBe('text');
    }
  });
  test('empty/blank id → text', () => {
    expect(cap.classifyCapability('')).toBe('text');
    expect(cap.classifyCapability(null)).toBe('text');
  });
});
