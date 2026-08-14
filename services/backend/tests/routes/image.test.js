'use strict';

/**
 * image route — 图像生成 API 路由测试。
 *
 * 不依赖真实网络：imageGenService 在测试中被模块级 mock。
 */

const express = require('express');
const http = require('http');
const imageRoute = require('../../src/routes/image');
const imageGenService = require('../../src/services/imageGenService');

jest.mock('../../src/services/imageGenService', () => ({
  isAnyBackendConfigured: jest.fn(() => true),
  resolveBackend: jest.fn(() => 'agnes'),
  backendHelpText: jest.fn(() => 'no backend configured'),
  backendStatus: jest.fn(() => ({ openai: false, sensenova: false, agnes: true, stepfun: false, domestic: false, sd_webui: false })),
  catalogModels: jest.fn(() => [
    { backend: 'agnes', model: 'agnes-image-2.0-flash', capability: 'image', supportsEdit: true },
    { backend: 'agnes', model: 'agnes-image-2.1-flash', capability: 'image', supportsEdit: true },
  ]),
  generate: jest.fn(),
}));

// Mock agnesImageModel
jest.mock('../../src/services/agnesImageModel', () => ({
  defaultAgnesGenModel: jest.fn(() => 'agnes-image-2.0-flash'),
  knownAgnesImageModels: jest.fn(() => ['agnes-image-2.0-flash', 'agnes-image-2.1-flash']),
  UNIFIED_AGNES_IMAGE_MODEL: 'agnes-image-2.0-flash',
  UPGRADED_AGNES_IMAGE_MODEL: 'agnes-image-2.1-flash',
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/image', imageRoute);
  return app;
}

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function sendRequest(server, { method, pathName, body }) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const address = server.address();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: pathName,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body = null;
          try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('image route', () => {
  let app;
  let server;

  beforeEach(async () => {
    app = createTestApp();
    server = await startTestServer(app);
    // Default: backend is configured
    imageGenService.isAnyBackendConfigured.mockReturnValue(true);
    imageGenService.resolveBackend.mockReturnValue('agnes');
    imageGenService.backendHelpText.mockReturnValue('no backend configured');
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    jest.clearAllMocks();
  });

  // ── POST /api/image/generate ─────────────────────────────────────────────────

  describe('POST /generate', () => {
    test('requires prompt', async () => {
      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: {},
      });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('MISSING_PROMPT');
    });

    test('returns 503 when no backend configured', async () => {
      imageGenService.isAnyBackendConfigured.mockReturnValue(false);
      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: { prompt: 'a cat' },
      });
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('NO_BACKEND');
    });

    test('happy path — creates image and returns base64', async () => {
      imageGenService.generate.mockResolvedValue({
        backend: 'agnes',
        model: 'agnes-image-2.0-flash',
        images: [{ base64: 'iVBORw0KGgoAAAANSUhEUgAA...' }],
        size: '1024x1024',
        n: 1,
        edited: false,
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: { prompt: 'a cat on the beach' },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.backend).toBe('agnes');
      expect(res.body.model).toBe('agnes-image-2.0-flash');
      expect(res.body.images).toHaveLength(1);
      expect(res.body.images[0].base64).toBe('iVBORw0KGgoAAAANSUhEUgAA...');
      expect(res.body.images[0].dataUrl).toContain('data:image/png;base64,');
      expect(res.body.message).toContain('已生成 1 张图像');
      expect(imageGenService.generate).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'a cat on the beach' }),
      );
    });

    test('happy path — StepFun backend', async () => {
      imageGenService.generate.mockResolvedValue({
        backend: 'stepfun',
        model: 'step-image-edit-2',
        images: [{ base64: 'iVBORw0KGgoAAAANSUhEUgAA...' }],
        size: '1024x1024',
        n: 1,
        edited: false,
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: { prompt: 'a cat on the beach', backend: 'stepfun' },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.backend).toBe('stepfun');
      expect(res.body.model).toBe('step-image-edit-2');
      expect(imageGenService.generate).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'a cat on the beach', backend: 'stepfun' }),
      );
    });

    test('happy path — SenseNova backend (text-to-image only)', async () => {
      imageGenService.generate.mockResolvedValue({
        backend: 'sensenova',
        model: 'sensenova-u1-fast',
        images: [{ base64: 'iVBORw0KGgoAAAANSUhEUgAA...' }],
        size: '2752x1536',
        n: 1,
        edited: false,
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: { prompt: 'infographic about AI', backend: 'sensenova', size: '2752x1536' },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.backend).toBe('sensenova');
      expect(res.body.model).toBe('sensenova-u1-fast');
      expect(imageGenService.generate).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'infographic about AI', backend: 'sensenova', size: '2752x1536' }),
      );
    });

    test('returns 400 when SenseNova is used for img2img', async () => {
      imageGenService.isAnyBackendConfigured.mockReturnValue(true);
      imageGenService.resolveBackend.mockReturnValue('sensenova');
      imageGenService.generate.mockRejectedValue({
        code: 'EDIT_UNSUPPORTED',
        message: 'SenseNova does not support img2img',
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: { prompt: 'edit this', images: ['https://example.com/x.png'], backend: 'sensenova' },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EDIT_UNSUPPORTED');
    });

    test('passes images / model / size / n / seed', async () => {
      imageGenService.generate.mockResolvedValue({
        backend: 'agnes',
        model: 'agnes-image-2.1-flash',
        images: [{ base64: 'abc123' }],
        size: '2K',
        n: 2,
        edited: true,
      });

      await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: {
          prompt: 'cyberpunk city',
          images: ['https://example.com/input.png'],
          model: 'agnes-image-2.1-flash',
          size: '2K',
          n: 2,
          seed: 42,
          negativePrompt: 'blurry',
        },
      });

      expect(imageGenService.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'cyberpunk city',
          images: ['https://example.com/input.png'],
          model: 'agnes-image-2.1-flash',
          size: '2K',
          n: 2,
          seed: 42,
          negativePrompt: 'blurry',
        }),
      );
    });

    test('returns 500 on generation failure', async () => {
      imageGenService.generate.mockRejectedValue({
        code: 'GENERATION_FAILED',
        message: 'nsfw content detected',
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: { prompt: 'x' },
      });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('GENERATION_FAILED');
    });

    test('returns 503 on NO_USABLE_KEY', async () => {
      imageGenService.generate.mockRejectedValue({
        code: 'NO_USABLE_KEY',
        message: 'all keys exhausted',
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: { prompt: 'test' },
      });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('NO_USABLE_KEY');
    });

    test('returns 400 on EDIT_UNSUPPORTED', async () => {
      imageGenService.isAnyBackendConfigured.mockReturnValue(true);
      imageGenService.resolveBackend.mockReturnValue('openai');
      imageGenService.generate.mockRejectedValue({
        code: 'EDIT_UNSUPPORTED',
        message: 'OpenAI does not support img2img',
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/image/generate',
        body: { prompt: 'edit this', images: ['https://example.com/x.png'] },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EDIT_UNSUPPORTED');
    });
  });

  // ── GET /api/image/backends ──────────────────────────────────────────────────

  describe('GET /backends', () => {
    test('returns backend status and model catalog', async () => {
      imageGenService.backendStatus.mockReturnValue({
        openai: false,
        sensenova: true,
        agnes: true,
        stepfun: true,
        domestic: false,
        sd_webui: false,
      });
      imageGenService.catalogModels.mockReturnValue([
        { backend: 'sensenova', model: 'sensenova-u1-fast', capability: 'image', supportsEdit: false },
        { backend: 'agnes', model: 'agnes-image-2.0-flash', capability: 'image', supportsEdit: true },
        { backend: 'agnes', model: 'agnes-image-2.1-flash', capability: 'image', supportsEdit: true },
        { backend: 'stepfun', model: 'step-image-edit-2', capability: 'image', supportsEdit: true },
      ]);

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/image/backends',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.backends).toEqual({ openai: false, sensenova: true, agnes: true, stepfun: true, domestic: false, sd_webui: false });
      expect(res.body.data.models).toHaveLength(4);
      expect(res.body.data.models[0]).toHaveProperty('backend', 'sensenova');
      expect(res.body.data.models[0]).toHaveProperty('supportsEdit', false);
      expect(res.body.data.models.some(m => m.backend === 'stepfun' && m.model === 'step-image-edit-2')).toBe(true);
      expect(res.body.data.models.some(m => m.backend === 'agnes' && m.supportsEdit)).toBe(true);
      expect(res.body.data.anyConfigured).toBe(true);
      expect(res.body.data.defaults).toBeDefined();
      expect(res.body.data.defaults.agnes).toBe('agnes-image-2.0-flash');
      expect(res.body.data.defaults.knownAgnesModels).toEqual(['agnes-image-2.0-flash', 'agnes-image-2.1-flash']);
      expect(res.body.data.defaults.stepfun).toBe('step-image-edit-2');
    });

    test('returns no-backend state when nothing configured', async () => {
      imageGenService.backendStatus.mockReturnValue({
        openai: false, sensenova: false, agnes: false, stepfun: false, domestic: false, sd_webui: false,
      });
      imageGenService.catalogModels.mockReturnValue([]);
      imageGenService.isAnyBackendConfigured.mockReturnValue(false);

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/image/backends',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.anyConfigured).toBe(false);
      expect(res.body.data.models).toHaveLength(0);
    });
  });
});
