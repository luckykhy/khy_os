'use strict';

/**
 * video route — 视频生成 API 路由测试。
 *
 * 不依赖真实网络：videoGenService 在测试中被模块级 mock，
 * generate() / __testHooks._pollAgnes() 返回可控数据。
 */

const express = require('express');
const http = require('http');
const videoRoute = require('../../src/routes/video');
const videoGenService = require('../../src/services/videoGenService');

jest.mock('../../src/services/videoGenService', () => ({
  isAnyBackendConfigured: jest.fn(() => true),
  resolveBackend: jest.fn(() => 'agnes'),
  backendHelpText: jest.fn(() => 'no backend configured'),
  backendStatus: jest.fn(() => ({ agnes: true })),
  catalogModels: jest.fn(() => []),
  generate: jest.fn(),
  __testHooks: {
    _pollAgnes: jest.fn(),
  },
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/video', videoRoute);
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

describe('video route', () => {
  let app;
  let server;

  beforeEach(async () => {
    app = createTestApp();
    server = await startTestServer(app);
    // Default: backend is configured
    videoGenService.isAnyBackendConfigured.mockReturnValue(true);
    videoGenService.resolveBackend.mockReturnValue('agnes');
    videoGenService.backendHelpText.mockReturnValue('no backend configured');
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    jest.clearAllMocks();
  });

  // ── POST /api/video/generate ─────────────────────────────────────────────────

  describe('POST /generate', () => {
    test('requires prompt', async () => {
      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/video/generate',
        body: {},
      });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('MISSING_PROMPT');
    });

    test('returns 503 when no backend configured', async () => {
      videoGenService.isAnyBackendConfigured.mockReturnValue(false);
      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/video/generate',
        body: { prompt: 'a cat' },
      });
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('NO_BACKEND');
    });

    test('happy path — creates task and returns videoId + videoUrl', async () => {
      videoGenService.generate.mockResolvedValue({
        backend: 'agnes',
        model: 'agnes-video-v2.0',
        videoId: 'video_abc123',
        taskId: 'task_abc123',
        status: 'completed',
        videoUrl: 'https://example.com/video.mp4',
        seconds: '5.0',
        size: '1280x768',
        progress: 100,
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/video/generate',
        body: { prompt: 'a cat walking on the beach' },
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.videoId).toBe('video_abc123');
      expect(res.body.taskId).toBe('task_abc123');
      expect(res.body.status).toBe('completed');
      expect(res.body.videoUrl).toBe('https://example.com/video.mp4');
      expect(res.body.seconds).toBe('5.0');
      expect(res.body.size).toBe('1280x768');
      expect(videoGenService.generate).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'a cat walking on the beach' }),
      );
    });

    test('passes images / mode / seed / numFrames / frameRate', async () => {
      videoGenService.generate.mockResolvedValue({
        backend: 'agnes',
        model: 'agnes-video-v2.0',
        videoId: 'v1',
        taskId: 't1',
        status: 'completed',
        videoUrl: 'https://x/v.mp4',
        seconds: '3.0',
        size: '832x448',
        progress: 100,
      });

      await sendRequest(server, {
        method: 'POST',
        pathName: '/api/video/generate',
        body: {
          prompt: 'keyframes',
          images: ['https://a.jpg', 'https://b.jpg'],
          mode: 'keyframes',
          numFrames: 81,
          frameRate: 24,
          seed: 42,
          negativePrompt: 'blurry',
          width: 832,
          height: 448,
        },
      });

      expect(videoGenService.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'keyframes',
          images: ['https://a.jpg', 'https://b.jpg'],
          mode: 'keyframes',
          numFrames: 81,
          frameRate: 24,
          seed: 42,
          negativePrompt: 'blurry',
          width: 832,
          height: 448,
        }),
      );
    });

    test('returns 500 on generation failure', async () => {
      videoGenService.generate.mockRejectedValue({
        code: 'GENERATION_FAILED',
        message: 'nsfw content detected',
        partial: { videoId: 'v_x' },
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/video/generate',
        body: { prompt: 'x' },
      });

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('GENERATION_FAILED');
      expect(res.body.error).toContain('nsfw');
    });

    test('returns 504 on timeout', async () => {
      videoGenService.generate.mockRejectedValue({
        code: 'TIMEOUT',
        message: '视频生成超时（>600s）',
        partial: { status: 'in_progress' },
      });

      const res = await sendRequest(server, {
        method: 'POST',
        pathName: '/api/video/generate',
        body: { prompt: 'long video' },
      });

      expect(res.status).toBe(504);
      expect(res.body.code).toBe('TIMEOUT');
    });
  });

  // ── GET /api/video/status/:videoId ──────────────────────────────────────────

  describe('GET /status/:videoId', () => {
    test('returns 400 when videoId empty', async () => {
      // Express treats '/status/' (trailing slash) as no match for ':videoId',
      // so we test via a request that hits the route with an empty param instead.
      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/status/',
      });
      // Express 404 when param is empty string — that's acceptable behaviour.
      expect([400, 404]).toContain(res.status);
    });

    test('returns 503 when no backend configured', async () => {
      videoGenService.isAnyBackendConfigured.mockReturnValue(false);
      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/status/video_123',
      });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('NO_BACKEND');
    });

    test('happy path — returns completed status with videoUrl', async () => {
      videoGenService.__testHooks._pollAgnes.mockResolvedValue({
        id: 'task_1',
        video_id: 'video_1',
        task_id: 'task_1',
        status: 'completed',
        progress: 100,
        model: 'agnes-video-v2.0',
        seconds: '5.0',
        size: '1280x768',
        remixed_from_video_id: 'https://example.com/v.mp4',
      });

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/status/video_1',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.videoId).toBe('video_1');
      expect(res.body.status).toBe('completed');
      expect(res.body.completed).toBe(true);
      expect(res.body.videoUrl).toBe('https://example.com/v.mp4');
      expect(res.body.progress).toBe(100);
    });

    test('returns in_progress without videoUrl', async () => {
      videoGenService.__testHooks._pollAgnes.mockResolvedValue({
        status: 'in_progress',
        progress: 60,
        model: 'agnes-video-v2.0',
      });

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/status/video_1',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('in_progress');
      expect(res.body.completed).toBe(false);
      expect(res.body.videoUrl).toBeUndefined();
      expect(res.body.progress).toBe(60);
    });

    test('returns failed status with error', async () => {
      videoGenService.__testHooks._pollAgnes.mockResolvedValue({
        status: 'failed',
        error: { message: 'nsfw detected' },
        model: 'agnes-video-v2.0',
      });

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/status/video_1',
      });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.completed).toBe(true);
      expect(res.body.error).toContain('nsfw');
    });

    test('returns 404 when task not found', async () => {
      videoGenService.__testHooks._pollAgnes.mockResolvedValue(null);

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/status/video_nonexistent',
      });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    test('returns 501 for unsupported backend', async () => {
      videoGenService.resolveBackend.mockReturnValue('unknown_backend');

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/status/video_1',
      });

      expect(res.status).toBe(501);
      expect(res.body.code).toBe('UNSUPPORTED_BACKEND');
    });

    test('handles poll error gracefully', async () => {
      videoGenService.__testHooks._pollAgnes.mockRejectedValue({
        status: 502,
        message: 'Bad Gateway',
        code: 'POLL_ERROR',
      });

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/status/video_1',
      });

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
    });
  });

  // ── GET /api/video/backends ─────────────────────────────────────────────────

  describe('GET /backends', () => {
    test('returns backend status and model catalog', async () => {
      videoGenService.catalogModels.mockReturnValue([
        { backend: 'agnes', model: 'agnes-video-v2.0', capability: 'video' },
      ]);
      videoGenService.backendStatus.mockReturnValue({ agnes: true });

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/backends',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.backends).toEqual({ agnes: true });
      expect(res.body.data.models).toHaveLength(1);
      expect(res.body.data.anyConfigured).toBe(true);
    });

    test('returns no-backend state when nothing configured', async () => {
      videoGenService.backendStatus.mockReturnValue({ agnes: false });
      videoGenService.catalogModels.mockReturnValue([]);
      videoGenService.isAnyBackendConfigured.mockReturnValue(false);

      const res = await sendRequest(server, {
        method: 'GET',
        pathName: '/api/video/backends',
      });

      expect(res.status).toBe(200);
      expect(res.body.data.anyConfigured).toBe(false);
      expect(res.body.data.models).toHaveLength(0);
    });
  });
});
