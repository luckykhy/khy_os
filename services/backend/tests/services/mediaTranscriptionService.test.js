'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function writeTempFile(ext = '.tmp', content = 'x') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-transcribe-test-'));
  const filePath = path.join(dir, `sample${ext}`);
  fs.writeFileSync(filePath, content);
  return { dir, filePath };
}

describe('mediaTranscriptionService', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  test('returns file-not-found for missing input path', () => {
    jest.doMock('child_process', () => ({ spawnSync: jest.fn() }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn(() => null),
    }));
    const svc = require('../../src/services/mediaTranscriptionService');
    const res = svc.transcribeMediaFile('/tmp/not-exists-audio.mp3', 'audio/mpeg', {});
    expect(res.success).toBe(false);
    expect(String(res.error || '')).toContain('file not found');
  });

  test('returns unsupported kind for non-audio/video file', () => {
    const tmp = writeTempFile('.txt', 'not audio');
    jest.doMock('child_process', () => ({ spawnSync: jest.fn() }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn(() => null),
    }));
    const svc = require('../../src/services/mediaTranscriptionService');
    const res = svc.transcribeMediaFile(tmp.filePath, 'text/plain', {});
    expect(res.success).toBe(false);
    expect(String(res.error || '')).toContain('unsupported media kind');
    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('accepts whisper transcript variant file name (e.g. .en.txt)', () => {
    const tmp = writeTempFile('.mp3', 'fake-audio-data');
    const spawnSync = jest.fn((cmd, args) => {
      if (cmd === 'whisper') {
        const input = String(args?.[0] || '');
        const transcript = path.join(
          path.dirname(input),
          `${path.basename(input, path.extname(input))}.en.txt`
        );
        fs.writeFileSync(transcript, 'hello from whisper transcript');
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unexpected command' };
    });

    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn((name) => (name === 'whisper' ? '/usr/bin/whisper' : null)),
    }));

    const svc = require('../../src/services/mediaTranscriptionService');
    const res = svc.transcribeMediaFile(tmp.filePath, 'audio/mpeg', {});
    expect(res.success).toBe(true);
    expect(res.engine).toBe('whisper');
    expect(String(res.text || '')).toContain('hello from whisper transcript');

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('falls back to ffmpeg + whisper-cpp and resolves model path from model dir', () => {
    const media = writeTempFile('.mp4', 'fake-video-data');
    const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mm-model-'));
    const modelPath = path.join(modelDir, 'ggml-base.bin');
    fs.writeFileSync(modelPath, 'model');
    process.env.KHY_MULTIMODAL_TRANSCRIBE_CPP_MODEL_DIR = modelDir;
    process.env.KHY_MULTIMODAL_TRANSCRIBE_CPP_MODEL = 'base';

    const spawnSync = jest.fn((cmd, args) => {
      if (cmd === 'whisper') {
        return { status: 1, stdout: '', stderr: 'whisper failed' };
      }
      if (cmd === 'ffmpeg') {
        const wavOut = String(args?.[args.length - 1] || '');
        fs.writeFileSync(wavOut, 'wav-bytes');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'whisper-cpp') {
        return { status: 0, stdout: 'cpp transcript ok', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'unknown command' };
    });

    jest.doMock('child_process', () => ({ spawnSync }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn((name) => {
        if (name === 'whisper' || name === 'ffmpeg' || name === 'whisper-cpp') return `/usr/bin/${name}`;
        return null;
      }),
    }));

    const svc = require('../../src/services/mediaTranscriptionService');
    const res = svc.transcribeMediaFile(media.filePath, 'video/mp4', { language: 'en' });
    expect(res.success).toBe(true);
    expect(res.engine).toBe('whisper-cpp');
    expect(String(res.text || '')).toContain('cpp transcript ok');

    const cppCall = spawnSync.mock.calls.find(([cmd]) => cmd === 'whisper-cpp');
    expect(cppCall).toBeTruthy();
    expect(cppCall[1]).toEqual(expect.arrayContaining(['-m', modelPath]));
    expect(cppCall[1]).toEqual(expect.arrayContaining(['-l', 'en']));

    try { fs.rmSync(media.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(modelDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns clear error when no local transcription engine is available', () => {
    const tmp = writeTempFile('.mp3', 'fake-audio');

    jest.doMock('child_process', () => ({ spawnSync: jest.fn() }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable: jest.fn(() => null),
    }));

    const svc = require('../../src/services/mediaTranscriptionService');
    const res = svc.transcribeMediaFile(tmp.filePath, 'audio/mpeg', {});
    expect(res.success).toBe(false);
    expect(String(res.error || '')).toContain('no local transcription engine available');
    expect(String(res.detail || '')).toContain('whisper=no');
    expect(String(res.detail || '')).toContain('ffmpeg=no');
    expect(String(res.detail || '')).toContain('whisper-cpp=no');

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('caches executable probes to reduce repeated lookup overhead', () => {
    const tmp = writeTempFile('.mp3', 'fake-audio');
    const searchExecutable = jest.fn(() => null);

    jest.doMock('child_process', () => ({ spawnSync: jest.fn() }));
    jest.doMock('../../src/tools/platformUtils', () => ({
      searchExecutable,
    }));

    const svc = require('../../src/services/mediaTranscriptionService');
    const first = svc.transcribeMediaFile(tmp.filePath, 'audio/mpeg', {});
    const second = svc.transcribeMediaFile(tmp.filePath, 'audio/mpeg', {});

    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(searchExecutable).toHaveBeenCalledTimes(3);

    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
