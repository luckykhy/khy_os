'use strict';

// Unit tests for the Agnes image backend (imageGenService) and the image_edit
// tool. No real network: global fetch is mocked per case.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVICE = '../src/services/imageGenService';
const EDIT_TOOL = '../src/tools/imageEdit';
const GEN_TOOL = '../src/tools/imageGenerate';

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

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('Agnes image backend resolution', () => {
  test('API key alone configures agnes (public default base URL)', () => {
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    const svc = require(SERVICE);
    expect(svc.backendStatus().agnes).toBe(true);
    expect(svc.isAnyBackendConfigured()).toBe(true);
    expect(svc.__testHooks._agnesBaseUrl()).toBe('https://apihub.agnes-ai.com/v1');
    expect(svc.backendSupportsEdit('agnes')).toBe(true);
    expect(svc.backendSupportsEdit('openai')).toBe(false);
  });

  test('auto-detect precedence openai > agnes', () => {
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'k';
    const svc = require(SERVICE);
    expect(svc.resolveBackend()).toBe('openai');
  });

  test('explicit BACKEND=agnes wins; base URL override honored', () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'agnes';
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    process.env.KHY_IMAGE_GEN_AGNES_BASE_URL = 'https://proxy.local/v1/';
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'k';
    const svc = require(SERVICE);
    expect(svc.resolveBackend()).toBe('agnes');
    expect(svc.__testHooks._agnesBaseUrl()).toBe('https://proxy.local/v1'); // trailing slash trimmed
  });

  test('help text lists Agnes env', () => {
    const svc = require(SERVICE);
    expect(svc.backendHelpText()).toMatch(/KHY_IMAGE_GEN_AGNES_API_KEY/);
  });
});

describe('Agnes image backend (mocked fetch)', () => {
  test('text-to-image puts response_format in extra_body, unified default gen model (2.0-flash)', async () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'agnes';
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe('https://apihub.agnes-ai.com/v1/images/generations');
      const body = JSON.parse(init.body);
      // Gate KHY_AGNES_UNIFIED_IMAGE_MODEL defaults ON → text-to-image default is the
      // officially-registered unified model agnes-image-2.0-flash (was 2.1-flash).
      expect(body.model).toBe('agnes-image-2.0-flash');
      expect(body.prompt).toBe('a glass cube');
      expect(body.size).toBe('1024x768');
      expect(body.extra_body).toEqual({ response_format: 'b64_json' });
      expect(body.response_format).toBeUndefined(); // never top-level (Agnes 400s)
      expect(body.image).toBeUndefined();           // text-to-image has no image[]
      expect(init.headers.authorization).toBe('Bearer sk-agnes');
      return okJson({ created: 1, data: [{ b64_json: TINY_PNG, url: null }] });
    });
    const svc = require(SERVICE);
    const out = await svc.generate({ prompt: 'a glass cube', size: '1024x768' });
    expect(out.backend).toBe('agnes');
    expect(out.model).toBe('agnes-image-2.0-flash');
    expect(out.edited).toBe(false);
    expect(out.images[0].base64).toBe(TINY_PNG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('gate KHY_AGNES_UNIFIED_IMAGE_MODEL=0 byte-reverts text-to-image default to 2.1-flash', async () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'agnes';
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    process.env.KHY_AGNES_UNIFIED_IMAGE_MODEL = '0';
    try {
      const fetchMock = mockFetch((url, init) => {
        const body = JSON.parse(init.body);
        expect(body.model).toBe('agnes-image-2.1-flash'); // legacy default restored
        return okJson({ data: [{ b64_json: TINY_PNG }] });
      });
      const svc = require(SERVICE);
      const out = await svc.generate({ prompt: 'a glass cube' });
      expect(out.model).toBe('agnes-image-2.1-flash');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.KHY_AGNES_UNIFIED_IMAGE_MODEL;
    }
  });

  test('explicit KHY_IMAGE_GEN_AGNES_MODEL override wins over the unified default', async () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'agnes';
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    process.env.KHY_IMAGE_GEN_AGNES_MODEL = 'agnes-image-2.1-flash';
    const fetchMock = mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe('agnes-image-2.1-flash'); // explicit env pin honored
      return okJson({ data: [{ b64_json: TINY_PNG }] });
    });
    const svc = require(SERVICE);
    const out = await svc.generate({ prompt: 'high-density diagram' });
    expect(out.model).toBe('agnes-image-2.1-flash');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('per-call model override selects 2.1-flash for text-to-image', async () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'agnes';
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe('agnes-image-2.1-flash'); // caller (UI) selection wins
      return okJson({ data: [{ b64_json: TINY_PNG }] });
    });
    const svc = require(SERVICE);
    const out = await svc.generate({ prompt: 'poster', model: 'agnes-image-2.1-flash' });
    expect(out.model).toBe('agnes-image-2.1-flash');
  });

  test('image-to-image uses edit model + extra_body.image[]', async () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'agnes';
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      expect(body.model).toBe('agnes-image-2.0-flash'); // edit default
      expect(body.extra_body.image).toEqual(['https://x/y.png']);
      expect(body.extra_body.response_format).toBe('b64_json');
      return okJson({ data: [{ b64_json: TINY_PNG }] });
    });
    const svc = require(SERVICE);
    const out = await svc.generate({ prompt: 'make it cyberpunk', images: ['https://x/y.png'] });
    expect(out.edited).toBe(true);
    expect(out.model).toBe('agnes-image-2.0-flash');
  });

  test('URL-only response is downloaded to base64', async () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'agnes';
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    const fetchMock = mockFetch((url) => {
      if (url === 'https://storage.googleapis.com/agnes-aigc/x.png') {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK',
          arrayBuffer: () => Promise.resolve(Buffer.from(TINY_PNG, 'base64')) });
      }
      return okJson({ data: [{ url: 'https://storage.googleapis.com/agnes-aigc/x.png', b64_json: null }] });
    });
    const svc = require(SERVICE);
    const out = await svc.generate({ prompt: 'a cat' });
    expect(out.images[0].base64).toBe(TINY_PNG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('top_level request style flips placement', async () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'agnes';
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    process.env.KHY_IMAGE_GEN_AGNES_REQUEST_STYLE = 'top_level';
    mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      expect(body.response_format).toBe('b64_json');
      expect(body.image).toEqual(['data:image/png;base64,xx']);
      expect(body.extra_body).toBeUndefined();
      return okJson({ data: [{ b64_json: TINY_PNG }] });
    });
    const svc = require(SERVICE);
    await svc.generate({ prompt: 'edit', images: ['data:image/png;base64,xx'] });
  });
});

describe('generate() guards img2img on non-edit backends', () => {
  test('openai backend + images → EDIT_UNSUPPORTED', async () => {
    process.env.KHY_IMAGE_GEN_OPENAI_BASE_URL = 'https://o.example/v1';
    process.env.KHY_IMAGE_GEN_OPENAI_API_KEY = 'k';
    const svc = require(SERVICE);
    await expect(svc.generate({ prompt: 'x', images: ['https://x/y.png'] }))
      .rejects.toMatchObject({ code: 'EDIT_UNSUPPORTED' });
  });
});

describe('image_edit tool', () => {
  test('registered, analysis category, expected aliases', () => {
    const tool = require(EDIT_TOOL);
    expect(tool.name).toBe('image_edit');
    expect(tool.isEnabled()).toBe(true);
    expect(tool.category).toBe('analysis');
    expect(tool.aliases).toEqual(expect.arrayContaining(['img2img', '图改图', '图生图']));
  });

  test('missing images → validateInput fails', async () => {
    const tool = require(EDIT_TOOL);
    const v = await tool.validateInput({ prompt: 'x', images: [] });
    expect(v.valid).toBe(false);
  });

  test('no edit backend → success:false with actionable content', async () => {
    const tool = require(EDIT_TOOL);
    const res = await tool.execute({ prompt: 'x', images: ['https://x/y.png'] });
    expect(res.success).toBe(false);
    // openai/none not configured → NO_BACKEND; content must be non-empty guidance.
    expect(res.content.length).toBeGreaterThan(20);
  });

  test('local file input is encoded to a data URI and result saved', async () => {
    process.env.KHY_IMAGE_GEN_BACKEND = 'agnes';
    process.env.KHY_IMAGE_GEN_AGNES_API_KEY = 'sk-agnes';
    // Write a tiny PNG inside the project tree (path-confinement allows cwd).
    const srcDir = fs.mkdtempSync(path.join(process.cwd(), '.agnes-test-'));
    const src = path.join(srcDir, 'in.png');
    fs.writeFileSync(src, Buffer.from(TINY_PNG, 'base64'));
    try {
      const seen = {};
      mockFetch((url, init) => {
        const body = JSON.parse(init.body);
        seen.image = body.extra_body.image;
        return okJson({ data: [{ b64_json: TINY_PNG }] });
      });
      const tool = require(EDIT_TOOL);
      const res = await tool.execute({ prompt: 'restyle', images: [src], size: '512x512' });
      expect(res.success).toBe(true);
      expect(res.meta.edited).toBe(true);
      expect(res.meta.inputCount).toBe(1);
      expect(seen.image[0]).toMatch(/^data:image\/png;base64,/);
      expect(fs.existsSync(res.meta.paths[0])).toBe(true);
      fs.unlinkSync(res.meta.paths[0]);
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
    }
  });
});
