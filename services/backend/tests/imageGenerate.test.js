'use strict';

// Unit tests for the configurable text-to-image backend (imageGenService) and
// the image_generate tool. No real network: global fetch is mocked per case.

const path = require('path');

const SERVICE = '../src/services/imageGenService';
const TOOL = '../src/tools/imageGenerate';

// Capture/restore the KHY_IMAGE_GEN_* env between tests.
const IMG_ENV_KEYS = Object.keys(process.env).filter(k => k.startsWith('KHY_IMAGE_GEN_') || k.startsWith('GATEWAY_IMAGE_GEN_'));
let savedEnv;

function clearImgEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('KHY_IMAGE_GEN_') || k.startsWith('GATEWAY_IMAGE_GEN_')) delete process.env[k];
  }
}

beforeEach(() => {
  savedEnv = {};
  for (const k of IMG_ENV_KEYS) savedEnv[k] = process.env[k];
  clearImgEnv();
  jest.resetModules();
});

afterEach(() => {
  clearImgEnv();
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  if (global.fetch && global.fetch._isMock) delete global.fetch;
});

function mockFetch(handler) {
  const fn = jest.fn(handler);
  fn._isMock = true;
  global.fetch = fn;
  return fn;
}

function okJson(obj) {
  return Promise.resolve({
    ok: true, status: 200, statusText: 'OK',
    text: () => Promise.resolve(JSON.stringify(obj)),
  });
}

// 1×1 transparent PNG, base64.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('imageGenService backend resolution', () => {
  test('no backend → resolveBackend null, isAnyBackendConfigured false', () => {
    const svc = require(SERVICE);
    expect(svc.resolveBackend()).toBeNull();
    expect(svc.isAnyBackendConfigured()).toBe(false);
    expect(svc.backendHelpText()).toMatch(/KHY_IMAGE_GEN_OPENAI_BASE_URL/);
  });

  test('auto-detect precedence openai > domestic > sd_webui', () => {
    process.env.KHY_IMAGE_GEN_SD_BASE_URL = 'http://127.0.0.1:7860';
    process.env.KHY_IMAGE_GEN_DOMESTIC_BASE_URL = 'https://d.example/v1';
    process.env.KHY_IMAGE_GEN_DOMESTIC_API_KEY = 'k';
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'k';
    const svc = require(SERVICE);
    expect(svc.resolveBackend()).toBe('openai');
  });

  test('explicit KHY_IMAGE_GEN_BACKEND wins', () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'sd_webui';
    process.env.KHY_IMAGE_GEN_SD_BASE_URL = 'http://127.0.0.1:7860';
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'k';
    const svc = require(SERVICE);
    expect(svc.resolveBackend()).toBe('sd_webui');
  });
});

describe('imageGenService backends (mocked fetch)', () => {
  test('OpenAI-compatible returns b64_json', async () => {
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'sk-test';
    process.env.KHY_IMAGE_GEN_OPENAI_MODEL = 'img-model-x';
    const fetchMock = mockFetch((url) => {
      expect(url).toBe('https://o.example/v1/images/generations');
      return okJson({ data: [{ b64_json: TINY_PNG }] });
    });
    const svc = require(SERVICE);
    const out = await svc.generate({ prompt: 'a cat', size: '512x512', n: 1 });
    expect(out.backend).toBe('openai');
    expect(out.model).toBe('img-model-x');
    expect(out.images).toHaveLength(1);
    expect(out.images[0].base64).toBe(TINY_PNG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('domestic with RESPONSE_PATH pointing at a URL → downloads to base64', async () => {
    process.env.KHY_IMAGE_GEN_DOMESTIC_BASE_URL = 'https://d.example/v1';
    process.env.KHY_IMAGE_GEN_DOMESTIC_API_KEY = 'k';
    process.env.KHY_IMAGE_GEN_DOMESTIC_RESPONSE_PATH = 'output.results.0.url';
    const fetchMock = mockFetch((url) => {
      if (url === 'https://img.cdn/result.png') {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK',
          arrayBuffer: () => Promise.resolve(Buffer.from(TINY_PNG, 'base64')) });
      }
      return okJson({ output: { results: [{ url: 'https://img.cdn/result.png' }] } });
    });
    const svc = require(SERVICE);
    const out = await svc.generate({ prompt: 'comic panel', n: 1 });
    expect(out.backend).toBe('domestic');
    expect(out.images[0].base64).toBe(TINY_PNG);
    expect(fetchMock).toHaveBeenCalledTimes(2); // generate + download
  });

  test('SD WebUI returns images[] raw base64', async () => {
    process.env.KHY_IMAGE_GEN_SD_BASE_URL = 'http://127.0.0.1:7860';
    mockFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:7860/sdapi/v1/txt2img');
      const body = JSON.parse(init.body);
      expect(body.width).toBe(768);
      expect(body.height).toBe(768);
      return okJson({ images: [TINY_PNG, TINY_PNG] });
    });
    const svc = require(SERVICE);
    const out = await svc.generate({ prompt: 'a dog', size: '768x768', n: 2 });
    expect(out.backend).toBe('sd_webui');
    expect(out.images).toHaveLength(2);
  });

  test('HTTP error surfaces status + body snippet', async () => {
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'sk-test';
    mockFetch(() => Promise.resolve({
      ok: false, status: 401, statusText: 'Unauthorized',
      text: () => Promise.resolve('{"error":"bad key"}'),
    }));
    const svc = require(SERVICE);
    await expect(svc.generate({ prompt: 'x' })).rejects.toThrow(/401.*bad key/);
  });

  test('empty prompt rejects', async () => {
    const svc = require(SERVICE);
    await expect(svc.generate({ prompt: '  ' })).rejects.toThrow(/prompt/);
  });
});

describe('_readPath helper', () => {
  test('reads dotted path with numeric indices', () => {
    const svc = require(SERVICE);
    const { _readPath } = svc.__testHooks;
    expect(_readPath({ a: { b: [{ c: 'v' }] } }, 'a.b.0.c')).toBe('v');
    expect(_readPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });
});

describe('image_generate tool', () => {
  test('registered, enabled, analysis category', () => {
    const tool = require(TOOL);
    expect(tool.name).toBe('image_generate');
    expect(tool.isEnabled()).toBe(true);
    expect(tool.category).toBe('analysis');
    expect(tool.aliases).toEqual(expect.arrayContaining(['generate_image', '绘图', '画图']));
  });

  test('no backend → success:false with actionable content (not empty)', async () => {
    const tool = require(TOOL);
    const res = await tool.execute({ prompt: 'a cat' });
    expect(res.success).toBe(false);
    expect(res.content).toMatch(/未检测到任何图像生成后端/);
    expect(res.content.length).toBeGreaterThan(20);
  });

  test('happy path saves a temp file and reports meta', async () => {
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'sk-test';
    mockFetch(() => okJson({ data: [{ b64_json: TINY_PNG }] }));
    const tool = require(TOOL);
    const res = await tool.execute({ prompt: 'a cat', size: '256x256' });
    expect(res.success).toBe(true);
    expect(res.meta.backend).toBe('openai');
    expect(res.meta.paths).toHaveLength(1);
    expect(require('fs').existsSync(res.meta.paths[0])).toBe(true);
    require('fs').unlinkSync(res.meta.paths[0]);
  });
});
