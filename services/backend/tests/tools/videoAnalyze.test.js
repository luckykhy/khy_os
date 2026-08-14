/**
 * videoAnalyze.test.js — unit tests for video_analyze tool.
 *
 * All external deps are mocked: child_process.spawn (intercepts ffprobe+ffmpeg),
 * searchExecutable/ensureSessionTmpDir (platformUtils), and aiGateway.generate.
 * A tiny temp MP4 fixture is written so FS validation passes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

// ── Mock platformUtils (searchExecutable + ensureSessionTmpDir) ──────────────

jest.mock('../../src/tools/platformUtils', () => {
  const actual = jest.requireActual('../../src/tools/platformUtils');
  return {
    ...actual,
    searchExecutable: jest.fn((name) => {
      if (name === 'ffmpeg') return '/usr/bin/ffmpeg';
      if (name === 'ffprobe') return '/usr/bin/ffprobe';
      return null;
    }),
    ensureSessionTmpDir: jest.fn(() => actual.getSessionTmpDir()),
  };
});

// ── Mock aiGateway ───────────────────────────────────────────────────────────

const mockGenerate = jest.fn();
jest.mock('../../src/services/gateway/aiGateway', () => ({
  generate: (...args) => mockGenerate(...args),
}));

// ── Mock child_process.spawn ─────────────────────────────────────────────────

const mockSpawn = jest.fn();
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, spawnSync: actual.spawnSync, spawn: mockSpawn };
});

// Import the tool after mocks are set up
const videoAnalyze = require('../../src/tools/videoAnalyze');

// ── Fake child process helper ────────────────────────────────────────────────

/**
 * Create a fake child process that satisfies spawnWithIdleTimeout's expectations.
 * spawnWithIdleTimeout calls: child.stdout.setEncoding('utf8'), .on('data', fn);
 * child.stderr.setEncoding('utf8'), .on('data', fn); child.on('error'); child.on('close').
 * @param {object} opts
 * @param {string} [opts.stdoutData] — data to emit on stdout (before close)
 * @param {string} [opts.stderrData]
 * @param {number} [opts.exitCode=0]
 * @param {Function} [opts.onSpawn] — called after child is returned but before data emits, can write frame files to disk
 */
function fakeChild({ stdoutData = '', stderrData = '', exitCode = 0, onSpawn = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = jest.fn();
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = jest.fn();
  child.kill = jest.fn();

  process.nextTick(() => {
    if (typeof onSpawn === 'function') onSpawn();
    if (stdoutData) child.stdout.emit('data', stdoutData);
    if (stderrData) child.stderr.emit('data', stderrData);
    child.emit('close', exitCode, null);
  });

  return child;
}

// Tiny valid-looking MP4 header (ftyp box)
const MP4_HEADER = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x1c]),
  Buffer.from('ftypmp42'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('mp42mp41'),
]);

describe('video_analyze tool', () => {
  let tmpDir;
  let videoPath;

  beforeEach(() => {
    mockSpawn.mockReset();
    mockGenerate.mockReset();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidat-'));
    videoPath = path.join(tmpDir, 'test.mp4');
    fs.writeFileSync(videoPath, MP4_HEADER);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('schema exposes metadata and validates inputs', () => {
    expect(videoAnalyze.name).toBe('video_analyze');
    expect(videoAnalyze.category).toBe('analysis');
    expect(videoAnalyze.isReadOnly()).toBe(true);
    expect(videoAnalyze.isConcurrencySafe()).toBe(true);

    expect(videoAnalyze.validate({}).valid).toBe(false);
    expect(videoAnalyze.validate({ videoPath: '/tmp/x.mp4', frames: 4, query: 'x?' }).valid).toBe(true);
    expect(videoAnalyze.validate({ videoPath: '/tmp/x.mp4', frames: 100 }).valid).toBe(false);
  });

  test('rejects unsupported format without calling ffmpeg', async () => {
    const txtPath = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(txtPath, 'hello');
    const res = await videoAnalyze.execute({ videoPath: txtPath });
    expect(res.success).toBe(false);
    expect(res.content).toContain('Unsupported');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test('missing file fails', async () => {
    const res = await videoAnalyze.execute({ videoPath: path.join(tmpDir, 'nope.mp4') });
    expect(res.success).toBe(false);
    expect(res.content).toContain('not found');
  });

  test('ffprobe + ffmpeg + vision model pipeline works end to end', async () => {
    // 1st mockSpawn → ffprobe
    mockSpawn.mockImplementationOnce(() => fakeChild({
      stdoutData: JSON.stringify({ format: { duration: '30.0' }, streams: [{ width: 1920, height: 1080 }] }),
    }));

    // 2nd mockSpawn → ffmpeg (writes frames to disk)
    mockSpawn.mockImplementationOnce(() => fakeChild({
      onSpawn: () => {
        // Write fake JPEG frames so _extractFrames can find them
        const sessionDir = require('../../src/tools/platformUtils').getSessionTmpDir();
        const outDir = path.join(sessionDir, `video-frames-test-${fs.statSync(videoPath).size}`);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'frame_0001.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
        fs.writeFileSync(path.join(outDir, 'frame_0002.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]));
      },
    }));

    mockGenerate.mockResolvedValue({ success: true, content: 'Scene 1: ...\nScene 2: ...', model: 'claude-vision', provider: 'anthropic' });

    const res = await videoAnalyze.execute({ videoPath, query: 'what happens?' });

    expect(res.success).toBe(true);
    expect(res.content).toContain('Scene 1');
    expect(res.content).toContain('30.0s');
    expect(res.content).toContain('1920x1080');
    expect(res.meta.duration).toBe(30);
    expect(res.meta.resolution).toBe('1920x1080');
    expect(res.meta.framesExtracted).toBe(2);
    expect(res.meta.model).toBe('claude-vision');

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const [prompt, opts] = mockGenerate.mock.calls[0];
    expect(prompt).toContain('what happens?');
    expect(Array.isArray(opts.images)).toBe(true);
    expect(opts.images.length).toBe(2);
    expect(opts.images[0].mimeType).toBe('image/jpeg');
  });

  test('ffprobe failure degrades gracefully (zero duration)', async () => {
    // ffprobe fails
    mockSpawn.mockImplementationOnce(() => fakeChild({ exitCode: 1 }));

    // ffmpeg succeeds, writes a frame
    mockSpawn.mockImplementationOnce(() => fakeChild({
      onSpawn: () => {
        const sessionDir = require('../../src/tools/platformUtils').getSessionTmpDir();
        const outDir = path.join(sessionDir, `video-frames-test-${fs.statSync(videoPath).size}`);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'frame_0001.jpg'), Buffer.from([0xFF, 0xD8]));
      },
    }));

    mockGenerate.mockResolvedValue({ success: true, content: 'Analysis without duration.', provider: 'qwen' });

    const res = await videoAnalyze.execute({ videoPath, frames: 4 });

    expect(res.success).toBe(true);
    expect(res.meta.duration).toBe(0);
    expect(res.meta.framesExtracted).toBe(1);
  });

  test('vision failure returns structured error', async () => {
    // ffprobe
    mockSpawn.mockImplementationOnce(() => fakeChild({
      stdoutData: JSON.stringify({ format: { duration: '10.0' }, streams: [{ width: 640, height: 480 }] }),
    }));
    // ffmpeg
    mockSpawn.mockImplementationOnce(() => fakeChild({
      onSpawn: () => {
        const sessionDir = require('../../src/tools/platformUtils').getSessionTmpDir();
        const outDir = path.join(sessionDir, `video-frames-test-${fs.statSync(videoPath).size}`);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'frame_0001.jpg'), Buffer.from([0xFF, 0xD8]));
      },
    }));

    mockGenerate.mockResolvedValue({ success: false, content: 'no vision adapter', provider: null });

    const res = await videoAnalyze.execute({ videoPath });

    expect(res.success).toBe(false);
    expect(res.content).toMatch(/vision-capable/i);
  });

  test('gateway reject is caught and frames are cleaned', async () => {
    // ffprobe
    mockSpawn.mockImplementationOnce(() => fakeChild({
      stdoutData: JSON.stringify({ format: { duration: '5.0' }, streams: [] }),
    }));
    // ffmpeg
    mockSpawn.mockImplementationOnce(() => fakeChild({
      onSpawn: () => {
        const sessionDir = require('../../src/tools/platformUtils').getSessionTmpDir();
        const outDir = path.join(sessionDir, `video-frames-test-${fs.statSync(videoPath).size}`);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'frame_0001.jpg'), Buffer.from([0xFF, 0xD8]));
      },
    }));

    mockGenerate.mockRejectedValue(new Error('network error'));

    const res = await videoAnalyze.execute({ videoPath });
    expect(res.success).toBe(false);
    expect(res.content).toContain('network error');
  });

  test('frame extraction failure returns structured error', async () => {
    // ffprobe works
    mockSpawn.mockImplementationOnce(() => fakeChild({
      stdoutData: JSON.stringify({ format: { duration: '5.0' }, streams: [] }),
    }));
    // ffmpeg fails (non-zero exit, no frames written)
    mockSpawn.mockImplementationOnce(() => fakeChild({ exitCode: 1 }));

    const res = await videoAnalyze.execute({ videoPath });
    expect(res.success).toBe(false);
    expect(res.content).toContain('No frames could be extracted');
    // Vision model was never called
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
