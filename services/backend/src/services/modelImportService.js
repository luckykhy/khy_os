/**
 * Model Import Service — unified pipeline for importing local model files,
 * archives, directories, and downloading models from URLs.
 *
 * Supports: .gguf, .safetensors, .zip, .tar.gz, .7z, model directories.
 * Auto-detects format, extracts archives, patches Qwen 3.5 GGUF for
 * llama.cpp compatibility, validates, and registers with Ollama.
 *
 * Reuses:
 *  - ollamaModelManager.importModel() for Ollama registration
 *  - patch_gguf_rope.py / patch_gguf_tensors.py for Qwen 3.5 fixes
 *  - resourceGuard.safeExec() for safe shell execution
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
// Model-name SSOT: default GGUF filename flows from constants/models.js.
const { LOCAL_BRAIN_GGUF_FILES } = require('../constants/models');

// Lazy-load heavy dependencies
let _ollamaMgr, _resourceGuard;
const ollamaMgr = () => (_ollamaMgr ??= require('./ollamaModelManager'));
const guard = () => (_resourceGuard ??= require('./resourceGuard'));

const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');
const LLAMA_BIN_DIR = path.resolve(__dirname, '../../bin/llama-cpp/llama-b9049');
const TEMP_BASE = path.join(os.tmpdir(), 'khy-model-import');
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min
const GGUF_MAGIC = Buffer.from('GGUF');
const OLLAMA_BLOB_NAME_RE = /^sha256[-:][a-f0-9]{32,}$/i;
const MIN_LIKELY_GGUF_BLOB_SIZE = Math.max(
  16 * 1024 * 1024,
  parseInt(process.env.KHY_LOCAL_MIN_GGUF_BLOB_SIZE || String(64 * 1024 * 1024), 10) || (64 * 1024 * 1024)
);
const MODEL_ARCHIVE_RE = /\.(zip|tar\.gz|tgz|tar|7z|rar)$/i;

// Cache for model discovery (60s TTL)
let _modelDiscoveryCache = null;
let _modelDiscoveryCacheTime = 0;
let _modelDiscoveryCacheKey = '';
const MODEL_DISCOVERY_CACHE_TTL = 60_000; // 60 seconds

// ── Utility ─────────────────────────────────────────────────────────────

function ensureTempDir() {
  if (!fs.existsSync(TEMP_BASE)) fs.mkdirSync(TEMP_BASE, { recursive: true });
  const sub = path.join(TEMP_BASE, `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(sub, { recursive: true });
  return sub;
}

function expandPath(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('~/') || p === '~') return path.join(os.homedir(), p.slice(1));
  // Windows drive-letter path on Linux/WSL: D:\foo → /mnt/d/foo
  if (/^[A-Za-z]:[\\/]/.test(p) && process.platform === 'linux') {
    try {
      if (fs.existsSync('/mnt/c') || fs.existsSync(`/mnt/${p[0].toLowerCase()}`)) {
        const drive = p[0].toLowerCase();
        return `/mnt/${drive}/${p.slice(3).replace(/\\/g, '/')}`;
      }
    } catch { /* not WSL, keep original */ }
  }
  // Normalize backslashes on non-Windows (e.g. pasted from Windows)
  if (process.platform !== 'win32' && p.includes('\\')) {
    return p.replace(/\\/g, '/');
  }
  return p;
}

function _pushUniquePath(list, seen, candidate) {
  if (!candidate) return;
  const expanded = expandPath(String(candidate).trim());
  if (!expanded) return;
  const full = path.resolve(expanded);
  if (seen.has(full)) return;
  seen.add(full);
  list.push(full);
}

function _getKhyDataHomes() {
  const homes = [];
  const seen = new Set();

  const envHome = String(process.env.KHY_DATA_HOME || '').trim();
  if (envHome) _pushUniquePath(homes, seen, envHome);

  try {
    const dataHome = require('../utils/dataHome');
    if (dataHome && typeof dataHome.getDataHome === 'function') {
      _pushUniquePath(homes, seen, dataHome.getDataHome());
    }
    if (dataHome && typeof dataHome.getLegacyDataHome === 'function') {
      _pushUniquePath(homes, seen, dataHome.getLegacyDataHome());
    }
  } catch {
    // Ignore and keep fallback homes below.
  }

  _pushUniquePath(homes, seen, path.join(os.homedir(), '.khy'));
  _pushUniquePath(homes, seen, path.join(os.homedir(), '.khyquant'));
  return homes;
}

function _getOllamaBlobDirs() {
  const dirs = [];
  const seen = new Set();
  const envModels = String(process.env.OLLAMA_MODELS || '').trim();
  if (envModels) {
    const resolved = path.resolve(expandPath(envModels));
    const base = path.basename(resolved).toLowerCase();
    if (base === 'blobs') {
      _pushUniquePath(dirs, seen, resolved);
    } else if (base === 'models') {
      _pushUniquePath(dirs, seen, path.join(resolved, 'blobs'));
    } else {
      _pushUniquePath(dirs, seen, path.join(resolved, 'blobs'));
      _pushUniquePath(dirs, seen, resolved);
    }
  }
  _pushUniquePath(dirs, seen, path.join(os.homedir(), '.ollama', 'models', 'blobs'));
  return dirs;
}

/**
 * Resolve the destination directory for imported model weights.
 *
 * Model weights are large (often multi-GB), so prefer a NON-system drive to
 * protect the system drive. Resolution:
 *   1. KHY_MODELS_DIR (explicit override)
 *   2. established-models-dir-wins: an existing non-empty <backend>/models stays
 *      put (never relocate weights already on disk)
 *   3. storageRoots policy: largest-free non-system drive, else system default
 * preferCwd is false — multi-GB weights must not land in the user's cwd.
 * @returns {string}
 */
function resolveModelsDest() {
  if (process.env.KHY_MODELS_DIR) return process.env.KHY_MODELS_DIR;
  const builtin = path.resolve(__dirname, '../../models');
  try {
    if (fs.existsSync(builtin) && fs.readdirSync(builtin).length > 0) return builtin;
  } catch { /* fall through */ }
  try {
    const { resolveGeneratedFileDir } = require('../utils/storageRoots');
    return resolveGeneratedFileDir({ subdir: 'models', preferCwd: false }).dir;
  } catch {
    return builtin;
  }
}

function getModelSearchDirs() {
  const dirs = [];
  const seen = new Set();

  _pushUniquePath(dirs, seen, path.resolve(__dirname, '../../models'));
  // Where imports actually land (may be a non-system drive) — keep discoverable.
  try { _pushUniquePath(dirs, seen, resolveModelsDest()); } catch { /* best-effort */ }
  _pushUniquePath(dirs, seen, path.join(process.cwd(), 'models'));
  _pushUniquePath(dirs, seen, path.join(process.cwd(), 'backend', 'models'));

  const runtimeRoot = String(process.env.KHYQUANT_ROOT || '').trim();
  if (runtimeRoot) {
    const rr = path.resolve(expandPath(runtimeRoot));
    _pushUniquePath(dirs, seen, path.join(rr, 'models'));
    _pushUniquePath(dirs, seen, path.join(rr, '..', 'models'));
    _pushUniquePath(dirs, seen, path.join(rr, '..', 'backend', 'models'));
  }

  for (const home of _getKhyDataHomes()) {
    _pushUniquePath(dirs, seen, path.join(home, 'models'));
  }
  for (const blobDir of _getOllamaBlobDirs()) {
    _pushUniquePath(dirs, seen, blobDir);
  }

  _pushUniquePath(dirs, seen, path.join(os.homedir(), 'models'));
  _pushUniquePath(dirs, seen, path.join(os.homedir(), 'Downloads'));
  _pushUniquePath(dirs, seen, path.join(os.homedir(), '.cache', 'huggingface', 'hub'));
  _pushUniquePath(dirs, seen, path.join(os.homedir(), '.cache', 'modelscope', 'hub'));
  return dirs;
}

function isUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function hasGgufMagic(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const magic = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, magic, 0, 4, 0);
    return bytesRead === 4 && Buffer.compare(magic, GGUF_MAGIC) === 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Parse an Ollama Modelfile to extract model name and parameters.
 * Handles both UTF-8 and UTF-16LE (Windows export) encoding.
 */
function parseOllamaModelfile(modelfilePath) {
  if (!fs.existsSync(modelfilePath)) return null;
  let raw = fs.readFileSync(modelfilePath);
  // Detect UTF-16LE BOM or NUL-interleaved ASCII (Windows export)
  let text;
  if ((raw[0] === 0xFF && raw[1] === 0xFE) || (raw.length > 2 && raw[1] === 0)) {
    text = raw.toString('utf16le').replace(/\uFEFF/g, '');
  } else {
    text = raw.toString('utf-8');
  }
  const result = { modelName: '', from: '', parameters: {} };
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Extract model name from comment: "# FROM qwen3.5:4b"
    const commentFrom = trimmed.match(/^#\s*FROM\s+(\S+)/i);
    if (commentFrom && !result.modelName) result.modelName = commentFrom[1];
    // Extract FROM directive
    const fromMatch = trimmed.match(/^FROM\s+(\S+)/i);
    if (fromMatch) result.from = fromMatch[1];
    // Extract PARAMETER directives
    const paramMatch = trimmed.match(/^PARAMETER\s+(\S+)\s+(.+)/i);
    if (paramMatch) result.parameters[paramMatch[1]] = paramMatch[2].trim();
  }
  // Infer model name from FROM if not in comment
  if (!result.modelName && result.from) {
    const fromBase = path.basename(result.from);
    if (/sha256/i.test(fromBase)) {
      // FROM points to blob — no useful name, try parent directory
    } else {
      result.modelName = result.from;
    }
  }
  return result;
}

/**
 * Handle Ollama export structure: detect blob + Modelfile, copy blob to
 * KHY models directory as the primary local model file.
 *
 * @param {string} dir - directory containing extracted Ollama export
 * @returns {{ handled: boolean, modelPath?: string, modelName?: string, steps: string[] }}
 */
function handleOllamaExport(dir) {
  const steps = [];
  const entries = fs.readdirSync(dir);
  // Find sha256 blob
  const blobEntry = entries.find(f => OLLAMA_BLOB_NAME_RE.test(f) && hasGgufMagic(path.join(dir, f)));
  if (!blobEntry) return { handled: false, steps };

  const blobPath = path.join(dir, blobEntry);
  const blobSize = fs.statSync(blobPath).size;
  steps.push(`Found Ollama blob: ${blobEntry} (${(blobSize / 1024 / 1024 / 1024).toFixed(1)} GiB)`);

  // Parse Modelfile if present
  let modelName = '';
  const modelfileEntry = entries.find(f => /modelfile/i.test(f));
  if (modelfileEntry) {
    const mf = parseOllamaModelfile(path.join(dir, modelfileEntry));
    if (mf && mf.modelName) {
      modelName = mf.modelName.replace(/:.*$/, ''); // strip tag like ":4b"
      steps.push(`Modelfile parsed: model=${mf.modelName}`);
    }
  }

  // Determine destination filename
  const destName = modelName
    ? `${modelName.replace(/[^a-zA-Z0-9._-]/g, '-')}.gguf`
    : LOCAL_BRAIN_GGUF_FILES[0];
  const modelsDir = resolveModelsDest();
  if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });
  const destPath = path.join(modelsDir, destName);

  // Copy blob to models directory
  steps.push(`Copying to ${destPath}`);
  fs.copyFileSync(blobPath, destPath);
  steps.push(`Model file ready: ${destName}`);

  return { handled: true, modelPath: destPath, modelName: modelName || destName, steps };
}

// ── Archive Extraction ──────────────────────────────────────────────────

/**
 * Peek at ZIP entry names without full extraction (cross-platform, pure JS).
 * Reads the End of Central Directory and Central Directory entries from the
 * file tail. Returns an array of entry file names, or null on failure.
 */
function _peekZipEntryNames(zipPath) {
  let fd;
  try {
    fd = fs.openSync(zipPath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    // Read last 64KB to find End of Central Directory signature (0x06054b50)
    const tailSize = Math.min(65536, fileSize);
    const buf = Buffer.alloc(tailSize);
    fs.readSync(fd, buf, 0, tailSize, fileSize - tailSize);
    // Scan backwards for EOCD signature
    let eocdOffset = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4B && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) { return null; }
    const cdOffset = buf.readUInt32LE(eocdOffset + 16); // central dir start offset
    const cdSize = buf.readUInt32LE(eocdOffset + 12);
    const totalEntries = buf.readUInt16LE(eocdOffset + 10);
    // Read Central Directory
    const cdBuf = Buffer.alloc(Math.min(cdSize, 1024 * 1024)); // cap at 1MB
    fs.readSync(fd, cdBuf, 0, cdBuf.length, cdOffset);
    const names = [];
    let pos = 0;
    for (let i = 0; i < totalEntries && pos < cdBuf.length - 46; i++) {
      if (cdBuf.readUInt32LE(pos) !== 0x02014b50) break; // central dir entry signature
      const nameLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      if (pos + 46 + nameLen > cdBuf.length) break;
      names.push(cdBuf.toString('utf-8', pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;
    }
    return names;
  } catch { return null; }
  finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Extract a ZIP archive using node-stream-zip (pure JS, cross-platform).
 * No external `unzip` command needed — works on Windows, Linux, macOS.
 */
function _extractZipSync(zipPath, destDir) {
  // node-stream-zip sync mode for large model archives (no size limit)
  const StreamZip = require('node-stream-zip');
  const zip = new StreamZip({ file: zipPath, storeEntries: true });

  return new Promise((resolve, reject) => {
    zip.on('error', err => { zip.close(); reject(err); });
    zip.on('ready', () => {
      try {
        fs.mkdirSync(destDir, { recursive: true });
        zip.extract(null, destDir, (err) => {
          zip.close();
          if (err) reject(new Error(`ZIP extraction failed: ${err.message || err}`));
          else resolve(destDir);
        });
      } catch (e) { zip.close(); reject(e); }
    });
  });
}

/**
 * Extract an archive file to a destination directory.
 * Cross-platform: ZIP uses node-stream-zip (pure JS), tar/7z use shell commands.
 * Supports: .zip, .tar.gz, .tgz, .tar, .7z
 */
function extractArchive(archivePath, destDir) {
  const lower = archivePath.toLowerCase();

  // ZIP: pure JS extraction via node-stream-zip (works on all platforms)
  if (lower.endsWith('.zip')) {
    // Return a promise — callers in importFromPath already handle async
    return _extractZipSync(archivePath, destDir);
  }

  // TAR / 7z: require shell commands
  const { searchExecutable } = require('../tools/platformUtils');
  let command, args;

  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    command = searchExecutable('tar');
    if (!command) throw new Error('tar not found — install tar or bsdtar to extract .tar.gz archives');
    args = ['-xzf', archivePath, '-C', destDir];
  } else if (lower.endsWith('.tar')) {
    command = searchExecutable('tar');
    if (!command) throw new Error('tar not found — install tar or bsdtar to extract .tar archives');
    args = ['-xf', archivePath, '-C', destDir];
  } else if (lower.endsWith('.7z')) {
    command = searchExecutable('7z') || searchExecutable('7za');
    if (!command) throw new Error('7z not found — install 7-Zip to extract .7z archives');
    args = ['x', `-o${destDir}`, '-y', archivePath];
  } else {
    throw new Error(`Unsupported archive format: ${path.extname(archivePath)}`);
  }

  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSync(command, args, {
    timeout: EXTRACT_TIMEOUT_MS,
    maxBuffer: 5 * 1024 * 1024,
    encoding: 'utf-8',
  });

  if (result.error) {
    throw new Error(`Archive extraction failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr || '';
    throw new Error(`Archive extraction failed (exit ${result.status}): ${stderr.slice(0, 500)}`);
  }

  return destDir;
}

// ── Model Format Detection ──────────────────────────────────────────────

/**
 * Recursively scan a directory for model files.
 * Returns { ggufFiles: string[], safetensorsFiles: string[], hasConfig: bool }
 */
function scanForModelFiles(dir, maxDepth = 3) {
  const result = { ggufFiles: [], safetensorsFiles: [], hasConfig: false };
  _scanDir(dir, result, 0, maxDepth);
  return result;
}

function _scanDir(dir, result, depth, maxDepth) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      _scanDir(fullPath, result, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.gguf')) result.ggufFiles.push(fullPath);
      const ext = path.extname(lower);
      if ((OLLAMA_BLOB_NAME_RE.test(lower) || ext === '')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > MIN_LIKELY_GGUF_BLOB_SIZE && hasGgufMagic(fullPath)) {
            result.ggufFiles.push(fullPath);
          }
        } catch { /* ignore */ }
      }
      if (lower.endsWith('.safetensors')) result.safetensorsFiles.push(fullPath);
      if (lower === 'config.json') result.hasConfig = true;
    }
  }
}

/**
 * Detect model format from a path (file or directory).
 * Enhanced version of ollamaModelManager.inferImportSource() that also
 * handles archives and nested directory structures.
 */
function detectModelFormat(sourcePath) {
  const abs = path.resolve(sourcePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Path not found: ${abs}`);
  }

  const st = fs.statSync(abs);
  if (st.isFile()) {
    const lower = abs.toLowerCase();
    const basename = path.basename(abs).toLowerCase();
    if (lower.endsWith('.gguf')) return { kind: 'gguf', absPath: abs, files: [abs] };
    if ((OLLAMA_BLOB_NAME_RE.test(basename) || path.extname(basename) === '')
      && st.size > MIN_LIKELY_GGUF_BLOB_SIZE
      && hasGgufMagic(abs)) {
      return { kind: 'gguf', absPath: abs, files: [abs], inferredFrom: 'ollama_blob' };
    }
    if (lower.endsWith('.safetensors')) return { kind: 'adapter', absPath: abs, files: [abs] };
    if (MODEL_ARCHIVE_RE.test(lower)) return { kind: 'archive', absPath: abs };
    throw new Error(`Unsupported model file type: ${path.extname(abs)}`);
  }

  if (st.isDirectory()) {
    const scan = scanForModelFiles(abs);

    // Prefer GGUF if found
    if (scan.ggufFiles.length > 0) {
      // Pick the largest GGUF file (likely the main model, not a split part)
      const sorted = scan.ggufFiles.sort((a, b) => {
        try { return fs.statSync(b).size - fs.statSync(a).size; } catch { return 0; }
      });
      return { kind: 'gguf', absPath: sorted[0], files: scan.ggufFiles };
    }

    // Safetensors model directory
    if (scan.safetensorsFiles.length > 0 && scan.hasConfig) {
      return { kind: 'safetensors_model', absPath: abs, files: scan.safetensorsFiles };
    }

    // Safetensors directory without config (adapter or raw)
    if (scan.safetensorsFiles.length > 0) {
      return { kind: 'safetensors_dir', absPath: abs, files: scan.safetensorsFiles };
    }

    throw new Error('Directory does not contain recognized model files (.gguf or .safetensors)');
  }

  throw new Error('Unsupported source path type');
}

// ── Qwen 3.5 Patching ──────────────────────────────────────────────────

/**
 * Check if a GGUF file needs Qwen 3.5 patching by inspecting its metadata.
 * Returns { needsRopePatch: bool, needsTensorPatch: bool, arch: string }
 */
function checkQwenPatching(ggufPath) {
  const result = { needsRopePatch: false, needsTensorPatch: false, arch: '' };

  // Use llama-cli to dump metadata (quick check)
  const llamaCli = path.join(LLAMA_BIN_DIR, 'llama-cli');
  if (!fs.existsSync(llamaCli)) return result;

  try {
    // Get model metadata: check architecture and tensor names
    const env = { ...process.env, LD_LIBRARY_PATH: `${LLAMA_BIN_DIR}:${process.env.LD_LIBRARY_PATH || ''}` };
    const llamaResult = spawnSync(llamaCli, [
      '--model', ggufPath,
      '--log-disable',
      '-ngl', '0',
      '-n', '0'
    ], {
      encoding: 'utf-8',
      timeout: 15000,
      env,
      maxBuffer: 1024 * 1024,
    });

    if (llamaResult.error) throw llamaResult.error;

    const output = (llamaResult.stdout + llamaResult.stderr).toLowerCase().split('\n').slice(0, 50).join('\n');

    // Check if it's a Qwen 3.5 architecture
    if (/qwen3_5|qwen35|qwen3\.5/.test(output)) {
      result.arch = 'qwen3.5';
      // Heuristic: if we see qwen3.5 arch, both patches are likely needed
      result.needsRopePatch = true;
      result.needsTensorPatch = true;
    }
  } catch {
    // If llama-cli fails, try Python fallback — check file content pattern
    try {
      const buf = Buffer.alloc(8192);
      let fd;
      try {
        fd = fs.openSync(ggufPath, 'r');
        fs.readSync(fd, buf, 0, 8192, 0);
      } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      const header = buf.toString('utf-8', 0, 8192);
      if (/qwen3[._]?5/i.test(header)) {
        result.arch = 'qwen3.5';
        result.needsRopePatch = true;
        result.needsTensorPatch = true;
      }
    } catch { /* ignore */ }
  }

  return result;
}

/**
 * Apply Qwen 3.5 patches to a GGUF file.
 */
function applyQwenPatches(ggufPath, patchInfo) {
  const results = [];

  // Cross-platform Python detection: python3 → python → py
  const { searchExecutable } = require('../tools/platformUtils');
  const pythonCmd = searchExecutable('python3') || searchExecutable('python') || searchExecutable('py');
  if (!pythonCmd) {
    results.push({ patch: 'python_check', success: false, output: 'Python not found (tried python3, python, py)' });
    return results;
  }

  if (patchInfo.needsTensorPatch) {
    const script = path.join(SCRIPTS_DIR, 'patch_gguf_tensors.py');
    if (fs.existsSync(script)) {
      const r = spawnSync(pythonCmd, [script, ggufPath], {
        timeout: 120_000,
        encoding: 'utf-8',
        maxBuffer: 5 * 1024 * 1024,
      });
      results.push({
        patch: 'tensor_rename',
        success: r.status === 0 && !r.error,
        output: ((r.stdout || '') + (r.stderr || '')).slice(0, 500),
      });
    }
  }

  if (patchInfo.needsRopePatch) {
    const script = path.join(SCRIPTS_DIR, 'patch_gguf_rope.py');
    if (fs.existsSync(script)) {
      const r = spawnSync(pythonCmd, [script, ggufPath], {
        timeout: 60_000,
        encoding: 'utf-8',
        maxBuffer: 5 * 1024 * 1024,
      });
      results.push({
        patch: 'rope_dimension',
        success: r.status === 0 && !r.error,
        output: ((r.stdout || '') + (r.stderr || '')).slice(0, 500),
      });
    }
  }

  return results;
}

// ── GGUF Validation ─────────────────────────────────────────────────────

/**
 * Validate a GGUF file by checking magic bytes and optionally running
 * llama-quantize in info-only mode.
 */
function validateGguf(ggufPath) {
  // Check magic bytes
  let fd;
  try {
    fd = fs.openSync(ggufPath, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    if (magic.toString('ascii') !== 'GGUF') {
      return { valid: false, error: 'Invalid GGUF file (bad magic bytes)' };
    }
  } catch (err) {
    return { valid: false, error: `Cannot read file: ${err.message}` };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }

  // Try to get info via llama-quantize (it prints model info without quantizing)
  const llamaQuantize = path.join(LLAMA_BIN_DIR, 'llama-quantize');
  if (fs.existsSync(llamaQuantize)) {
    try {
      const env = { ...process.env, LD_LIBRARY_PATH: `${LLAMA_BIN_DIR}:${process.env.LD_LIBRARY_PATH || ''}` };
      const isWin = process.platform === 'win32';
      const shellCmd = isWin
        ? `"${llamaQuantize}" --help 2>NUL & echo --- & "${llamaQuantize}" "${ggufPath}" NUL q4_0 2>&1`
        : `"${llamaQuantize}" --help 2>/dev/null; echo "---"; "${llamaQuantize}" "${ggufPath}" /dev/null q4_0 2>&1 | head -20`;
      const r = execSync(shellCmd, { encoding: 'utf-8', timeout: 15000, env, stdio: ['pipe', 'pipe', 'pipe'] });
      // If we get tensor info, the GGUF is structurally valid
      if (/n_tensors|tensor_count/i.test(r)) {
        return { valid: true, info: r.slice(0, 500) };
      }
    } catch { /* fallback: magic check was enough */ }
  }

  // Magic bytes passed → consider valid
  const stat = fs.statSync(ggufPath);
  return { valid: true, sizeMB: Math.round(stat.size / (1024 * 1024)) };
}

// ── URL Download ────────────────────────────────────────────────────────

/**
 * Download a file from a URL to a destination directory.
 * Returns the path to the downloaded file.
 */
function downloadFile(url, destDir) {
  const urlObj = new URL(url);

  // Derive filename from URL path
  let filename = path.basename(urlObj.pathname) || 'model-download';
  if (!path.extname(filename)) filename += '.gguf';

  const destPath = path.join(destDir, filename);

  // Prefer wget (shows progress), fallback to curl
  const { searchExecutable } = require('../tools/platformUtils');
  const hasWget = !!searchExecutable('wget');

  let command, args;
  if (hasWget) {
    command = 'wget';
    args = ['-q', '--show-progress', '--progress=bar:force:noscroll', '-O', destPath, url];
  } else {
    command = 'curl';
    args = ['-fSL', '--progress-bar', '-o', destPath, url];
  }

  const result = spawnSync(command, args, {
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf-8',
  });

  if (result.error) {
    throw new Error(`Download failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr || '';
    throw new Error(`Download failed (exit ${result.status}): ${stderr.slice(0, 500)}`);
  }

  if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
    throw new Error('Download produced empty file');
  }

  return destPath;
}

/**
 * Resolve HuggingFace / ModelScope URLs to direct download links.
 */
function resolveModelUrl(url) {
  const u = String(url).trim();

  // HuggingFace: convert blob/main to resolve/main for direct download
  if (/huggingface\.co|hf-mirror\.com/.test(u)) {
    return u.replace('/blob/', '/resolve/');
  }

  // ModelScope: add download query param if needed
  if (/modelscope\.cn/.test(u) && !/download=true/.test(u)) {
    const sep = u.includes('?') ? '&' : '?';
    return `${u}${sep}download=true`;
  }

  return u;
}

// ── Main Import Pipeline ────────────────────────────────────────────────

/**
 * Import a model from a local path.
 * Handles: single files, archives, directories.
 *
 * @param {string} sourcePath - local file/directory path
 * @param {object} [options]
 * @param {string} [options.name] - target model name
 * @param {string} [options.base] - base model for adapter imports
 * @param {boolean} [options.autoPatch] - auto-apply Qwen patches (default true)
 * @returns {Promise<object>}
 */
async function importFromPath(sourcePath, options = {}) {
  const expanded = expandPath(String(sourcePath).trim());
  const abs = path.resolve(expanded);

  if (!fs.existsSync(abs)) {
    return { success: false, error: `Path not found: ${abs}` };
  }

  const steps = [];
  let tempDir = null;
  let finalModelPath = abs;

  try {
    // Step 1: Detect format
    const format = detectModelFormat(abs);
    steps.push(`Format detected: ${format.kind}`);

    // Step 2: Extract archive if needed
    if (format.kind === 'archive') {
      tempDir = ensureTempDir();
      steps.push(`Extracting archive to ${tempDir}`);
      await extractArchive(abs, tempDir);

      // Check for Ollama export structure (sha256 blob + optional Modelfile)
      const ollamaExport = handleOllamaExport(tempDir);
      if (ollamaExport.handled) {
        steps.push(...ollamaExport.steps);
        return {
          success: true,
          model: ollamaExport.modelName,
          modelPath: ollamaExport.modelPath,
          sourceKind: 'ollama_export',
          steps,
          message: `Model imported from Ollama export: ${ollamaExport.modelName}`,
        };
      }

      // Not an Ollama export — re-detect format in extracted content
      const extracted = detectModelFormat(tempDir);
      steps.push(`Extracted format: ${extracted.kind}`);
      finalModelPath = extracted.absPath;

      // Update format reference
      Object.assign(format, extracted);
    }

    // Step 2b: Handle directory input (may also be an Ollama export)
    if (format.kind !== 'archive' && fs.statSync(abs).isDirectory()) {
      const ollamaExport = handleOllamaExport(abs);
      if (ollamaExport.handled) {
        steps.push(...ollamaExport.steps);
        return {
          success: true,
          model: ollamaExport.modelName,
          modelPath: ollamaExport.modelPath,
          sourceKind: 'ollama_export',
          steps,
          message: `Model imported from Ollama export: ${ollamaExport.modelName}`,
        };
      }
    }

    // Step 2c: Direct GGUF file — copy to models directory if not already there
    if (format.kind === 'gguf') {
      const modelsDir = path.resolve(__dirname, '../../models');
      if (!finalModelPath.startsWith(modelsDir)) {
        const destName = options.name
          ? `${options.name.replace(/[^a-zA-Z0-9._-]/g, '-')}.gguf`
          : path.basename(finalModelPath);
        const destPath = path.join(modelsDir, destName);
        if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive: true });
        steps.push(`Copying to ${destPath}`);
        fs.copyFileSync(finalModelPath, destPath);
        finalModelPath = destPath;
        steps.push(`Model file ready: ${destName}`);
      }
    }

    // Step 3: Validate GGUF
    if (format.kind === 'gguf') {
      // Provision the bundled llama.cpp suite on first use if it isn't on disk
      // yet. The binaries are untracked from git and fetched on demand
      // (per-platform, SHA256-verified) into bin/llama-cpp — see
      // runtimeProvisioner and config/runtime-binaries.json. Never throws; on
      // any failure validateGguf()/checkQwenPatching() fall back to their
      // Python / file-content paths. LLAMA_BIN_DIR is a fixed path constant, so
      // the synchronous calls below pick up freshly provisioned binaries with no
      // re-resolution needed.
      await require('./runtimeProvisioner').ensureRuntime('llama-cpp').catch(() => null);

      const validation = validateGguf(finalModelPath);
      if (!validation.valid) {
        return { success: false, error: `GGUF validation failed: ${validation.error}`, steps };
      }
      steps.push(`GGUF validated (${validation.sizeMB || '?'} MB)`);

      // Step 4: Check and apply Qwen patches
      const autoPatch = options.autoPatch !== false;
      if (autoPatch) {
        const patchInfo = checkQwenPatching(finalModelPath);
        if (patchInfo.needsRopePatch || patchInfo.needsTensorPatch) {
          steps.push(`Qwen 3.5 architecture detected — applying patches`);
          const patchResults = applyQwenPatches(finalModelPath, patchInfo);
          for (const pr of patchResults) {
            steps.push(`  Patch ${pr.patch}: ${pr.success ? 'OK' : 'FAILED'}`);
          }
        }
      }
    }

    // Step 5-6: Ollama registration (best-effort — model file already in models/)
    // If the model file is already in place, import is successful even without Ollama.
    const modelName = options.name || path.basename(finalModelPath, '.gguf');
    let ollamaRegistered = false;
    try {
      const ollamaStatus = await ollamaMgr().ensureOllamaRunning();
      if (ollamaStatus.running) {
        if (ollamaStatus.autoStarted) steps.push('Auto-started Ollama');
        const importResult = await ollamaMgr().importModel(finalModelPath, options.name || '', {
          base: options.base,
        });
        if (importResult.success) {
          steps.push(`Registered with Ollama as: ${importResult.model}`);
          ollamaRegistered = true;
        } else {
          steps.push(`Ollama registration skipped: ${importResult.error}`);
        }
      } else {
        steps.push('Ollama not running — skipped registration (model file is ready for direct use)');
      }
    } catch (ollamaErr) {
      steps.push(`Ollama registration failed: ${ollamaErr.message} (model file is still usable)`);
    }

    return {
      success: true,
      model: ollamaRegistered ? modelName : modelName,
      modelPath: finalModelPath,
      sourceKind: format.kind,
      ollamaRegistered,
      steps,
      message: `Model ${modelName} imported successfully (${format.kind})${ollamaRegistered ? '' : ' — Ollama registration skipped'}`,
    };
  } catch (err) {
    return { success: false, error: err.message || String(err), steps };
  } finally {
    // Cleanup temp extraction directory (keep the original archive)
    if (tempDir) cleanupDir(tempDir);
  }
}

/**
 * Import a model from a URL.
 * Downloads the file, then delegates to importFromPath.
 *
 * @param {string} url - model download URL
 * @param {object} [options]
 * @param {string} [options.name] - target model name
 * @param {string} [options.base] - base model for adapter imports
 * @returns {Promise<object>}
 */
async function importFromUrl(url, options = {}) {
  const resolvedUrl = resolveModelUrl(url);
  const tempDir = ensureTempDir();

  try {
    const downloadedPath = downloadFile(resolvedUrl, tempDir);
    const result = await importFromPath(downloadedPath, options);

    // Prepend download step info
    result.steps = [`Downloaded from: ${url}`, ...(result.steps || [])];
    return result;
  } catch (err) {
    return { success: false, error: `Download failed: ${err.message}`, steps: [`URL: ${url}`] };
  } finally {
    cleanupDir(tempDir);
  }
}

/**
 * Unified import entry point — detects whether source is a URL or local path.
 */
async function importModel(source, options = {}) {
  const s = String(source || '').trim();
  if (!s) return { success: false, error: 'No source path or URL provided' };

  if (isUrl(s)) {
    return importFromUrl(s, options);
  }
  return importFromPath(s, options);
}

/**
 * Check if a path looks like it contains model files.
 * Used for drag-and-drop model file detection.
 */
function looksLikeModelPath(p) {
  const s = String(p || '').trim().replace(/^['"`]+|['"`]+$/g, '');
  if (!s) return false;

  // Direct model file extensions
  if (/\.(gguf|safetensors)$/i.test(s)) return true;
  if (/sha256[-:][a-f0-9]{32,}$/i.test(path.basename(s))) return true;

  // Archive that could contain a model (keyword match)
  if (MODEL_ARCHIVE_RE.test(s) && /model|gguf|safetensor|qwen|llama|deepseek|phi|gemma|ollama|export/i.test(s)) {
    return true;
  }

  // Large ZIP without keywords — peek inside for sha256 blobs or .gguf files
  if (MODEL_ARCHIVE_RE.test(s) && /\.zip$/i.test(s)) {
    try {
      const expanded = expandPath(s);
      const abs = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
      if (fs.existsSync(abs) && fs.statSync(abs).size > 100 * 1024 * 1024) {
        const entryNames = _peekZipEntryNames(abs);
        if (entryNames && entryNames.some(n =>
          /sha256[-:][a-f0-9]{32,}/i.test(n) || /\.gguf\b/i.test(n) || /modelfile/i.test(n)
        )) {
          return true;
        }
      }
    } catch { /* ignore */ }
  }

  // Directory check — see if it contains model files or Ollama export structure
  try {
    const expanded = expandPath(s);
    const abs = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      const files = fs.readdirSync(abs);
      if (files.some(f => /\.(gguf|safetensors)$/i.test(f))) return true;
      // Ollama export: directory contains sha256 blob + optional Modelfile
      if (files.some(f => OLLAMA_BLOB_NAME_RE.test(f))) return true;
    }
  } catch { /* ignore */ }

  return false;
}

/**
 * Check if a string looks like a model download URL.
 */
function looksLikeModelUrl(s) {
  const text = String(s || '').trim();
  // Direct model file URL
  if (/https?:\/\/[^\s]+\.(gguf|safetensors|zip|tar\.gz)/i.test(text)) return true;
  // Known model hosting sites
  if (/https?:\/\/(huggingface\.co|hf-mirror\.com|modelscope\.cn|github\.com)[^\s]*(model|gguf|safetensor)/i.test(text)) return true;
  return false;
}

// ── Model Discovery & Listing ───────────────────────────────────────────

/**
 * Scan the local filesystem for all model files.
 * Returns an array of { path, name, sizeMB, format, location }.
 * Uses 60s TTL cache to avoid repeated filesystem scans.
 */
function discoverLocalModels() {
  const now = Date.now();
  const modelSearchDirs = getModelSearchDirs();
  const cacheKey = modelSearchDirs.join('|');
  if (
    _modelDiscoveryCache &&
    _modelDiscoveryCacheKey === cacheKey &&
    (now - _modelDiscoveryCacheTime) < MODEL_DISCOVERY_CACHE_TTL
  ) {
    return _modelDiscoveryCache;
  }

  const found = [];
  const seen = new Set();

  for (const dir of modelSearchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      _discoverInDir(dir, found, seen, 0, 2);
    } catch { /* skip inaccessible dirs */ }
  }

  _modelDiscoveryCache = found;
  _modelDiscoveryCacheTime = now;
  _modelDiscoveryCacheKey = cacheKey;
  return found;
}

function _discoverInDir(dir, results, seen, depth, maxDepth) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Skip symlink loops and already-seen files
    try {
      const real = fs.realpathSync(fullPath);
      if (seen.has(real)) continue;
      seen.add(real);
    } catch { continue; }

    if (entry.isDirectory()) {
      _discoverInDir(fullPath, results, seen, depth + 1, maxDepth);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      const ext = path.extname(lower);
      if (lower.endsWith('.gguf') && !lower.endsWith('.bak')) {
        try {
          const stat = fs.statSync(fullPath);
          // Skip tiny files (< 1 MB, likely not real models)
          if (stat.size < 1024 * 1024) continue;
          results.push({
            path: fullPath,
            name: entry.name.replace(/\.gguf$/i, ''),
            sizeMB: Math.round(stat.size / (1024 * 1024)),
            format: 'gguf',
            location: _classifyLocation(fullPath),
          });
        } catch { /* skip */ }
      }
      if ((OLLAMA_BLOB_NAME_RE.test(lower) || ext === '')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < MIN_LIKELY_GGUF_BLOB_SIZE) continue;
          if (!hasGgufMagic(fullPath)) continue;
          results.push({
            path: fullPath,
            name: entry.name.slice(0, 20),
            sizeMB: Math.round(stat.size / (1024 * 1024)),
            format: 'gguf_blob',
            location: _classifyLocation(fullPath),
          });
          continue;
        } catch { /* skip */ }
      }
      if (lower.endsWith('.safetensors')) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < 1024 * 1024) continue;
          results.push({
            path: fullPath,
            name: entry.name.replace(/\.safetensors$/i, ''),
            sizeMB: Math.round(stat.size / (1024 * 1024)),
            format: 'safetensors',
            location: _classifyLocation(fullPath),
          });
        } catch { /* skip */ }
      }
      if (MODEL_ARCHIVE_RE.test(lower)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size < 1024 * 1024) continue;
          results.push({
            path: fullPath,
            name: entry.name,
            sizeMB: Math.round(stat.size / (1024 * 1024)),
            format: 'archive',
            location: _classifyLocation(fullPath),
          });
        } catch { /* skip */ }
      }
    }
  }
}

function _classifyLocation(filePath) {
  const p = String(filePath || '').toLowerCase().replace(/\\/g, '/');
  if (p.includes('/.ollama/')) return 'ollama';
  if (p.includes('/.khy/') || p.includes('/.khyquant/')) return 'khy';
  if (p.includes('/khy-quant/') || p.includes(path.resolve(__dirname, '../..').toLowerCase().replace(/\\/g, '/'))) return 'khy';
  if (p.includes('huggingface')) return 'huggingface-cache';
  if (p.includes('modelscope')) return 'modelscope-cache';
  if (p.includes('/downloads/')) return 'downloads';
  return 'local';
}

/**
 * List all models: Ollama-registered + local files + IDE-available models.
 * Returns { ollamaModels, localModels, khyModels, ideModels }
 */
async function listAllModels() {
  const result = {
    khyModels: [],       // Imported into KHY/Ollama
    localModels: [],     // Found on disk but not imported
    ollamaModels: [],    // All Ollama-registered models
    ideModels: [],       // Models available via IDE adapters
  };

  // 1. Get Ollama models
  try {
    const models = await ollamaMgr().listModels();
    result.ollamaModels = models.map(m => ({
      name: m.name,
      size: m.size,
      family: m.family,
      paramSize: m.paramSize,
      quantization: m.quantization,
      source: 'ollama',
      imported: true,
    }));
    result.khyModels = result.ollamaModels.slice(); // Ollama models = KHY models
  } catch { /* Ollama not running */ }

  // 2. Discover local model files
  const localFiles = discoverLocalModels();
  const importedNames = new Set(result.ollamaModels.map(m => m.name.split(':')[0].toLowerCase()));

  for (const file of localFiles) {
    // Check if this model is already imported to Ollama
    const baseName = file.name.toLowerCase().replace(/[-_.]/g, '');
    const isImported = importedNames.has(baseName) ||
      [...importedNames].some(n => baseName.includes(n) || n.includes(baseName));

    result.localModels.push({
      ...file,
      imported: isImported,
      sizeStr: file.sizeMB > 1024 ? `${(file.sizeMB / 1024).toFixed(1)} GB` : `${file.sizeMB} MB`,
    });
  }

  // 3. Discover IDE models via gateway adapters
  try {
    const gateway = require('./gateway/aiGateway');
    const adapters = gateway.getAdapters ? gateway.getAdapters() : [];
    for (const adapter of adapters) {
      if (!adapter || !adapter.listModels) continue;
      const adapterName = adapter.name || adapter.id || 'unknown';
      // Only query IDE adapters, not cloud ones
      if (!['cursor', 'trae', 'kiro', 'windsurf', 'vscode', 'warp'].includes(adapterName)) continue;
      try {
        const models = await adapter.listModels();
        for (const m of (models || [])) {
          result.ideModels.push({
            name: typeof m === 'string' ? m : (m.id || m.name || m.model),
            source: adapterName,
            available: true,
            route: `${adapterName}/${typeof m === 'string' ? m : (m.id || m.name)}`,
          });
        }
      } catch { /* adapter unavailable */ }
    }
  } catch { /* gateway not loaded */ }

  return result;
}

/**
 * Export an Ollama model to a local GGUF file for KHY use.
 * Ollama stores models as blobs — this finds the blob and copies/links it.
 *
 * @param {string} modelName - Ollama model name (e.g. "qwen3.5:4b")
 * @param {string} [destDir] - destination directory (default: KHY models/)
 * @returns {Promise<object>}
 */
async function exportFromOllama(modelName, destDir) {
  const dest = destDir || path.resolve(__dirname, '../../models');
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });

  // Find the model blob via ollama show
  try {
    const showResult = spawnSync('ollama', ['show', modelName, '--modelfile'], {
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });

    if (showResult.error) {
      return { success: false, error: `Ollama command failed: ${showResult.error.message}` };
    }

    const output = (showResult.stdout || '') + (showResult.stderr || '');

    // Extract FROM line which points to the blob
    const fromMatch = output.match(/^FROM\s+(.+)$/m);
    if (!fromMatch) {
      return { success: false, error: `Cannot find model file path in Ollama modelfile for ${modelName}` };
    }

    let blobPath = fromMatch[1].trim();

    // Ollama blob references are like /home/user/.ollama/models/blobs/sha256-xxx
    if (!fs.existsSync(blobPath)) {
      // Try resolving relative to ollama home
      const ollamaHome = path.join(os.homedir(), '.ollama');
      blobPath = path.resolve(ollamaHome, blobPath);
    }

    if (!fs.existsSync(blobPath)) {
      return { success: false, error: `Model blob not found at: ${blobPath}` };
    }

    // Determine output filename
    const safeName = String(modelName).replace(/[/:]/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
    const destFile = path.join(dest, `${safeName}-ollama.gguf`);

    // Create symlink (saves disk space) or copy (junction fallback on Windows)
    const { safeMklink } = require('../tools/platformUtils');
    try {
      if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
      safeMklink(blobPath, destFile);
    } catch {
      // Symlink/junction failed (e.g. cross-device), fall back to copy
      fs.copyFileSync(blobPath, destFile);
    }

    const stat = fs.statSync(destFile);
    return {
      success: true,
      model: modelName,
      path: destFile,
      sizeMB: Math.round(stat.size / (1024 * 1024)),
      message: `Exported ${modelName} to ${destFile}`,
    };
  } catch (err) {
    return { success: false, error: `Ollama export failed: ${err.message}` };
  }
}

module.exports = {
  importModel,
  importFromPath,
  importFromUrl,
  detectModelFormat,
  extractArchive,
  validateGguf,
  checkQwenPatching,
  applyQwenPatches,
  downloadFile,
  resolveModelUrl,
  scanForModelFiles,
  looksLikeModelPath,
  looksLikeModelUrl,
  getModelSearchDirs,
  listAllModels,
  discoverLocalModels,
  exportFromOllama,
};
