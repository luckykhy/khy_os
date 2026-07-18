/**
 * videoAnalyze — video content analysis tool for the CLI agent.
 *
 * Capability: "视频分析" (video analysis). Extracts keyframes from a video with
 * ffmpeg, sends the frame batch to a vision-capable LLM, and returns a
 * scene-by-scene analysis plus an overall summary. No external video-analysis
 * API is used — it reuses the existing imageService/aiGateway vision pipeline.
 *
 * Pipeline:
 *   1. detect ffmpeg/ffprobe (searchExecutable) — degrade transparently if absent
 *   2. ffprobe → duration + resolution metadata
 *   3. ffmpeg → extract N evenly-spaced frames to the session temp dir as jpg
 *   4. base64-encode frames → aiGateway.generate(prompt, { images: [...] }) — one
 *      multi-image call; the gateway supports arbitrary-length image arrays
 *   5. clean up extracted frames
 *
 * Zero-hardcoding rule: no model is hardcoded (aiGateway routes to a vision
 * adapter); frame count is bounded and configurable; ffmpeg path comes from
 * PATH. State transparency: meta reports duration, frames extracted, model.
 */

const { defineTool } = require('./_baseTool');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500 MB hard cap
const DEFAULT_FRAMES = 6;
const MAX_FRAMES = 16;

const SUPPORTED_FORMATS = new Set([
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.flv', '.wmv', '.mpeg', '.mpg',
]);

// ─── ffmpeg / ffprobe detection (cached) ─────────────────────────────────────

let _ffmpegPath = undefined;
let _ffprobePath = undefined;

function _resolveFfmpeg() {
  if (_ffmpegPath !== undefined) return _ffmpegPath;
  const { searchExecutable } = require('./platformUtils');
  _ffmpegPath = searchExecutable('ffmpeg') || null;
  return _ffmpegPath;
}

function _resolveFfprobe() {
  if (_ffprobePath !== undefined) return _ffprobePath;
  const { searchExecutable } = require('./platformUtils');
  _ffprobePath = searchExecutable('ffprobe') || null;
  return _ffprobePath;
}

function _resolvePath(rawPath, cwd) {
  let p = String(rawPath || '');
  if (process.platform === 'win32') {
    p = p.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
  } else {
    p = p.replace(/\$\{?(\w+)\}?/g, (_, key) => process.env[key] || '');
  }
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

// ─── ffprobe: duration + resolution ──────────────────────────────────────────

async function _probeVideo(ffprobePath, videoPath, spawnWithIdleTimeout) {
  // Output JSON with format (duration) and the first video stream (w/h).
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=width,height',
    '-of', 'json',
    videoPath,
  ];
  try {
    const result = await spawnWithIdleTimeout(ffprobePath, args, {
      idleMs: 30000,
      label: 'videoAnalyze:ffprobe',
    });
    const parsed = JSON.parse(result.stdout || '{}');
    const duration = parseFloat((parsed.format && parsed.format.duration) || '0') || 0;
    const stream = (parsed.streams && parsed.streams[0]) || {};
    return { duration, width: stream.width || 0, height: stream.height || 0 };
  } catch {
    return { duration: 0, width: 0, height: 0 };
  }
}

// ─── ffmpeg: extract N evenly-spaced frames ──────────────────────────────────

/**
 * Extract `count` frames evenly spaced across the video into outDir as jpg.
 * Uses the fps filter when duration is known (deterministic spacing); otherwise
 * falls back to keyframe extraction.
 * @returns {Promise<string[]>} sorted list of extracted frame file paths
 */
async function _extractFrames(ffmpegPath, videoPath, outDir, count, duration, spawnWithIdleTimeout) {
  fs.mkdirSync(outDir, { recursive: true });
  const pattern = path.join(outDir, 'frame_%04d.jpg');

  let vfArg;
  if (duration > 0) {
    // Evenly spaced: select count frames across the whole duration.
    // fps = count / duration → one frame every (duration/count) seconds.
    const fps = Math.max(0.01, count / duration);
    vfArg = `fps=${fps.toFixed(4)}`;
  } else {
    // Unknown duration: pull keyframes, capped by -frames:v below.
    vfArg = "select='eq(pict_type\\,I)'";
  }

  const args = [
    '-y',
    '-i', videoPath,
    '-vf', vfArg,
    '-frames:v', String(count),
    '-vsync', 'vfr',
    '-q:v', '3',
    pattern,
  ];

  await spawnWithIdleTimeout(ffmpegPath, args, {
    idleMs: 60000,
    label: 'videoAnalyze:ffmpeg',
  });

  let files = [];
  try {
    files = fs.readdirSync(outDir)
      .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(outDir, f));
  } catch {
    files = [];
  }
  return files;
}

function _cleanupFrames(files, outDir) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* best-effort */ }
  }
  try { fs.rmdirSync(outDir); } catch { /* best-effort, non-empty dirs ignored */ }
}

function _buildPrompt(frameCount, duration, query) {
  const durText = duration > 0 ? `${duration.toFixed(1)}s long` : 'of unknown length';
  const base =
    `These are ${frameCount} keyframes sampled in chronological order from a video ${durText}. `
    + 'Analyze them as a sequence. Provide:\n'
    + '1. A scene-by-scene breakdown (what each frame shows, in order).\n'
    + '2. The overall subject/activity of the video.\n'
    + '3. Notable changes or events across the timeline.\n'
    + 'Be factual; describe only what is visible. Do not invent audio or unseen content.';
  if (query && query.trim()) {
    return `${base}\n\nAdditionally focus on: "${query.trim()}". Answer it using only what is visible.`;
  }
  return base;
}

// ─── Tool Definition ─────────────────────────────────────────────────────────

module.exports = defineTool({
  name: 'video_analyze',
  description:
    'Analyze a video file by extracting keyframes and sending them to a vision-capable model. '
    + 'Returns a scene-by-scene breakdown, the overall subject, and notable timeline changes. '
    + 'Requires ffmpeg in PATH. Optionally pass a query to focus the analysis.',
  category: 'analysis',
  risk: 'low',
  isReadOnly: true,
  isConcurrencySafe: true,
  searchHint: 'video analysis analyze frames keyframe scene',
  aliases: ['videoAnalyze', 'analyze_video', 'video_analysis', '视频分析', '视频识别', '分析视频'],

  isEnabled() {
    // Enabled only when ffmpeg is available; otherwise the tool is hidden from
    // the model rather than failing mid-call.
    return !!_resolveFfmpeg();
  },

  inputSchema: {
    videoPath: {
      type: 'string',
      required: true,
      maxLength: 4096,
      description: 'Path to the video file (.mp4/.mov/.webm/.mkv/.avi/...).',
    },
    frames: {
      type: 'number',
      min: 1,
      max: MAX_FRAMES,
      default: DEFAULT_FRAMES,
      description: `Number of keyframes to sample (1-${MAX_FRAMES}, default ${DEFAULT_FRAMES}).`,
    },
    query: {
      type: 'string',
      maxLength: 500,
      description: 'Optional specific question to focus the analysis (e.g. "when does the car appear?").',
    },
  },

  async validateInput(input) {
    const { validateNotDevicePath, validateNotUNCPath, composeValidations } = require('./inputValidators');
    return composeValidations(
      validateNotDevicePath(input.videoPath),
      validateNotUNCPath(input.videoPath),
    );
  },

  getActivityDescription(input) {
    const name = input && input.videoPath ? path.basename(String(input.videoPath)) : 'video';
    return `视频分析：${name}`;
  },

  async execute(params, _context) {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    const videoPath = _resolvePath(params && params.videoPath, cwd);
    const query = params && params.query ? String(params.query) : '';
    const frameCount = (params && Number.isFinite(params.frames))
      ? Math.min(MAX_FRAMES, Math.max(1, Math.floor(params.frames)))
      : DEFAULT_FRAMES;

    // ── ffmpeg gate ──────────────────────────────────────────────────────────
    const ffmpegPath = _resolveFfmpeg();
    if (!ffmpegPath) {
      const error = 'ffmpeg not found in PATH. Install ffmpeg to enable video analysis.';
      return { success: false, status: 'ffmpeg_unavailable', error, content: error, meta: { ffmpegAvailable: false } };
    }

    // ── Validation ───────────────────────────────────────────────────────────
    if (!fs.existsSync(videoPath)) {
      const error = `Video not found: ${videoPath}`;
      return { success: false, error, content: error, meta: { ffmpegAvailable: true } };
    }
    const ext = path.extname(videoPath).toLowerCase();
    if (!SUPPORTED_FORMATS.has(ext)) {
      const error = `Unsupported video format: ${ext}. Supported: ${[...SUPPORTED_FORMATS].join(', ')}`;
      return { success: false, error, content: error, meta: { ffmpegAvailable: true } };
    }
    const stat = fs.statSync(videoPath);
    if (stat.size > MAX_VIDEO_SIZE) {
      const error = `Video too large: ${(stat.size / 1024 / 1024).toFixed(0)}MB (max ${MAX_VIDEO_SIZE / 1024 / 1024}MB)`;
      return { success: false, error, content: error, meta: { ffmpegAvailable: true } };
    }

    const { spawnWithIdleTimeout } = require('../utils/spawnWithIdleTimeout');
    const { ensureSessionTmpDir } = require('./platformUtils');

    // ── Probe metadata (best-effort) ─────────────────────────────────────────
    const ffprobePath = _resolveFfprobe();
    const probe = ffprobePath
      ? await _probeVideo(ffprobePath, videoPath, spawnWithIdleTimeout)
      : { duration: 0, width: 0, height: 0 };

    // ── Extract frames ───────────────────────────────────────────────────────
    const sessionDir = ensureSessionTmpDir();
    const outDir = path.join(sessionDir, `video-frames-${path.basename(videoPath, ext)}-${stat.size}`);
    let frameFiles = [];
    try {
      frameFiles = await _extractFrames(ffmpegPath, videoPath, outDir, frameCount, probe.duration, spawnWithIdleTimeout);
    } catch (err) {
      _cleanupFrames(frameFiles, outDir);
      const error = `Frame extraction failed: ${err.message}`;
      return { success: false, error, content: error, meta: { ffmpegAvailable: true, duration: probe.duration } };
    }

    if (frameFiles.length === 0) {
      _cleanupFrames(frameFiles, outDir);
      const error = 'No frames could be extracted from the video.';
      return { success: false, error, content: error, meta: { ffmpegAvailable: true, duration: probe.duration } };
    }

    // ── Base64-encode frames ─────────────────────────────────────────────────
    const images = [];
    for (const f of frameFiles) {
      try {
        images.push({ base64: fs.readFileSync(f).toString('base64'), mimeType: 'image/jpeg' });
      } catch { /* skip unreadable frame */ }
    }

    if (images.length === 0) {
      _cleanupFrames(frameFiles, outDir);
      const error = 'Extracted frames could not be read.';
      return { success: false, error, content: error, meta: { ffmpegAvailable: true } };
    }

    // ── Vision model call (single multi-image request) ───────────────────────
    let result;
    try {
      const gateway = require('../services/gateway/aiGateway');
      result = await gateway.generate(_buildPrompt(images.length, probe.duration, query), {
        images,
        maxTokens: 3072,
        temperature: 0.2,
      });
    } catch (err) {
      _cleanupFrames(frameFiles, outDir);
      const error = `Vision model error: ${err.message}`;
      return { success: false, error, content: error, meta: { ffmpegAvailable: true, framesExtracted: images.length } };
    }

    // ── Cleanup always ───────────────────────────────────────────────────────
    _cleanupFrames(frameFiles, outDir);

    if (!result || !result.success) {
      const error = `Video analysis failed: ${(result && result.content) || 'no vision-capable model available'}.`;
      return {
        success: false,
        error,
        content: `${error} Ensure a vision-capable adapter (Claude/Qwen-VL/Codex) is configured.`,
        meta: { ffmpegAvailable: true, framesExtracted: images.length, model: (result && (result.model || result.provider)) || null },
      };
    }

    const header = `Video analysis: ${path.basename(videoPath)} — ${images.length} keyframes${probe.duration > 0 ? `, ${probe.duration.toFixed(1)}s` : ''}${probe.width ? `, ${probe.width}x${probe.height}` : ''}.`;
    return {
      success: true,
      content: `${header}\n\n${result.content}`,
      meta: {
        ffmpegAvailable: true,
        duration: probe.duration,
        resolution: probe.width ? `${probe.width}x${probe.height}` : null,
        framesExtracted: images.length,
        model: result.model || result.provider || null,
        provider: result.provider || null,
        query: query || undefined,
      },
    };
  },
});
