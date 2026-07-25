'use strict';

// Unit tests for selectable image-generation model + Auto default.
// Pure, no network: exercises resolveBackend()/catalogModels() env logic and the
// fail-soft per-user pref reader. The HTTP _generate* paths are not invoked.
// Runner: jest (consistent with the other services/backend/test/*.test.js files).

const imageGen = require('../src/services/imageGenService');

// Snapshot + restore the KHY_IMAGE_GEN_* env around each assertion block.
function withEnv(vars, fn) {
  const keys = Object.keys(vars);
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return fn(); }
  finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// Clear every backend's env so each test starts from a known "nothing configured" base.
const CLEAR = {
  KHY_IMAGE_GEN_BACKEND: undefined,
  KHY_IMAGE_GEN_OPENAI_BASE_URL: undefined,
  KHY_IMAGE_GEN_OPENAI_API_KEY: undefined,
  KHY_IMAGE_GEN_OPENAI_MODEL: undefined,
  KHY_IMAGE_GEN_AGNES_API_KEY: undefined,
  KHY_IMAGE_GEN_AGNES_MODEL: undefined,
  KHY_IMAGE_GEN_DOMESTIC_BASE_URL: undefined,
  KHY_IMAGE_GEN_DOMESTIC_API_KEY: undefined,
  KHY_IMAGE_GEN_DOMESTIC_MODEL: undefined,
  KHY_IMAGE_GEN_SD_BASE_URL: undefined,
  GATEWAY_IMAGE_GEN_BACKEND: undefined,
};

describe('imageGenService — Auto order + backend resolution', () => {
  test('AUTO_ORDER is the fixed quality precedence', () => {
    expect(imageGen.AUTO_ORDER).toEqual(['openai', 'agnes', 'domestic', 'sd_webui']);
  });

  test('auto picks the highest-priority configured backend', () => {
    withEnv({
      ...CLEAR,
      KHY_IMAGE_GEN_AGNES_API_KEY: 'k',
      KHY_IMAGE_GEN_SD_BASE_URL: 'http://127.0.0.1:7860',
    }, () => {
      // openai not configured → first available in order is agnes.
      expect(imageGen.resolveBackend()).toBe('agnes');
      expect(imageGen.resolveBackend('')).toBe('agnes');
      expect(imageGen.resolveBackend('auto')).toBe('agnes');
    });
  });

  test('auto prefers openai when configured', () => {
    withEnv({
      ...CLEAR,
      KHY_IMAGE_GEN_OPENAI_BASE_URL: 'http://x',
      KHY_IMAGE_GEN_OPENAI_API_KEY: 'k',
      KHY_IMAGE_GEN_AGNES_API_KEY: 'k',
    }, () => {
      expect(imageGen.resolveBackend()).toBe('openai');
    });
  });

  test('explicit override beats env pin and auto order', () => {
    withEnv({
      ...CLEAR,
      KHY_IMAGE_GEN_BACKEND: 'openai',
      KHY_IMAGE_GEN_OPENAI_BASE_URL: 'http://x',
      KHY_IMAGE_GEN_OPENAI_API_KEY: 'k',
      KHY_IMAGE_GEN_AGNES_API_KEY: 'k',
    }, () => {
      expect(imageGen.resolveBackend('agnes')).toBe('agnes');
      expect(imageGen.resolveBackend('AGNES')).toBe('agnes'); // normalized
    });
  });

  test('env pin honored when no override', () => {
    withEnv({
      ...CLEAR,
      KHY_IMAGE_GEN_BACKEND: 'domestic',
      KHY_IMAGE_GEN_DOMESTIC_BASE_URL: 'http://x',
      KHY_IMAGE_GEN_DOMESTIC_API_KEY: 'k',
      KHY_IMAGE_GEN_OPENAI_BASE_URL: 'http://x',
      KHY_IMAGE_GEN_OPENAI_API_KEY: 'k',
    }, () => {
      expect(imageGen.resolveBackend()).toBe('domestic');
    });
  });

  test('returns null when nothing configured and no override', () => {
    withEnv({ ...CLEAR }, () => {
      expect(imageGen.resolveBackend()).toBeNull();
      expect(imageGen.resolveBackend('auto')).toBeNull();
    });
  });

  test('catalogModels enumerates only active backends with their model env', () => {
    withEnv({
      ...CLEAR,
      KHY_IMAGE_GEN_OPENAI_BASE_URL: 'http://x',
      KHY_IMAGE_GEN_OPENAI_API_KEY: 'k',
      KHY_IMAGE_GEN_OPENAI_MODEL: 'dall-e-3',
    }, () => {
      const models = imageGen.catalogModels();
      expect(models.some((m) => m.backend === 'openai' && m.model === 'dall-e-3')).toBe(true);
      expect(models.some((m) => m.backend === 'sd_webui')).toBe(false);
      for (const m of models) expect(m.capability).toBe('image');
    });
  });
});

describe('imageGenUserPref — per-user pref reader (fail-soft)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@khy/shared/models');
  });

  test('null for empty/missing userId', async () => {
    const pref = require('../src/services/imageGenUserPref');
    expect(await pref.getUserImagePref(null)).toBeNull();
    expect(await pref.getUserImagePref('')).toBeNull();
    expect(await pref.getUserImagePref(undefined)).toBeNull();
  });

  test('fail-soft returns null when the model layer throws', async () => {
    jest.resetModules();
    jest.doMock('@khy/shared/models', () => { throw new Error('models unavailable'); });
    const pref = require('../src/services/imageGenUserPref');
    expect(await pref.getUserImagePref(42)).toBeNull();
  });

  test('returns {backend,model} for a valid pinned row', async () => {
    jest.resetModules();
    jest.doMock('@khy/shared/models', () => ({
      UserGatewayConfig: {
        findOne: async () => ({ imageBackend: 'Agnes', imageModel: 'agnes-image-2.0' }),
      },
    }));
    const pref = require('../src/services/imageGenUserPref');
    expect(await pref.getUserImagePref(7)).toEqual({ backend: 'agnes', model: 'agnes-image-2.0' });
  });

  test.each([
    ['empty', { imageBackend: '', imageModel: 'x' }],
    ['auto', { imageBackend: 'auto', imageModel: 'x' }],
    ['invalid', { imageBackend: 'nonsense', imageModel: 'x' }],
    ['no row', null],
  ])('null when backend is %s', async (_label, row) => {
    jest.resetModules();
    jest.doMock('@khy/shared/models', () => ({
      UserGatewayConfig: { findOne: async () => row },
    }));
    const pref = require('../src/services/imageGenUserPref');
    expect(await pref.getUserImagePref(1)).toBeNull();
  });
});
