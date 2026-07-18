'use strict';

// Unit tests for the Agnes video backend (videoGenService) and the
// video_generate tool. No real network: global fetch is mocked per case.
// Polling is driven to 0ms so the async lifecycle completes instantly.

const fs = require('fs');
const path = require('path');

const SERVICE = '../src/services/videoGenService';
const TOOL = '../src/tools/videoGenerate';

const VID_ENV_KEYS = Object.keys(process.env).filter(k => k.startsWith('KHY_VIDEO_GEN_') || k.startsWith('GATEWAY_VIDEO_GEN_'));
let savedEnv;

function clearVidEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('KHY_VIDEO_GEN_') || k.startsWith('GATEWAY_VIDEO_GEN_')) delete process.env[k];
  }
}

beforeEach(() => {
  savedEnv = {};
  for (const k of VID_ENV_KEYS) savedEnv[k] = process.env[k];
  clearVidEnv();
  process.env.KHY_VIDEO_GEN_POLL_INTERVAL_MS = '1'; // fast polling for tests
  jest.resetModules();
});

afterEach(() => {
  clearVidEnv();
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

describe('videoGenService config + validation', () => {
  test('no backend → null, help text mentions Agnes env', () => {
    const svc = require(SERVICE);
    expect(svc.resolveBackend()).toBeNull();
    expect(svc.isAnyBackendConfigured()).toBe(false);
    expect(svc.backendHelpText()).toMatch(/KHY_VIDEO_GEN_AGNES_API_KEY/);
  });

  test('API key alone configures agnes; default base URL', () => {
    process.env.KHY_VIDEO_GEN_AGNES_API_KEY = 'sk-v';
    const svc = require(SERVICE);
    expect(svc.resolveBackend()).toBe('agnes');
    expect(svc.__testHooks._agnesBaseUrl()).toBe('https://apihub.agnes-ai.com');
  });

  test('validateFrameParams enforces 8n+1, <=441, fps 1-60', () => {
    const svc = require(SERVICE);
    expect(svc.validateFrameParams({ numFrames: 121, frameRate: 24 }))
      .toEqual({ numFrames: 121, frameRate: 24, seconds: 121 / 24 });
    expect(() => svc.validateFrameParams({ numFrames: 100 })).toThrow(/8n\+1/);
    expect(() => svc.validateFrameParams({ numFrames: 449 })).toThrow(/441/);
    expect(() => svc.validateFrameParams({ frameRate: 99 })).toThrow(/frame_rate/);
    // defaults are valid
    expect(svc.validateFrameParams({}).numFrames).toBe(121);
  });

  test('_buildAgnesBody routes single/multi/keyframes correctly', () => {
    const svc = require(SERVICE);
    const b = svc.__testHooks._buildAgnesBody;
    const base = { prompt: 'p', numFrames: 121, frameRate: 24 };
    expect(b('m', { ...base }).image).toBeUndefined();                  // text-to-video
    expect(b('m', { ...base, image: 'u' }).image).toBe('u');            // image-to-video
    expect(b('m', { ...base, images: ['a', 'b'] }).extra_body.image).toEqual(['a', 'b']); // multi
    const kf = b('m', { ...base, images: ['a', 'b'], mode: 'keyframes' });
    expect(kf.extra_body.mode).toBe('keyframes');
    expect(kf.image).toBeUndefined();
  });

  test('_extractVideoUrl reads remixed_from_video_id', () => {
    const svc = require(SERVICE);
    expect(svc.__testHooks._extractVideoUrl({ remixed_from_video_id: 'http://x/v.mp4' })).toBe('http://x/v.mp4');
    expect(svc.__testHooks._extractVideoUrl({ video_url: 'http://x/y.mp4' })).toBe('http://x/y.mp4');
    expect(svc.__testHooks._extractVideoUrl({})).toBeNull();
  });
});

describe('videoGenService.generate lifecycle (mocked fetch)', () => {
  test('create → poll queued → in_progress → completed', async () => {
    process.env.KHY_VIDEO_GEN_AGNES_API_KEY = 'sk-v';
    let poll = 0;
    const fetchMock = mockFetch((url, init) => {
      if (init && init.method === 'POST') {
        expect(url).toBe('https://apihub.agnes-ai.com/v1/videos');
        const body = JSON.parse(init.body);
        expect(body.model).toBe('agnes-video-v2.0');
        expect(body.num_frames).toBe(121);
        return okJson({ video_id: 'video_1', task_id: 'task_1', status: 'queued', progress: 0 });
      }
      // GET poll
      expect(url).toMatch(/\/agnesapi\?video_id=video_1/);
      poll += 1;
      if (poll === 1) return okJson({ status: 'in_progress', progress: 40 });
      return okJson({
        status: 'completed', progress: 100, seconds: '5.0', size: '1280x768',
        remixed_from_video_id: 'https://storage.googleapis.com/agnes-aigc/v.mp4',
      });
    });
    const svc = require(SERVICE);
    const seen = [];
    const out = await svc.generate({ prompt: 'a cat on a beach', onProgress: (p) => seen.push(p.status) });
    expect(out.status).toBe('completed');
    expect(out.videoUrl).toBe('https://storage.googleapis.com/agnes-aigc/v.mp4');
    expect(out.videoId).toBe('video_1');
    expect(out.seconds).toBe('5.0');
    expect(seen).toContain('completed');
    expect(fetchMock).toHaveBeenCalledTimes(3); // create + 2 polls
  });

  test('failed status → GENERATION_FAILED with reason', async () => {
    process.env.KHY_VIDEO_GEN_AGNES_API_KEY = 'sk-v';
    mockFetch((url, init) => {
      if (init && init.method === 'POST') return okJson({ video_id: 'v2', status: 'queued' });
      return okJson({ status: 'failed', error: { message: 'nsfw' } });
    });
    const svc = require(SERVICE);
    await expect(svc.generate({ prompt: 'x' })).rejects.toMatchObject({ code: 'GENERATION_FAILED' });
  });

  test('legacy poll style hits /v1/videos/{task_id}', async () => {
    process.env.KHY_VIDEO_GEN_AGNES_API_KEY = 'sk-v';
    process.env.KHY_VIDEO_GEN_AGNES_POLL_STYLE = 'task_id';
    const fetchMock = mockFetch((url, init) => {
      if (init && init.method === 'POST') return okJson({ task_id: 'task_9', video_id: 'v9', status: 'queued' });
      expect(url).toBe('https://apihub.agnes-ai.com/v1/videos/task_9');
      return okJson({ status: 'completed', remixed_from_video_id: 'http://x/z.mp4' });
    });
    const svc = require(SERVICE);
    const out = await svc.generate({ prompt: 'x' });
    expect(out.videoUrl).toBe('http://x/z.mp4');
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('video_generate tool', () => {
  test('registered, analysis category, expected aliases', () => {
    const tool = require(TOOL);
    expect(tool.name).toBe('video_generate');
    expect(tool.isEnabled()).toBe(true);
    expect(tool.aliases).toEqual(expect.arrayContaining(['text_to_video', '文生视频', '图生视频']));
  });

  test('bad numFrames → validateInput fails before any network', async () => {
    const tool = require(TOOL);
    const v = await tool.validateInput({ prompt: 'x', numFrames: 100 });
    expect(v.valid).toBe(false);
    expect(v.message).toMatch(/8n\+1/);
  });

  test('no backend → success:false with actionable content', async () => {
    const tool = require(TOOL);
    const res = await tool.execute({ prompt: 'a dog running' });
    expect(res.success).toBe(false);
    expect(res.code).toBe('NO_BACKEND');
    expect(res.content).toMatch(/未检测到任何视频生成后端/);
  });

  test('happy path downloads MP4 and reports meta', async () => {
    process.env.KHY_VIDEO_GEN_AGNES_API_KEY = 'sk-v';
    mockFetch((url, init) => {
      if (init && init.method === 'POST') return okJson({ video_id: 'v3', status: 'queued' });
      if (/agnesapi/.test(url)) {
        return okJson({ status: 'completed', seconds: '5.0', size: '1280x768', remixed_from_video_id: 'https://x/v.mp4' });
      }
      // download
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK',
        arrayBuffer: () => Promise.resolve(Buffer.from('FAKEMP4')) });
    });
    const tool = require(TOOL);
    const res = await tool.execute({ prompt: 'a cat' });
    expect(res.success).toBe(true);
    expect(res.meta.format).toBe('mp4');
    expect(res.meta.videoUrl).toBe('https://x/v.mp4');
    expect(fs.existsSync(res.meta.path)).toBe(true);
    expect(fs.readFileSync(res.meta.path).toString()).toBe('FAKEMP4');
    fs.unlinkSync(res.meta.path);
  });

  test('numInferenceSteps flows through the tool into num_inference_steps', async () => {
    process.env.KHY_VIDEO_GEN_AGNES_API_KEY = 'sk-v';
    const seen = {};
    mockFetch((url, init) => {
      if (init && init.method === 'POST') {
        seen.body = JSON.parse(init.body);
        return okJson({ video_id: 'v4', status: 'queued' });
      }
      if (/agnesapi/.test(url)) {
        return okJson({ status: 'completed', remixed_from_video_id: 'https://x/v.mp4' });
      }
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK',
        arrayBuffer: () => Promise.resolve(Buffer.from('FAKEMP4')) });
    });
    const tool = require(TOOL);
    const res = await tool.execute({ prompt: 'a cat', numInferenceSteps: 30 });
    expect(res.success).toBe(true);
    expect(seen.body.num_inference_steps).toBe(30); // documented create param, now reachable from the tool
    fs.unlinkSync(res.meta.path);
  });
});
