/**
 * Image Service — handle image input for AI vision analysis.
 *
 * Supports:
 *   - File path input: read PNG/JPEG/GIF/WebP from disk
 *   - Clipboard paste: platform-specific clipboard image capture
 *   - Terminal preview: iTerm2/Kitty inline protocol, fallback to text
 *   - Base64 encoding for AI provider APIs
 *
 * No npm dependencies — uses child_process + Buffer only.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// PowerShell binary candidates sourced from the platform-detail SSOT.
const { POWERSHELL_BINS } = require('../tools/platformUtils');

// Magic bytes for image format detection
const MAGIC_BYTES = {
  png:  Buffer.from([0x89, 0x50, 0x4E, 0x47]),
  jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
  gif:  Buffer.from([0x47, 0x49, 0x46]),
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF header
};

const MIME_MAP = {
  png:  'image/png',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
};

// Max image size (5MB — larger images should be resized)
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Detect image format from buffer magic bytes.
 * @param {Buffer} buf
 * @returns {'png'|'jpeg'|'gif'|'webp'|null}
 */
function detectFormat(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.subarray(0, 4).equals(MAGIC_BYTES.png)) return 'png';
  if (buf.subarray(0, 3).equals(MAGIC_BYTES.jpeg)) return 'jpeg';
  if (buf.subarray(0, 3).equals(MAGIC_BYTES.gif)) return 'gif';
  if (buf.subarray(0, 4).equals(MAGIC_BYTES.webp)) return 'webp';
  return null;
}

/**
 * Read an image from a file path.
 * @param {string} filePath - absolute or relative path to image file
 * @returns {{ base64: string, mimeType: string, sizeBytes: number, format: string }}
 * @throws {Error} if file doesn't exist, isn't an image, or is too large
 */
function readImageFromFile(filePath) {
  let normalized = String(filePath || '').trim();
  if (!normalized) {
    throw new Error('Image path is empty');
  }

  // Accept quoted paths from clipboard tools (e.g. "C:\Users\A B\...\img.png").
  if ((normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith('\'') && normalized.endsWith('\''))) {
    normalized = normalized.slice(1, -1).trim();
  }

  // Accept file:// URIs from terminal paste/drag-and-drop.
  // Examples:
  //   file:///home/user/a.png
  //   file://localhost/home/user/a.png
  if (/^file:\/\//i.test(normalized)) {
    try {
      const u = new URL(normalized);
      normalized = decodeURIComponent(u.pathname || '');
      if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(normalized)) {
        normalized = normalized.slice(1);
      }
    } catch {
      normalized = normalized.replace(/^file:\/\/(?:localhost)?/i, '');
      try { normalized = decodeURIComponent(normalized); } catch { /* ignore */ }
    }
  }

  const resolved = path.resolve(normalized);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
  }

  const buf = fs.readFileSync(resolved);
  const format = detectFormat(buf);
  if (!format) {
    throw new Error(`Not a recognized image format. Supported: PNG, JPEG, GIF, WebP`);
  }

  return {
    base64: buf.toString('base64'),
    mimeType: MIME_MAP[format],
    sizeBytes: stat.size,
    format,
  };
}

/**
 * Read an image from the system clipboard.
 * Platform-specific implementation.
 * @returns {{ base64: string, mimeType: string, sizeBytes: number, format: string }}
 * @throws {Error} if clipboard doesn't contain an image or tools aren't available
 */
function readImageFromClipboard() {
  const platform = os.platform();

  if (platform === 'linux') {
    return _readClipboardLinux();
  } else if (platform === 'darwin') {
    return _readClipboardMac();
  } else if (platform === 'win32') {
    return _readClipboardWindows();
  } else {
    throw new Error(`Clipboard image not supported on ${platform}`);
  }
}

function _readClipboardLinux() {
  // Try xclip first, then xsel
  try {
    const buf = execSync('xclip -selection clipboard -t image/png -o', {
      maxBuffer: MAX_IMAGE_BYTES,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (buf.length > 0) {
      const format = detectFormat(buf) || 'png';
      return {
        base64: buf.toString('base64'),
        mimeType: MIME_MAP[format] || 'image/png',
        sizeBytes: buf.length,
        format,
      };
    }
  } catch { /* xclip failed */ }

  // Fallback: try wl-paste (Wayland)
  try {
    const buf = execSync('wl-paste --type image/png', {
      maxBuffer: MAX_IMAGE_BYTES,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (buf.length > 0) {
      return {
        base64: buf.toString('base64'),
        mimeType: 'image/png',
        sizeBytes: buf.length,
        format: 'png',
      };
    }
  } catch { /* wl-paste failed */ }

  throw new Error('Clipboard is empty or does not contain an image. Install xclip (X11) or wl-paste (Wayland).');
}

function _readClipboardMac() {
  // Use pngpaste if available, otherwise osascript
  const tmpFile = path.join(os.tmpdir(), `khy_clipboard_${Date.now()}.png`);

  try {
    execSync(`pngpaste "${tmpFile}"`, { timeout: 5000, stdio: 'pipe' });
    if (fs.existsSync(tmpFile)) {
      const result = readImageFromFile(tmpFile);
      fs.unlinkSync(tmpFile);
      return result;
    }
  } catch { /* pngpaste not available */ }

  // Fallback: osascript
  try {
    execSync(`osascript -e 'set theFile to (POSIX file "${tmpFile}") as text' -e 'tell application "System Events" to set imageData to the clipboard as «class PNGf»' -e 'set fileRef to open for access file theFile with write permission' -e 'write imageData to fileRef' -e 'close access fileRef'`, {
      timeout: 5000,
      stdio: 'pipe',
    });
    if (fs.existsSync(tmpFile)) {
      const result = readImageFromFile(tmpFile);
      fs.unlinkSync(tmpFile);
      return result;
    }
  } catch { /* osascript failed */ }

  throw new Error('Clipboard is empty or does not contain an image. Install pngpaste: brew install pngpaste');
}

function _readClipboardWindows() {
  const tmpFile = path.join(os.tmpdir(), `khy_clipboard_${Date.now()}.png`);
  // Escape single quotes for PowerShell string literal
  const escapedPath = tmpFile.replace(/'/g, "''");
  const psScript = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img -ne $null) { $img.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png) }`;

  // Try pwsh (PowerShell 7+) first, then powershell (5.1).
  // -sta: required — Clipboard API needs STA threading model.
  // -noprofile: skip user profile for faster startup.
  const shells = POWERSHELL_BINS;
  for (const shell of shells) {
    try {
      execSync(
        `${shell} -sta -noprofile -command "${psScript.replace(/"/g, '\\"')}"`,
        { timeout: 10000, stdio: 'pipe' }
      );
      if (fs.existsSync(tmpFile)) {
        const result = readImageFromFile(tmpFile);
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        return result;
      }
    } catch { /* try next shell */ }
  }

  throw new Error('Clipboard is empty or does not contain an image.');
}

/**
 * Check if clipboard likely contains an image (quick, no full read).
 * @returns {boolean}
 */
function isClipboardImageAvailable() {
  const platform = os.platform();
  try {
    if (platform === 'linux') {
      const targets = execSync('xclip -selection clipboard -t TARGETS -o', {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return targets.includes('image/png') || targets.includes('image/jpeg');
    } else if (platform === 'darwin') {
      const result = execSync("osascript -e 'clipboard info'", {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.includes('«class PNGf»') || result.includes('«class TIFF»');
    } else if (platform === 'win32') {
      // -sta required for Clipboard API, -noprofile for speed
      const shells = POWERSHELL_BINS;
      for (const shell of shells) {
        try {
          const result = execSync(
            `${shell} -sta -noprofile -command "[System.Windows.Forms.Clipboard]::ContainsImage()"`,
            { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
          );
          return result.trim().toLowerCase() === 'true';
        } catch { /* try next */ }
      }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Read plain text from the system clipboard (cross-platform).
 *
 * Used as a fallback when the clipboard holds a file PATH rather than a bitmap:
 * the Windows img2file bridge rewrites copied screenshots into a quoted PNG
 * path, and users often copy an image file from the OS file manager. Mirrors
 * Claude Code's per-platform `getPath` clipboard commands.
 * @returns {string} clipboard text, or '' when empty/unavailable
 */
function readClipboardText() {
  const platform = os.platform();
  const EXEC = { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] };
  try {
    if (platform === 'darwin') {
      return execSync('pbpaste', EXEC) || '';
    }
    if (platform === 'win32') {
      for (const shell of POWERSHELL_BINS) {
        try {
          return execSync(`${shell} -noprofile -command "Get-Clipboard -Raw"`, EXEC) || '';
        } catch { /* try next shell */ }
      }
      return '';
    }
    // linux / other unix: X11 (xclip) then Wayland (wl-paste)
    try {
      return execSync('xclip -selection clipboard -t text/plain -o', EXEC) || '';
    } catch { /* fall through to wayland */ }
    return execSync('wl-paste --no-newline', EXEC) || '';
  } catch {
    return '';
  }
}

/**
 * Write plain text to the system clipboard (cross-platform).
 *
 * Content is piped through stdin (never interpolated into the command line), so
 * arbitrary text — quotes, newlines, shell metacharacters — is injection-safe.
 * Mirrors readClipboardText()'s per-platform tool selection.
 * @param {string} text
 * @returns {boolean} true when a clipboard backend accepted the write
 */
function writeClipboardText(text) {
  const platform = os.platform();
  const payload = String(text == null ? '' : text);
  const EXEC = { input: payload, timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'] };
  const tryPipe = (cmd) => {
    try { execSync(cmd, EXEC); return true; } catch { return false; }
  };
  try {
    if (platform === 'darwin') return tryPipe('pbcopy');
    if (platform === 'win32') {
      for (const shell of POWERSHELL_BINS) {
        // Set-Clipboard reads the piped stdin; -Raw keeps newlines intact.
        if (tryPipe(`${shell} -noprofile -command "$input | Set-Clipboard"`)) return true;
      }
      return tryPipe('clip');
    }
    // linux / other unix: X11 (xclip) then Wayland (wl-copy)
    if (tryPipe('xclip -selection clipboard')) return true;
    return tryPipe('wl-copy');
  } catch {
    return false;
  }
}


const _IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Read an image from the clipboard, trying a direct bitmap first and falling
 * back to a clipboard file PATH (Claude Code's image-first → getPath model).
 *
 * This makes the keypress paste cooperate with the background img2file bridge
 * instead of racing it: whether or not the bridge has already converted a
 * copied screenshot into a path, paste still yields the image. Also covers the
 * common case of copying an image file from the file manager.
 * @returns {{ base64, mimeType, sizeBytes, format } | null} null when the
 *          clipboard holds neither an image nor an image-file path.
 */
function readImageFromClipboardOrPath() {
  // 1) Direct bitmap on the clipboard.
  try {
    if (isClipboardImageAvailable()) {
      const img = readImageFromClipboard();
      if (img && img.base64) return img;
    }
  } catch { /* fall through to the path branch */ }

  // 2) Clipboard holds a file path (img2file bridge output, or a copied file).
  try {
    const text = String(readClipboardText() || '').trim();
    if (text) {
      const candidate = text.split(/\r?\n/)[0].trim();
      const unquoted = (candidate.startsWith('"') && candidate.endsWith('"'))
        ? candidate.slice(1, -1).trim()
        : candidate;
      if (_IMAGE_PATH_RE.test(unquoted)) {
        const img = readImageFromFile(candidate); // accepts quoted paths
        if (img && img.base64) return img;
      }
    }
  } catch { /* no usable path image */ }

  return null;
}

/**
 * Format an image's byte size for display.
 *
 * CC 后端口径对齐:走 CC `formatFileSize` 单一真源(ccFormat SSOT),与
 * health/storage/multimodal/aiUploadStore/archive 等所有展示面统一(续
 * fileSizeMediaSsot 收敛)。门控 KHY_CC_FORMAT 默认开;关 / require 失败 →
 * 逐字节回退本地旧 2 分支口径(≥1MB → "X.XMB",否则 "XKB")。
 *
 * @param {number} sizeBytes
 * @param {object} [env]
 * @returns {string}
 */
function _imageSizeStr(sizeBytes, env = process.env) {
  try {
    const { ccFormatEnabled, ccFormatFileSize } = require('../cli/ccFormat');
    if (ccFormatEnabled(env)) {
      const out = ccFormatFileSize(Number(sizeBytes));
      if (out) return out;
    }
  } catch { /* fall through to legacy */ }
  return sizeBytes >= 1024 * 1024
    ? `${(sizeBytes / 1024 / 1024).toFixed(1)}MB`
    : `${(sizeBytes / 1024).toFixed(0)}KB`;
}

/**
 * Print an image preview in the terminal.
 * Uses iTerm2 inline image protocol if supported, otherwise text summary.
 *
 * @param {{ base64: string, mimeType: string, sizeBytes: number, format: string }} image
 */
function printImagePreview(image) {
  const sizeStr = _imageSizeStr(image.sizeBytes);

  // Check for iTerm2 or compatible terminal
  const term = process.env.TERM_PROGRAM || '';
  const isITerm = term === 'iTerm.app' || term === 'WezTerm' || process.env.KITTY_WINDOW_ID;

  if (process.stdout.isTTY) return; // TUI handles image display
  if (isITerm && process.stdout.isTTY) {
    // iTerm2 inline image protocol
    const params = `inline=1;size=${image.sizeBytes};width=40;preserveAspectRatio=1`;
    process.stdout.write(`\x1b]1337;File=${params}:${image.base64}\x07\n`);
  } else {
    // Fallback: text-only summary
    let _chalk;
    const c = () => (_chalk ??= (require('chalk').default || require('chalk')));
    console.log(`  ${c().cyan('📷')} ${c().white(`[Image: ${image.format.toUpperCase()}, ${sizeStr}]`)}`);
  }
}

/**
 * Format image data for a specific AI provider.
 * Returns the provider-specific payload structure.
 *
 * @param {'google'|'openai'|'anthropic'} provider
 * @param {{ base64: string, mimeType: string }} image
 * @returns {object} provider-specific image payload
 */
function formatImageForProvider(provider, image) {
  switch (provider) {
    case 'google':
      return { inlineData: { mimeType: image.mimeType, data: image.base64 } };
    case 'openai':
      return {
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: 'auto' },
      };
    case 'anthropic':
      return {
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.base64 },
      };
    default:
      return null;
  }
}

/**
 * 将 base64 图像数据保存为临时文件，供 OCR 等工具使用。
 * @param {string} base64OrDataUrl - base64 数据或 data URL
 * @param {string} [mimeType='image/png'] - MIME 类型
 * @returns {string|null} 临时文件路径，失败返回 null
 */
function saveBase64ToTemp(base64OrDataUrl, mimeType = 'image/png') {
  try {
    let base64 = String(base64OrDataUrl || '');
    // 去掉 data URL 前缀
    const dataUrlMatch = base64.match(/^data:[^;]+;base64,(.+)$/i);
    if (dataUrlMatch) base64 = dataUrlMatch[1];
    if (!base64 || base64.length < 16) return null;

    const ext = (mimeType || '').includes('jpeg') || (mimeType || '').includes('jpg') ? '.jpg'
      : (mimeType || '').includes('webp') ? '.webp'
      : (mimeType || '').includes('gif') ? '.gif'
      : '.png';

    const tmpDir = path.join(os.tmpdir(), 'khy-ocr-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`);
    fs.writeFileSync(tmpFile, Buffer.from(base64, 'base64'));
    return tmpFile;
  } catch {
    return null;
  }
}

module.exports = {
  readImageFromFile,
  readImageFromClipboard,
  readImageFromClipboardOrPath,
  readClipboardText,
  writeClipboardText,
  isClipboardImageAvailable,
  printImagePreview,
  formatImageForProvider,
  detectFormat,
  saveBase64ToTemp,
  MAX_IMAGE_BYTES,
  _imageSizeStr,
};
