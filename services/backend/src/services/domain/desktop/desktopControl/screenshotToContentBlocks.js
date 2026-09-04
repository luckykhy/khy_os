/**
 * Screenshot to Content Blocks — convert a screenshot PNG file into
 * Anthropic-compatible content block array for vision analysis.
 *
 * Gate env vars:
 *   KHY_VISION_FEEDBACK — '1' (default, enabled) or '0' (disabled)
 *   KHY_VISION_MAX_IMAGE_BYTES — soft threshold (default 524288 / 512 KB) above
 *     which screenshots are downsampled to JPEG before vision analysis.
 *
 * Fail-soft: always returns [] on any error, never throws.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Magic bytes for PNG detection (full 8-byte signature)
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// IHDR chunk type — must be the first chunk after the PNG signature
const IHDR_CHUNK = Buffer.from([0x49, 0x48, 0x44, 0x52]); // 'IHDR'

// Hard ceiling — skip any file larger than 5 MB
const HARD_MAX_BYTES = 5 * 1024 * 1024;

// Downsampling soft threshold — env-configurable (default 512 KB). Files larger
// than this are downsampled to a smaller JPEG before being sent for vision.
const DOWNSAMPLE_TIMEOUT_MS = 5000;
function _downsampleThreshold() {
  const v = Number(process.env.KHY_VISION_MAX_IMAGE_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 524288; // 512 KB
}

// Cache config
const CACHE_MAX_ENTRIES = 5;
const CACHE_TTL_MS = 10_000;

// In-memory cache: filePath -> { blocks, timestamp }
const _cache = new Map();

/**
 * Resolve the managed captures directory for the current platform.
 * Windows: %TEMP%/khy-desktop/captures/ or KHY_SCREENSHOT_DIR
 * Other:   /tmp/khy-desktop/captures/ or KHY_SCREENSHOT_DIR
 * @returns {string} absolute path to the captures directory
 */
function _capturesDir() {
  // Allow override via env var for custom deployment paths
  if (process.env.KHY_SCREENSHOT_DIR) {
    return path.resolve(process.env.KHY_SCREENSHOT_DIR);
  }
  return path.join(os.tmpdir(), 'khy-desktop', 'captures');
}

/**
 * Check whether a resolved file path is a valid screenshot location.
 * Accepts files inside the managed captures directory (where screenshots are
 * written — os.tmpdir()/khy-desktop/captures or KHY_SCREENSHOT_DIR) or any
 * PNG under the user's home directory (os.homedir()).
 *
 * NOTE: the captures dir lives under os.tmpdir(), which on Windows/many setups
 * is a DIFFERENT root than os.homedir() (e.g. TMP=D:\tmp vs home=C:\Users\x).
 * Both roots must be allowed, or real screenshots get rejected and the vision
 * content blocks are never injected into the model.
 * @param {string} resolved - absolute, resolved file path
 * @returns {boolean}
 */
function _isInsideCaptures(resolved) {
  const file = path.resolve(resolved);
  const home = path.resolve(os.homedir());
  const captures = path.resolve(_capturesDir());

  console.log(
    '[screenshotToContentBlocks] _isInsideCaptures: file=%s, home=%s, captures=%s',
    file,
    home,
    captures
  );

  if (process.platform === 'win32') {
    // Windows: case-insensitive
    const fl = file.toLowerCase();
    return fl.startsWith(home.toLowerCase()) || fl.startsWith(captures.toLowerCase());
  }
  // POSIX: case-sensitive
  return file.startsWith(home) || file.startsWith(captures);
}

/**
 * Evict the oldest cache entry when the cache exceeds its limit.
 */
function _evictOldest() {
  if (_cache.size <= CACHE_MAX_ENTRIES) {
    return;
  }
  let oldestKey = null;
  let oldestTs = Infinity;
  for (const [key, entry] of _cache) {
    if (entry.timestamp < oldestTs) {
      oldestTs = entry.timestamp;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) {
    _cache.delete(oldestKey);
  }
}

// ── Downsampling helpers ──────────────────────────────────────────────────────
// When a screenshot exceeds the soft threshold (KHY_VISION_MAX_IMAGE_BYTES),
// attempt to produce a smaller JPEG via platform-native tools. Fail-soft: any
// error or missing tool falls back to the original PNG (no blocking).

function _runExecFile(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err) => {
      if (err) {
        resolve({ ok: false, error: (err && err.message) || String(err) });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

// Windows: PowerShell + System.Drawing — resize to max 1024x768, JPEG quality 75.
function _winDownsampleScript(srcPath, outPath) {
  const s = String(srcPath).replace(/'/g, "''");
  const o = String(outPath).replace(/'/g, "''");
  return [
    'Add-Type -AssemblyName System.Drawing;',
    `$img = [System.Drawing.Image]::FromFile('${s}');`,
    '$maxW = 1024; $maxH = 768;',
    '$w = $img.Width; $h = $img.Height;',
    '$scale = [Math]::Min(1.0, [Math]::Min([double]$maxW / $w, [double]$maxH / $h));',
    '$nw = [int]($w * $scale); $nh = [int]($h * $scale);',
    '$bmp = New-Object System.Drawing.Bitmap $nw, $nh;',
    '$g = [System.Drawing.Graphics]::FromImage($bmp);',
    '$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;',
    '$g.DrawImage($img, 0, 0, $nw, $nh);',
    '$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" };',
    '$ep = New-Object System.Drawing.Imaging.EncoderParameters 1;',
    '$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]75);',
    `$bmp.Save('${o}', $enc, $ep);`,
    '$g.Dispose(); $bmp.Dispose(); $img.Dispose();',
  ].join(' ');
}

/**
 * Attempt to downsample a PNG to a smaller JPEG via platform-native tools.
 * @param {string} filePath - absolute path to the source PNG
 * @returns {Promise<string|null>} path to the compressed JPEG, or null on failure
 */
async function _downsample(filePath) {
  const parsed = path.parse(filePath);
  const outPath = path.join(parsed.dir, `${parsed.name}_compressed.jpg`);
  if (process.platform === 'win32') {
    const script = _winDownsampleScript(filePath, outPath);
    const res = await _runExecFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      DOWNSAMPLE_TIMEOUT_MS
    );
    return res.ok ? outPath : null;
  }
  // POSIX: try ImageMagick `convert`, then macOS `sips`.
  let res = await _runExecFile(
    'convert',
    [filePath, '-resize', '1024x768>', '-quality', '75', outPath],
    DOWNSAMPLE_TIMEOUT_MS
  );
  if (res.ok) {
    return outPath;
  }
  res = await _runExecFile(
    'sips',
    [
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      '75',
      '--resampleHeightWidthMax',
      '1024',
      filePath,
      '--out',
      outPath,
    ],
    DOWNSAMPLE_TIMEOUT_MS
  );
  return res.ok ? outPath : null;
}

/**
 * Check if a model is confirmed non-vision (text-only) via the vision routing
 * truth SSOT. Fail-open: module/SSOT unavailable → returns false (assume capable).
 * @param {string} modelId
 * @returns {boolean}
 */
function _isModelNonVision(modelId) {
  if (!modelId || typeof modelId !== 'string') {
    return false;
  }
  try {
    const { classifyModels } = require('../../../visionRoutingTruth');
    const cls = classifyModels([modelId]);
    // classifyModels returns empty groups when the SSOT is unavailable → fail-open.
    const idLower = modelId.toLowerCase();
    return cls.textOnly.some((e) => e.id.toLowerCase() === idLower);
  } catch {
    return false; // fail-open: module unavailable
  }
}

/**
 * Convert a screenshot PNG file into Anthropic content block array.
 *
 * @param {string} filePath - absolute path to a PNG screenshot
 * @param {object} [options] { modelId } — when provided, non-vision models get text-only blocks
 * @returns {Promise<Array>} array of content blocks, or [] on failure/disabled
 */
async function convertScreenshot(filePath, { modelId } = {}) {
  console.log(
    '[screenshotToContentBlocks] 调用: filePath=%s, KHY_VISION_FEEDBACK=%s',
    filePath,
    process.env.KHY_VISION_FEEDBACK
  );
  try {
    // 1. Gate check
    const gate = process.env.KHY_VISION_FEEDBACK;
    if (gate === '0') {
      console.log('[screenshotToContentBlocks] 门控关闭 (KHY_VISION_FEEDBACK=0)');
      return [];
    }

    // 2. Validate input
    if (!filePath || typeof filePath !== 'string') {
      console.log('[screenshotToContentBlocks] 输入无效: filePath=%s', filePath);
      return [];
    }
    const trimmed = filePath.trim();
    // Reject null bytes — common path injection attack vector
    if (trimmed.includes('\u0000')) {
      console.log('[screenshotToContentBlocks] 包含空字节');
      return [];
    }
    // Only accept PNG screenshots
    if (!trimmed.toLowerCase().endsWith('.png')) {
      console.log('[screenshotToContentBlocks] 非 PNG 文件: %s', trimmed);
      return [];
    }
    const resolved = path.resolve(trimmed);
    console.log('[screenshotToContentBlocks] resolved=%s', resolved);

    // 3. Path safety — must be inside managed captures directory
    if (!_isInsideCaptures(resolved)) {
      console.warn(
        '[screenshotToContentBlocks] 路径不在受管目录内: %s (captures: %s)',
        resolved,
        path.resolve(_capturesDir())
      );
      return [];
    }
    console.log('[screenshotToContentBlocks] 路径校验通过');

    // 3b. Non-vision model fallback — if the caller passed a modelId and the
    // model is confirmed text-only via visionRoutingTruth, return a text-only
    // description block (no image). This check runs before file reading.
    // Fail-open: if visionRoutingTruth cannot be imported, skip this check.
    if (modelId && _isModelNonVision(modelId)) {
      console.log('[screenshotToContentBlocks] 非视觉模型降级: modelId=%s', modelId);
      return [
        {
          type: 'text',
          text: `[截屏已保存: ${resolved}。当前模型不支持视觉分析，请参考上方结构化元素信息操作。]`,
        },
      ];
    }

    // 4. Check cache
    const cached = _cache.get(resolved);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      if (age < CACHE_TTL_MS) {
        console.log('[screenshotToContentBlocks] 缓存命中');
        return cached.blocks;
      }
      // TTL expired — evict stale entry before re-reading
      _cache.delete(resolved);
    }

    // 5. Read file (fail-soft)
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (err) {
      console.warn(
        '[screenshotToContentBlocks] 文件不存在或无法访问: %s (%s)',
        resolved,
        err.message
      );
      return [];
    }
    console.log('[screenshotToContentBlocks] 文件大小: %d bytes', stat.size);

    // 6. Hard ceiling check
    if (stat.size > HARD_MAX_BYTES) {
      console.warn(
        `[screenshotToContentBlocks] 截图文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，已跳过: ${resolved}`
      );
      return [];
    }

    let buf;
    try {
      buf = await fs.readFile(resolved);
    } catch (err) {
      console.warn('[screenshotToContentBlocks] 文件读取失败: %s (%s)', resolved, err.message);
      return [];
    }

    // 7. Verify PNG magic bytes + IHDR header (defense against Polyglot PNG)
    // Valid PNG: 8-byte signature + 4-byte chunk length + 4-byte 'IHDR'
    if (buf.length < 16 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
      console.warn(
        '[screenshotToContentBlocks] PNG magic bytes 校验失败 (buf.length=%d)',
        buf.length
      );
      return [];
    }
    if (!buf.subarray(12, 16).equals(IHDR_CHUNK)) {
      console.warn('[screenshotToContentBlocks] IHDR 校验失败');
      return [];
    }
    console.log('[screenshotToContentBlocks] PNG 校验通过');

    // 7b. Downsampling — if the file exceeds the soft threshold, try to produce
    // a smaller JPEG via platform-native tools. Fail-soft: on any failure or
    // missing tool, fall back to the original PNG.
    let imageData = buf;
    let imageMediaType = 'image/png';
    const threshold = _downsampleThreshold();
    if (stat.size > threshold) {
      let compressedPath = null;
      try {
        compressedPath = await _downsample(resolved);
        if (compressedPath) {
          const compressedBuf = await fs.readFile(compressedPath);
          if (compressedBuf.length > 0 && compressedBuf.length < buf.length) {
            imageData = compressedBuf;
            imageMediaType = 'image/jpeg';
            console.log(
              '[screenshotToContentBlocks] 降采样成功: %d → %d bytes (jpeg)',
              buf.length,
              compressedBuf.length
            );
          }
        } else {
          console.log('[screenshotToContentBlocks] 降采样工具不可用，使用原图');
        }
      } catch (err) {
        console.warn('[screenshotToContentBlocks] 降采样异常: %s', err.message);
      } finally {
        if (compressedPath) {
          try {
            await fs.unlink(compressedPath);
          } catch {
            /* ignore cleanup errors */
          }
        }
      }
    }

    // 8. Build content blocks
    const base64Data = imageData.toString('base64');
    const blocks = [
      {
        type: 'text',
        text: '[截屏结果 — 请仔细观察下方图片，向用户描述你在屏幕上看到了什么：窗口、按钮、文字、布局等]',
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageMediaType,
          data: base64Data,
        },
      },
    ];
    console.log(
      '[screenshotToContentBlocks] 成功生成内容块: %d blocks, media_type=%s, base64 length=%d',
      blocks.length,
      imageMediaType,
      base64Data.length
    );

    // 9. Update cache
    _cache.set(resolved, { blocks, timestamp: Date.now() });
    _evictOldest();

    return blocks;
  } catch (err) {
    // Fail-soft: any unexpected error returns empty
    console.warn('[screenshotToContentBlocks] 异常: %s', err.message);
    return [];
  }
}

/**
 * Return cache statistics for diagnostics.
 * @returns {{ size: number, max: number, ttlMs: number, entries: Array<{ key: string, ageMs: number }> }}
 */
function getCacheInfo() {
  const now = Date.now();
  const entries = [];
  for (const [key, val] of _cache) {
    entries.push({ key, ageMs: now - val.timestamp });
  }
  // Sort newest first
  entries.sort((a, b) => a.ageMs - b.ageMs);
  return {
    size: _cache.size,
    max: CACHE_MAX_ENTRIES,
    ttlMs: CACHE_TTL_MS,
    entries,
  };
}

/** Alias for getCacheInfo — used by DesktopControlTool status reporting. */
const getCacheStats = getCacheInfo;

module.exports = { convertScreenshot, getCacheInfo, getCacheStats };
