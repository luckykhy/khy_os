'use strict';

/**
 * mediaTranscriptionService.js
 *
 * Lightweight local transcription helper for audio/video files:
 * - Uses `whisper` CLI when available
 * - Falls back to `whisper-cpp`
 * - Uses `ffmpeg` to extract audio from video (or normalize audio)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
const { searchExecutable } = require('../tools/platformUtils');

const MAX_BYTES = Math.max(
  5 * 1024 * 1024,
  parseInt(String(process.env.KHY_MULTIMODAL_TRANSCRIBE_MAX_BYTES || String(80 * 1024 * 1024)), 10) || (80 * 1024 * 1024)
);
const DEFAULT_TIMEOUT_MS = Math.max(
  15000,
  parseInt(String(process.env.KHY_MULTIMODAL_TRANSCRIBE_TIMEOUT_MS || '120000'), 10) || 120000
);
const TRANSCRIPT_READ_MAX_BYTES = Math.max(
  16 * 1024,
  parseInt(String(process.env.KHY_MULTIMODAL_TRANSCRIBE_READ_MAX_BYTES || String(2 * 1024 * 1024)), 10) || (2 * 1024 * 1024)
);
const BIN_CACHE_TTL_MS = Math.max(
  2000,
  parseInt(String(process.env.KHY_MULTIMODAL_BIN_CACHE_TTL_MS || '30000'), 10) || 30000
);

const _binAvailabilityCache = new Map();

function _exists(bin) {
  const key = String(bin || '').trim();
  if (!key) return false;
  const now = Date.now();
  const cached = _binAvailabilityCache.get(key);
  if (cached && (now - cached.at) < BIN_CACHE_TTL_MS) {
    return !!cached.ok;
  }
  const ok = !!searchExecutable(key);
  _binAvailabilityCache.set(key, { ok, at: now });
  return ok;
}

function _extKind(filePath = '', mimeType = '') {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'].includes(ext)) return 'audio';
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi'].includes(ext)) return 'video';
  return 'unknown';
}

function _run(cmd, args = [], options = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf-8',
    timeout: Math.max(5000, parseInt(String(options.timeoutMs || DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS),
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function _runAsync(cmd, args = [], options = {}) {
  const timeoutMs = Math.max(
    5000,
    parseInt(String(options.timeoutMs || DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS
  );
  const maxBuffer = Math.max(
    1024 * 1024,
    parseInt(String(options.maxBuffer || 16 * 1024 * 1024), 10) || (16 * 1024 * 1024)
  );
  return new Promise((resolve) => {
    let child = null;
    let done = false;
    let stdout = '';
    let stderr = '';
    let timer = null;

    const finish = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(payload || { status: 1, stdout, stderr });
    };

    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
      });
    } catch (error) {
      finish({
        status: 1,
        error,
        stdout,
        stderr: String(error?.message || error || 'spawn failed'),
      });
      return;
    }

    const pushChunk = (target, chunk) => {
      if (!chunk) return target;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
      let out = `${target}${text}`;
      if (out.length > maxBuffer) {
        out = out.slice(out.length - maxBuffer);
      }
      return out;
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout = pushChunk(stdout, chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr = pushChunk(stderr, chunk);
      });
    }

    child.on('error', (error) => {
      finish({
        status: 1,
        error,
        stdout,
        stderr: stderr || String(error?.message || error || 'spawn error'),
      });
    });

    child.on('close', (code, signal) => {
      finish({
        status: Number.isInteger(code) ? code : 1,
        signal: signal || '',
        stdout,
        stderr,
      });
    });

    timer = setTimeout(() => {
      try {
        safeKill(child, 'SIGKILL', 0);
      } catch { /* ignore */ }
      finish({
        status: 124,
        stdout,
        stderr: stderr || `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

// 收敛到 utils/safeStatSync 单一真源(逐字节委托,调用点不变)
const _safeStat = require('../utils/safeStatSync');

function _safeIsFile(filePath = '') {
  const stat = _safeStat(filePath);
  return !!(stat && stat.isFile());
}

function _isPathLike(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/[\\/]/.test(raw)) return true;
  return /\.(bin|gguf|pt|model)$/i.test(raw);
}

function _resolveWhisperCppModel() {
  const raw = String(
    process.env.KHY_MULTIMODAL_TRANSCRIBE_CPP_MODEL
    || process.env.KHY_MULTIMODAL_TRANSCRIBE_CPP_MODEL_PATH
    || 'base'
  ).trim() || 'base';

  if (_isPathLike(raw)) {
    const resolved = path.resolve(raw);
    if (_safeIsFile(resolved)) return resolved;
    return raw;
  }

  const alias = raw.toLowerCase();
  const candidateNames = [
    raw,
    `${raw}.bin`,
    `ggml-${alias}.bin`,
    `ggml-${alias}.en.bin`,
  ];
  const candidateDirs = [
    process.env.KHY_MULTIMODAL_TRANSCRIBE_CPP_MODEL_DIR,
    process.env.WHISPER_CPP_MODEL_DIR,
    path.join(process.cwd(), 'models'),
    path.join(process.cwd(), 'backend', 'models'),
    path.join(os.homedir(), '.cache', 'whisper'),
    path.join(os.homedir(), '.cache', 'whisper.cpp'),
  ]
    .map(x => String(x || '').trim())
    .filter(Boolean);

  const seen = new Set();
  for (const dir of candidateDirs) {
    for (const name of candidateNames) {
      const candidate = path.resolve(dir, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (_safeIsFile(candidate)) return candidate;
    }
  }

  // Keep alias fallback for wrappers that accept symbolic model names.
  return raw;
}

function _buildWhisperTranscriptCandidates(inputPath = '') {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  const exact = path.join(dir, `${base}.txt`);
  const out = [exact];
  try {
    const files = fs.readdirSync(dir);
    const prefix = `${base}.`;
    for (const name of files) {
      if (!name || name === `${base}.txt`) continue;
      if (!name.startsWith(prefix) || !name.endsWith('.txt')) continue;
      out.push(path.join(dir, name));
    }
  } catch { /* ignore */ }
  return out;
}

function _readWhisperTxt(inputPath = '') {
  const candidates = _buildWhisperTranscriptCandidates(inputPath);
  for (const txt of candidates) {
    if (!_safeIsFile(txt)) continue;
    const stat = _safeStat(txt);
    if (!stat || stat.size <= 0 || stat.size > TRANSCRIPT_READ_MAX_BYTES) continue;
    try {
      const content = String(fs.readFileSync(txt, 'utf-8') || '').trim();
      try { fs.unlinkSync(txt); } catch { /* ignore */ }
      if (content) return content;
    } catch { /* ignore */ }
  }
  return '';
}

function _collectEngineAvailability() {
  const hasWhisper = _exists('whisper');
  const hasFfmpeg = _exists('ffmpeg');
  const hasWhisperCpp = _exists('whisper-cpp');
  return {
    hasWhisper,
    hasFfmpeg,
    hasWhisperCpp,
    hasFallback: hasFfmpeg && hasWhisperCpp,
  };
}

function _composeFailureSummary(segments = []) {
  const lines = [];
  for (const item of segments) {
    if (!item || typeof item !== 'object') continue;
    const label = String(item.label || '').trim();
    const message = String(item.message || '').trim();
    if (!label || !message) continue;
    lines.push(`${label}: ${message}`);
  }
  return lines.join(' | ');
}

function _transcribeWithWhisper(inputPath = '', language = 'auto', timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!_exists('whisper')) return { success: false, error: 'whisper not installed', engine: 'whisper' };
  const model = String(process.env.KHY_MULTIMODAL_TRANSCRIBE_WHISPER_MODEL || 'base').trim() || 'base';
  const args = [
    inputPath,
    '--model', model,
    '--output_format', 'txt',
    '--output_dir', path.dirname(inputPath),
  ];
  const lang = String(language || 'auto').trim().toLowerCase();
  if (lang && lang !== 'auto') {
    args.push('--language', lang);
  }
  const result = _run('whisper', args, { timeoutMs });
  if (result.status !== 0) {
    return {
      success: false,
      error: String(result.stderr || result.stdout || `whisper exited ${result.status}`).trim(),
      engine: 'whisper',
    };
  }
  const text = _readWhisperTxt(inputPath);
  if (!text) {
    return { success: false, error: 'whisper produced empty transcript', engine: 'whisper' };
  }
  return { success: true, text, engine: 'whisper' };
}

async function _transcribeWithWhisperAsync(inputPath = '', language = 'auto', timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!_exists('whisper')) return { success: false, error: 'whisper not installed', engine: 'whisper' };
  const model = String(process.env.KHY_MULTIMODAL_TRANSCRIBE_WHISPER_MODEL || 'base').trim() || 'base';
  const args = [
    inputPath,
    '--model', model,
    '--output_format', 'txt',
    '--output_dir', path.dirname(inputPath),
  ];
  const lang = String(language || 'auto').trim().toLowerCase();
  if (lang && lang !== 'auto') args.push('--language', lang);
  const result = await _runAsync('whisper', args, { timeoutMs });
  if (result.status !== 0) {
    return {
      success: false,
      error: String(result.stderr || result.stdout || `whisper exited ${result.status}`).trim(),
      engine: 'whisper',
    };
  }
  const text = _readWhisperTxt(inputPath);
  if (!text) {
    return { success: false, error: 'whisper produced empty transcript', engine: 'whisper' };
  }
  return { success: true, text, engine: 'whisper' };
}

function _transcribeWithWhisperCpp(wavPath = '', language = 'auto', timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!_exists('whisper-cpp')) return { success: false, error: 'whisper-cpp not installed', engine: 'whisper-cpp' };
  const model = _resolveWhisperCppModel();
  const args = ['-m', model, '-f', wavPath];
  const lang = String(language || 'auto').trim().toLowerCase();
  if (lang && lang !== 'auto') {
    args.push('-l', lang);
  }
  const result = _run('whisper-cpp', args, { timeoutMs });
  if (result.status !== 0) {
    return {
      success: false,
      error: String(result.stderr || result.stdout || `whisper-cpp exited ${result.status}`).trim(),
      engine: 'whisper-cpp',
    };
  }
  const text = String(result.stdout || '').trim();
  if (!text) {
    return { success: false, error: 'whisper-cpp produced empty transcript', engine: 'whisper-cpp' };
  }
  return { success: true, text, engine: 'whisper-cpp' };
}

async function _transcribeWithWhisperCppAsync(wavPath = '', language = 'auto', timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!_exists('whisper-cpp')) return { success: false, error: 'whisper-cpp not installed', engine: 'whisper-cpp' };
  const model = _resolveWhisperCppModel();
  const args = ['-m', model, '-f', wavPath];
  const lang = String(language || 'auto').trim().toLowerCase();
  if (lang && lang !== 'auto') args.push('-l', lang);
  const result = await _runAsync('whisper-cpp', args, { timeoutMs });
  if (result.status !== 0) {
    return {
      success: false,
      error: String(result.stderr || result.stdout || `whisper-cpp exited ${result.status}`).trim(),
      engine: 'whisper-cpp',
    };
  }
  const text = String(result.stdout || '').trim();
  if (!text) {
    return { success: false, error: 'whisper-cpp produced empty transcript', engine: 'whisper-cpp' };
  }
  return { success: true, text, engine: 'whisper-cpp' };
}

function _extractAudioToWav(inputPath = '', wavPath = '', timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!_exists('ffmpeg')) return { success: false, error: 'ffmpeg not installed' };
  const args = [
    '-y',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    wavPath,
  ];
  const result = _run('ffmpeg', args, { timeoutMs });
  if (result.status !== 0 || !fs.existsSync(wavPath)) {
    return {
      success: false,
      error: String(result.stderr || result.stdout || `ffmpeg exited ${result.status}`).trim(),
    };
  }
  return { success: true };
}

async function _extractAudioToWavAsync(inputPath = '', wavPath = '', timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!_exists('ffmpeg')) return { success: false, error: 'ffmpeg not installed' };
  const args = [
    '-y',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'wav',
    wavPath,
  ];
  const result = await _runAsync('ffmpeg', args, { timeoutMs });
  if (result.status !== 0 || !fs.existsSync(wavPath)) {
    return {
      success: false,
      error: String(result.stderr || result.stdout || `ffmpeg exited ${result.status}`).trim(),
    };
  }
  return { success: true };
}

function transcribeMediaFile(filePath = '', mimeType = '', options = {}) {
  const resolved = path.resolve(String(filePath || '').trim());
  if (!resolved || !fs.existsSync(resolved)) {
    return { success: false, error: `file not found: ${resolved || filePath}` };
  }
  let stat = null;
  try { stat = fs.statSync(resolved); } catch { /* ignore */ }
  if (!stat || !stat.isFile()) {
    return { success: false, error: 'input is not a file' };
  }
  if (stat.size <= 0) return { success: false, error: 'empty file' };
  if (stat.size > MAX_BYTES) {
    return { success: false, error: `file too large (${Math.round(stat.size / 1024 / 1024)}MB)` };
  }

  const kind = _extKind(resolved, mimeType);
  if (kind !== 'audio' && kind !== 'video') {
    return { success: false, error: `unsupported media kind: ${kind}` };
  }

  const timeoutMs = Math.max(
    5000,
    parseInt(String(options.timeoutMs || DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS
  );
  const language = String(options.language || 'auto').trim();
  const availability = _collectEngineAvailability();

  if (!availability.hasWhisper && !availability.hasFallback) {
    return {
      success: false,
      error: 'no local transcription engine available (requires whisper or ffmpeg + whisper-cpp)',
      detail: `whisper=${availability.hasWhisper ? 'yes' : 'no'}, ffmpeg=${availability.hasFfmpeg ? 'yes' : 'no'}, whisper-cpp=${availability.hasWhisperCpp ? 'yes' : 'no'}`,
      engine: 'none',
    };
  }

  // Fast path: whisper can handle many formats directly.
  const direct = availability.hasWhisper
    ? _transcribeWithWhisper(resolved, language, timeoutMs)
    : { success: false, error: 'whisper not installed', engine: 'whisper' };
  if (direct.success) return direct;
  if (!availability.hasFallback) {
    return {
      success: false,
      error: direct.error || 'transcription failed',
      engine: direct.engine || 'whisper',
    };
  }

  // Fallback path: normalize audio with ffmpeg, then whisper-cpp.
  const tmpDir = path.join(os.tmpdir(), 'khy-mm-transcribe');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  const wavPath = path.join(
    tmpDir,
    `${path.basename(resolved, path.extname(resolved))}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.wav`
  );

  const extracted = _extractAudioToWav(resolved, wavPath, timeoutMs);
  if (!extracted.success) {
    const merged = _composeFailureSummary([
      { label: 'whisper', message: direct.error || '' },
      { label: 'ffmpeg', message: extracted.error || '' },
    ]);
    return {
      success: false,
      error: merged || direct.error || extracted.error || 'transcription failed',
      fallbackError: extracted.error || '',
      engine: direct.engine || 'unknown',
    };
  }

  try {
    const cpp = _transcribeWithWhisperCpp(wavPath, language, timeoutMs);
    if (cpp.success) return cpp;
    const merged = _composeFailureSummary([
      { label: 'whisper', message: direct.error || '' },
      { label: 'whisper-cpp', message: cpp.error || '' },
    ]);
    return {
      success: false,
      error: merged || direct.error || cpp.error || 'transcription failed',
      fallbackError: cpp.error || '',
      engine: direct.engine || cpp.engine || 'unknown',
    };
  } finally {
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }
}

async function transcribeMediaFileAsync(filePath = '', mimeType = '', options = {}) {
  const resolved = path.resolve(String(filePath || '').trim());
  if (!resolved || !fs.existsSync(resolved)) {
    return { success: false, error: `file not found: ${resolved || filePath}` };
  }
  let stat = null;
  try { stat = fs.statSync(resolved); } catch { /* ignore */ }
  if (!stat || !stat.isFile()) return { success: false, error: 'input is not a file' };
  if (stat.size <= 0) return { success: false, error: 'empty file' };
  if (stat.size > MAX_BYTES) {
    return { success: false, error: `file too large (${Math.round(stat.size / 1024 / 1024)}MB)` };
  }

  const kind = _extKind(resolved, mimeType);
  if (kind !== 'audio' && kind !== 'video') {
    return { success: false, error: `unsupported media kind: ${kind}` };
  }

  const timeoutMs = Math.max(
    5000,
    parseInt(String(options.timeoutMs || DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS
  );
  const language = String(options.language || 'auto').trim();
  const availability = _collectEngineAvailability();

  if (!availability.hasWhisper && !availability.hasFallback) {
    return {
      success: false,
      error: 'no local transcription engine available (requires whisper or ffmpeg + whisper-cpp)',
      detail: `whisper=${availability.hasWhisper ? 'yes' : 'no'}, ffmpeg=${availability.hasFfmpeg ? 'yes' : 'no'}, whisper-cpp=${availability.hasWhisperCpp ? 'yes' : 'no'}`,
      engine: 'none',
    };
  }

  const direct = availability.hasWhisper
    ? await _transcribeWithWhisperAsync(resolved, language, timeoutMs)
    : { success: false, error: 'whisper not installed', engine: 'whisper' };
  if (direct.success) return direct;
  if (!availability.hasFallback) {
    return {
      success: false,
      error: direct.error || 'transcription failed',
      engine: direct.engine || 'whisper',
    };
  }

  const tmpDir = path.join(os.tmpdir(), 'khy-mm-transcribe');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  const wavPath = path.join(
    tmpDir,
    `${path.basename(resolved, path.extname(resolved))}_${Date.now()}_${Math.floor(Math.random() * 1e6)}.wav`
  );

  const extracted = await _extractAudioToWavAsync(resolved, wavPath, timeoutMs);
  if (!extracted.success) {
    const merged = _composeFailureSummary([
      { label: 'whisper', message: direct.error || '' },
      { label: 'ffmpeg', message: extracted.error || '' },
    ]);
    return {
      success: false,
      error: merged || direct.error || extracted.error || 'transcription failed',
      fallbackError: extracted.error || '',
      engine: direct.engine || 'unknown',
    };
  }

  try {
    const cpp = await _transcribeWithWhisperCppAsync(wavPath, language, timeoutMs);
    if (cpp.success) return cpp;
    const merged = _composeFailureSummary([
      { label: 'whisper', message: direct.error || '' },
      { label: 'whisper-cpp', message: cpp.error || '' },
    ]);
    return {
      success: false,
      error: merged || direct.error || cpp.error || 'transcription failed',
      fallbackError: cpp.error || '',
      engine: direct.engine || cpp.engine || 'unknown',
    };
  } finally {
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }
}

module.exports = {
  transcribeMediaFile,
  transcribeMediaFileAsync,
};
