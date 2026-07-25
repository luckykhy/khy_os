/**
 * Local LLM Service — direct GGUF model inference
 *
 * Loads Qwen 3.5 4B (or other GGUF models) directly.
 * Strategy:
 *   1. Try ollama-runner (standalone, no Ollama service needed)
 *   2. Try node-llama-cpp (ESM, dynamic import)
 *   3. Fallback to Python inference_server.py (HTTP API at localhost:8765)
 *   4. Fallback to Ollama HTTP API (requires Ollama service)
 *
 * ollama-runner is the preferred backend because it uses Ollama's patched
 * llama.cpp which supports Qwen 3.5 hybrid SSM+Attention out of the box.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { safeKill } = require('../tools/platformUtils');
// Model-name SSOT: local-brain model id + GGUF artifact names flow from
// constants/models.js (env OLLAMA_MODEL still overrides the model id first).
const { PRIMARY: MODELS, LOCAL_BRAIN_GGUF_FILES } = require('../constants/models');

const _RAW_LOCAL_MODEL_PATH = String(process.env.LOCAL_MODEL_PATH || '').trim();
const LOCAL_MODEL_SCAN_CACHE_MS = Math.max(
  5000,
  parseInt(process.env.KHY_LOCAL_MODEL_SCAN_CACHE_MS || '30000', 10) || 30000
);
const LOCAL_MODEL_SCAN_MAX_DEPTH = Math.max(
  1,
  parseInt(process.env.KHY_LOCAL_MODEL_SCAN_MAX_DEPTH || '3', 10) || 3
);
const GGUF_MAGIC = Buffer.from('GGUF');
const MIN_LIKELY_GGUF_BLOB_SIZE = Math.max(
  16 * 1024 * 1024,
  parseInt(process.env.KHY_LOCAL_MIN_GGUF_BLOB_SIZE || String(64 * 1024 * 1024), 10) || (64 * 1024 * 1024)
);
const MODEL_IMPORTABLE_FILE_EXTENSIONS = new Set(['.safetensors']);
const MODEL_IMPORTABLE_ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.tgz', '.7z', '.tar.gz', '.rar']);
const MODEL_KNOWN_NON_RUNTIME_EXTENSIONS = new Set([
  '.safetensors', '.bin', '.pt', '.pth', '.ckpt', '.onnx', '.mlx', '.json', '.model',
]);
const OLLAMA_BLOB_NAME_RE = /^sha256[-:][a-f0-9]{32,}$/i;

let _modelArtifactScanCache = { at: 0, data: null };
let _modelAvailabilityState = {
  available: false,
  reason: 'not_checked',
  modelPath: '',
  runtime: null,
  importable: null,
  nonRuntime: null,
  artifactKind: null,
  artifactPath: null,
  importHint: null,
  lastError: null,
  checkedAt: 0,
  roots: [],
  scannedAt: 0,
};

function _getFileSizeSafe(filePath) {
  try {
    return fs.statSync(filePath).size || 0;
  } catch {
    return 0;
  }
}

function _hasGgufMagic(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return bytesRead === 4 && Buffer.compare(buf, GGUF_MAGIC) === 0;
  } catch {
    return false;
  }
}

function _cloneArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') return null;
  return {
    path: artifact.path || '',
    kind: artifact.kind || '',
    size: Number(artifact.size || 0),
  };
}

function _safeShortPath(filePath, max = 120) {
  const s = String(filePath || '').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return `...${s.slice(-(max - 3))}`;
}

function _buildImportHintFromArtifact(artifact) {
  if (!artifact || !artifact.path) {
    return '未发现可运行 GGUF 模型。可执行 khymodel import <path|url> 导入模型。';
  }

  const p = _safeShortPath(artifact.path);
  if (artifact.kind === 'safetensors_file' || artifact.kind === 'safetensors_dir') {
    return `已检测到 Safetensors 模型资源: ${p}。请先执行 khymodel import "${artifact.path}" 完成导入。`;
  }
  if (artifact.kind === 'model_archive') {
    return `已检测到模型压缩包: ${p}。请先执行 khymodel import "${artifact.path}" 解包并导入。`;
  }
  return `已检测到模型资源 (${artifact.kind}): ${p}。请先执行 khymodel import "${artifact.path}"。`;
}

function _buildModelImportCommand(modelPath) {
  const raw = String(modelPath || '').trim();
  if (!raw) return '';
  const escaped = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `khymodel import "${escaped}"`;
}

function _setModelAvailabilityState(next) {
  _modelAvailabilityState = {
    available: false,
    reason: 'not_checked',
    modelPath: _modelPath || '',
    runtime: null,
    importable: null,
    nonRuntime: null,
    artifactKind: null,
    artifactPath: null,
    importHint: null,
    lastError: null,
    checkedAt: Date.now(),
    roots: [],
    scannedAt: 0,
    ...(next || {}),
  };
  return _modelAvailabilityState;
}

function _updateArtifactCandidate(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  if ((next.size || 0) > (prev.size || 0)) return next;
  return prev;
}

function _scanModelArtifactsInDir(dirPath, depth, maxDepth, out, visitedDirs) {
  if (depth > maxDepth) return;
  let realDir = '';
  try { realDir = fs.realpathSync(dirPath); } catch { realDir = path.resolve(dirPath); }
  if (visitedDirs.has(realDir)) return;
  visitedDirs.add(realDir);

  let entries = [];
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { return; }

  // Directory-level detection for safetensors export/import directory.
  const names = entries.filter((e) => e.isFile()).map((e) => e.name.toLowerCase());
  const hasConfig = names.includes('config.json');
  const hasSafetensors = names.some((n) => n.endsWith('.safetensors'));
  if (hasSafetensors && hasConfig) {
    out.importable = _updateArtifactCandidate(out.importable, {
      path: dirPath,
      kind: 'safetensors_dir',
      size: 0,
    });
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      _scanModelArtifactsInDir(fullPath, depth + 1, maxDepth, out, visitedDirs);
      continue;
    }
    if (!entry.isFile()) continue;

    const lowerName = entry.name.toLowerCase();
    const ext = path.extname(lowerName);
    const size = _getFileSizeSafe(fullPath);

    const hasMagic = size > MIN_LIKELY_GGUF_BLOB_SIZE && _hasGgufMagic(fullPath);
    if (ext === '.gguf' || hasMagic) {
      const isLikelyBlobName = OLLAMA_BLOB_NAME_RE.test(lowerName) || ext === '';
      const kind = ext === '.gguf'
        ? 'gguf'
        : (isLikelyBlobName ? 'gguf_blob' : 'gguf_magic');
      out.runtime = _updateArtifactCandidate(out.runtime, { path: fullPath, kind, size });
      continue;
    }

    if (MODEL_IMPORTABLE_FILE_EXTENSIONS.has(ext)) {
      out.importable = _updateArtifactCandidate(out.importable, {
        path: fullPath,
        kind: 'safetensors_file',
        size,
      });
      continue;
    }

    const archiveExt = lowerName.endsWith('.tar.gz')
      ? '.tar.gz'
      : ext;
    if (MODEL_IMPORTABLE_ARCHIVE_EXTENSIONS.has(archiveExt)) {
      out.importable = _updateArtifactCandidate(out.importable, {
        path: fullPath,
        kind: 'model_archive',
        size,
      });
      continue;
    }

    if (MODEL_KNOWN_NON_RUNTIME_EXTENSIONS.has(ext)) {
      out.nonRuntime = _updateArtifactCandidate(out.nonRuntime, {
        path: fullPath,
        kind: ext.replace('.', '') || 'unknown',
        size,
      });
    }
  }
}

function discoverModelArtifacts(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _modelArtifactScanCache.data && (now - _modelArtifactScanCache.at) < LOCAL_MODEL_SCAN_CACHE_MS) {
    return _modelArtifactScanCache.data;
  }

  const roots = _buildModelSearchRoots();
  // Include Ollama blob storage explicitly to support exported/imported blob files.
  roots.push(..._getOllamaBlobRoots());
  const dedupRoots = [...new Set(roots.map((r) => path.resolve(r)))];
  const scanOut = { runtime: null, importable: null, nonRuntime: null };
  const visitedDirs = new Set();

  for (const root of dedupRoots) {
    if (!fs.existsSync(root)) continue;
    _scanModelArtifactsInDir(root, 0, LOCAL_MODEL_SCAN_MAX_DEPTH, scanOut, visitedDirs);
  }

  const data = {
    runtime: scanOut.runtime,
    importable: scanOut.importable,
    nonRuntime: scanOut.nonRuntime,
    roots: dedupRoots,
    scannedAt: now,
  };
  _modelArtifactScanCache = { at: now, data };
  return data;
}

function _buildModelSearchRoots() {
  const roots = [];
  const seen = new Set();
  const pushRoot = (candidate) => {
    if (!candidate) return;
    const full = path.resolve(candidate);
    if (seen.has(full)) return;
    seen.add(full);
    roots.push(full);
  };

  const backendRoot = path.resolve(__dirname, '../..');
  const repoRoot = path.resolve(__dirname, '../../..');
  pushRoot(path.join(backendRoot, 'models'));
  pushRoot(path.join(repoRoot, 'backend', 'models'));
  pushRoot(path.join(process.cwd(), 'backend', 'models'));
  pushRoot(path.join(process.cwd(), 'models'));

  const runtimeRoot = String(process.env.KHYQUANT_ROOT || '').trim();
  if (runtimeRoot) {
    const rr = path.resolve(runtimeRoot);
    pushRoot(path.join(rr, 'models'));
    pushRoot(path.join(rr, '..', 'backend', 'models'));
    pushRoot(path.join(rr, '..', 'models'));
  }

  const envFile = String(process.env.KHY_ENV_FILE || '').trim();
  if (envFile) {
    const envDir = path.dirname(path.resolve(envFile));
    pushRoot(path.join(envDir, 'models'));
    pushRoot(path.join(envDir, '..', 'backend', 'models'));
    pushRoot(path.join(envDir, '..', 'models'));
  }

  const dataHomeEnv = String(process.env.KHY_DATA_HOME || '').trim();
  if (dataHomeEnv) {
    pushRoot(path.join(path.resolve(dataHomeEnv), 'models'));
  }
  pushRoot(path.join(os.homedir(), '.khy', 'models'));
  pushRoot(path.join(os.homedir(), '.khyquant', 'models'));

  return roots;
}

function _getOllamaBlobRoots() {
  const roots = [];
  const pushRoot = (candidate) => {
    if (!candidate) return;
    roots.push(path.resolve(candidate));
  };

  const ollamaModelsEnv = String(process.env.OLLAMA_MODELS || '').trim();
  if (ollamaModelsEnv) {
    const resolved = path.resolve(ollamaModelsEnv);
    const base = path.basename(resolved).toLowerCase();
    if (base === 'blobs') {
      pushRoot(resolved);
    } else if (base === 'models') {
      pushRoot(path.join(resolved, 'blobs'));
    } else {
      pushRoot(path.join(resolved, 'blobs'));
      pushRoot(resolved);
    }
  }

  pushRoot(path.join(os.homedir(), '.ollama', 'models', 'blobs'));
  return roots;
}

function _scanModelPathByName(preferredName = '') {
  const targetName = String(preferredName || '').trim();
  const roots = _buildModelSearchRoots();
  const preferredNames = [
    targetName,
    ...LOCAL_BRAIN_GGUF_FILES,
  ].filter(Boolean);

  for (const root of roots) {
    for (const filename of preferredNames) {
      const full = path.join(root, filename);
      if (fs.existsSync(full)) return full;
    }
  }

  // Final fallback: pick the largest *.gguf under known model roots.
  let largestPath = '';
  let largestSize = 0;
  for (const root of roots) {
    let files = [];
    try { files = fs.readdirSync(root); } catch { files = []; }
    for (const filename of files) {
      if (!/\.gguf$/i.test(filename)) continue;
      const full = path.join(root, filename);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.size > largestSize) {
          largestSize = stat.size;
          largestPath = full;
        }
      } catch { /* best effort */ }
    }
  }
  return largestPath || '';
}

function resolveLocalModelPath(rawPath = '') {
  const text = String(rawPath || '').trim();
  if (!text) return path.join(__dirname, `../../models/${LOCAL_BRAIN_GGUF_FILES[0]}`);
  if (path.isAbsolute(text)) return text;

  // Resolve relative paths against multiple stable roots to avoid CWD-dependent false negatives.
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (candidate) => {
    const full = path.resolve(candidate);
    if (seen.has(full)) return;
    seen.add(full);
    candidates.push(full);
  };

  // Common roots:
  // 1) backend root
  // 2) repo root
  // 3) runtime root from launcher env
  const backendRoot = path.resolve(__dirname, '../..');
  const repoRoot = path.resolve(__dirname, '../../..');
  pushCandidate(path.join(backendRoot, text));
  pushCandidate(path.join(repoRoot, text));

  const runtimeRoot = String(process.env.KHYQUANT_ROOT || '').trim();
  if (runtimeRoot) {
    pushCandidate(path.join(runtimeRoot, text));
    pushCandidate(path.join(path.resolve(runtimeRoot, '..'), text));
  }

  const envFile = String(process.env.KHY_ENV_FILE || '').trim();
  if (envFile) {
    const envDir = path.dirname(path.resolve(envFile));
    pushCandidate(path.join(envDir, text));
    pushCandidate(path.join(path.resolve(envDir, '..'), text));
  }

  for (const full of candidates) {
    if (fs.existsSync(full)) return full;
  }

  // Scan known model directories by filename if direct relative matches failed.
  const scanned = _scanModelPathByName(path.basename(text));
  if (scanned) return scanned;

  // Fallback: keep legacy CWD-relative behavior for compatibility.
  return path.resolve(process.cwd(), text);
}
const DEFAULT_MODEL_PATH = resolveLocalModelPath(_RAW_LOCAL_MODEL_PATH);
// Also check the Ollama-format model (symlink to blob, works with ollama-runner)
const OLLAMA_MODEL_PATH = path.join(__dirname, `../../models/${LOCAL_BRAIN_GGUF_FILES[1]}`);
// Also check the export model
const EXPORT_MODEL_PATH = path.join(__dirname, `../../models/${LOCAL_BRAIN_GGUF_FILES[2]}`);
const { OLLAMA_HOST, INFERENCE_SERVER_PORT } = require('../constants/serviceDefaults');
const INFERENCE_SERVER_URL = `http://127.0.0.1:${INFERENCE_SERVER_PORT}`;
const OLLAMA_RUNNER_PORT = parseInt(process.env.OLLAMA_RUNNER_PORT || '8767', 10);
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || MODELS.localBrain;
let _autoLocalAiEnv = null;
function _getAutoLocalAiEnv() {
  if (_autoLocalAiEnv) return _autoLocalAiEnv;
  try {
    const hw = require('./hardwareProfileService');
    const tuning = hw && typeof hw.recommendLocalAiTuning === 'function'
      ? hw.recommendLocalAiTuning('auto')
      : null;
    _autoLocalAiEnv = (tuning && tuning.env) ? tuning.env : {};
  } catch {
    _autoLocalAiEnv = {};
  }
  return _autoLocalAiEnv;
}
function _envIntWithAuto(key, hardDefault) {
  const raw = process.env[key];
  if (raw !== undefined && String(raw).trim() !== '') {
    const parsed = parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const auto = parseInt(String(_getAutoLocalAiEnv()[key] || ''), 10);
  if (Number.isFinite(auto)) return auto;
  return hardDefault;
}
const RUNNER_HEALTH_TIMEOUT_MS = Math.max(
  300,
  _envIntWithAuto('KHY_LOCAL_RUNNER_HEALTH_TIMEOUT_MS', 1200)
);
const RUNNER_START_TIMEOUT_MS = Math.max(
  3000,
  _envIntWithAuto('KHY_LOCAL_RUNNER_START_TIMEOUT_MS', 15000)
);
const RUNNER_LOAD_TIMEOUT_MS = Math.max(
  10000,
  _envIntWithAuto('KHY_LOCAL_RUNNER_LOAD_TIMEOUT_MS', 120000)
);
const RUNNER_HOT_ATTACH_TIMEOUT_MS = Math.max(
  200,
  _envIntWithAuto('KHY_LOCAL_HOT_ATTACH_TIMEOUT_MS', 900)
);

function resolveOllamaBinary() {
  const envBin = String(process.env.OLLAMA_BIN || '').trim();
  if (envBin) return envBin;

  // Bundled runner inside the project (no system ollama install needed).
  // POSIX archives lay the binary under bin/ollama-runner/bin/ollama; the
  // Windows zip ships ollama.exe at the runner root (bin/ollama-runner/ollama.exe).
  // Provisioning (runtimeProvisioner) preserves the upstream layout, so probe both.
  const runnerRoot = path.join(__dirname, '../../bin/ollama-runner');
  const bundledBase = path.join(runnerRoot, 'bin');
  const bundledCandidates = process.platform === 'win32'
    ? [
        path.join(bundledBase, 'ollama.exe'),
        path.join(runnerRoot, 'ollama.exe'),
        path.join(bundledBase, 'ollama'),
        path.join(runnerRoot, 'ollama'),
      ]
    : [path.join(bundledBase, 'ollama'), path.join(runnerRoot, 'ollama')];
  for (const candidate of bundledCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // System-installed fallback
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const candidates = [
      path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(programFiles, 'Ollama', 'ollama.exe'),
      'ollama.exe',
      'ollama',
    ];
    for (const p of candidates) {
      if (p.includes('\\') || p.includes('/')) {
        if (fs.existsSync(p)) return p;
      } else {
        return p; // PATH command candidate
      }
    }
  } else {
    const candidates = [
      '/usr/local/bin/ollama',
      '/usr/bin/ollama',
      '/opt/homebrew/bin/ollama',
      'ollama',
    ];
    for (const p of candidates) {
      if (p.startsWith('/')) {
        if (fs.existsSync(p)) return p;
      } else {
        return p; // PATH command candidate
      }
    }
  }

  return process.platform === 'win32' ? 'ollama.exe' : 'ollama';
}

function resolvePythonLauncher() {
  const envCmd = String(process.env.KHY_PYTHON_BIN || '').trim();
  const candidates = [];
  if (envCmd) candidates.push({ cmd: envCmd, preArgs: [] });
  if (process.platform === 'win32') {
    candidates.push({ cmd: 'python', preArgs: [] });
    candidates.push({ cmd: 'py', preArgs: ['-3'] });
  } else {
    candidates.push({ cmd: 'python3', preArgs: [] });
    candidates.push({ cmd: 'python', preArgs: [] });
  }

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate.cmd, [...candidate.preArgs, '--version'], {
        stdio: 'ignore',
        timeout: 3000,
        windowsHide: true,
      });
      if (!probe.error && probe.status === 0) return candidate;
    } catch { /* keep probing */ }
  }

  // Return the first candidate even if not verified, so downstream error is explicit.
  return candidates[0];
}

function terminateChildTree(child) {
  safeKill(child);
}

const OLLAMA_BIN = resolveOllamaBinary();
const PYTHON_LAUNCHER = resolvePythonLauncher();

let _modelPath = DEFAULT_MODEL_PATH;
let _backend = null; // 'ollama-runner' | 'node-llama-cpp' | 'python-server' | 'ollama' | null
let _llama = null;
let _model = null;
let _context = null;
let _loadingPromise = null;
let _lastError = null;
// Structured diagnosis for a model-load incompatibility (e.g. the built-in
// llama.cpp cannot parse a newer GGUF). Preserved across the backend
// fallthrough so the final error is actionable instead of a bare timeout.
let _modelLoadDiagnosis = null;
let _pythonProcess = null;
let _runnerProcess = null;
let _runnerReady = false;
let _pythonLlamaCppAvailable = null;
let _pythonLlamaCppError = '';
let _loopbackListenProbe = { ok: null, at: 0, error: '' };
const LOCAL_LLM_VERBOSE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.KHY_LOCAL_LLM_VERBOSE || '').toLowerCase()
);
const NODE_LLAMA_CPP_LOG_SILENT = String(process.env.KHY_NODE_LLAMA_CPP_LOG_SILENT || 'true').toLowerCase() !== 'false';

function localLLMLog(message) {
  if (!LOCAL_LLM_VERBOSE) return;
  console.log(message);
}

function _resolveModelAvailability(forceRefresh = false) {
  const now = Date.now();
  const baseRoots = _buildModelSearchRoots();
  const directRoots = [...baseRoots, ..._getOllamaBlobRoots()]
    .map((r) => path.resolve(r));

  try {
    if (_modelPath && fs.existsSync(_modelPath)) {
      const runtime = { path: _modelPath, kind: 'configured_path', size: _getFileSizeSafe(_modelPath) };
      _setModelAvailabilityState({
        available: true,
        reason: 'configured_path',
        modelPath: _modelPath,
        runtime,
        artifactKind: runtime.kind,
        artifactPath: runtime.path,
        importHint: null,
        checkedAt: now,
        roots: directRoots,
        scannedAt: now,
      });
      return true;
    }

    if (fs.existsSync(OLLAMA_MODEL_PATH)) {
      _modelPath = OLLAMA_MODEL_PATH;
      const runtime = { path: _modelPath, kind: 'ollama_symlink', size: _getFileSizeSafe(_modelPath) };
      _setModelAvailabilityState({
        available: true,
        reason: 'ollama_symlink',
        modelPath: _modelPath,
        runtime,
        artifactKind: runtime.kind,
        artifactPath: runtime.path,
        importHint: null,
        checkedAt: now,
        roots: directRoots,
        scannedAt: now,
      });
      return true;
    }

    if (fs.existsSync(EXPORT_MODEL_PATH)) {
      _modelPath = EXPORT_MODEL_PATH;
      const runtime = { path: _modelPath, kind: 'export_model', size: _getFileSizeSafe(_modelPath) };
      _setModelAvailabilityState({
        available: true,
        reason: 'export_model',
        modelPath: _modelPath,
        runtime,
        artifactKind: runtime.kind,
        artifactPath: runtime.path,
        importHint: null,
        checkedAt: now,
        roots: directRoots,
        scannedAt: now,
      });
      return true;
    }
  } catch {
    // Fall through to scanning path; scan state will capture details.
  }

  try {
    const scan = discoverModelArtifacts(forceRefresh);
    const runtime = _cloneArtifact(scan.runtime);
    const importable = _cloneArtifact(scan.importable);
    const nonRuntime = _cloneArtifact(scan.nonRuntime);
    const roots = Array.isArray(scan.roots) ? scan.roots : directRoots;
    const scannedAt = Number(scan.scannedAt || now);

    if (runtime && runtime.path && fs.existsSync(runtime.path)) {
      _modelPath = runtime.path;
      _setModelAvailabilityState({
        available: true,
        reason: 'scan_runtime',
        modelPath: _modelPath,
        runtime,
        importable,
        nonRuntime,
        artifactKind: runtime.kind || 'gguf',
        artifactPath: runtime.path,
        importHint: null,
        checkedAt: now,
        roots,
        scannedAt,
      });
      return true;
    }

    if (importable) {
      _setModelAvailabilityState({
        available: false,
        reason: 'importable_only',
        modelPath: _modelPath,
        runtime: null,
        importable,
        nonRuntime,
        artifactKind: importable.kind || 'importable',
        artifactPath: importable.path || '',
        importHint: _buildImportHintFromArtifact(importable),
        importCommand: _buildModelImportCommand(importable.path || ''),
        checkedAt: now,
        roots,
        scannedAt,
      });
      return false;
    }

    if (nonRuntime) {
      _setModelAvailabilityState({
        available: false,
        reason: 'non_runtime_only',
        modelPath: _modelPath,
        runtime: null,
        importable: null,
        nonRuntime,
        artifactKind: nonRuntime.kind || 'non_runtime',
        artifactPath: nonRuntime.path || '',
        importHint: `已检测到非 GGUF 模型文件: ${_safeShortPath(nonRuntime.path)}。本地直连推理仅支持 GGUF。`,
        importCommand: '',
        checkedAt: now,
        roots,
        scannedAt,
      });
      return false;
    }

    _setModelAvailabilityState({
      available: false,
      reason: 'not_found',
      modelPath: _modelPath,
      runtime: null,
      importable: null,
      nonRuntime: null,
      artifactKind: null,
      artifactPath: '',
      importHint: '未发现可运行 GGUF 模型。可将 GGUF 或 Ollama 导出的模型文件拖入 models 目录，或执行 khymodel import <path|url>。',
      importCommand: '',
      checkedAt: now,
      roots,
      scannedAt,
    });
    return false;
  } catch (err) {
    _setModelAvailabilityState({
      available: false,
      reason: 'scan_error',
      modelPath: _modelPath,
      runtime: null,
      importable: null,
      nonRuntime: null,
      artifactKind: null,
      artifactPath: '',
      importHint: '模型目录扫描失败，请检查目录权限或路径配置。',
      importCommand: '',
      lastError: err && err.message ? err.message : String(err || 'scan failed'),
      checkedAt: now,
      roots: directRoots,
      scannedAt: now,
    });
    return false;
  }
}

async function _withNodeLlamaCppLogSilenced(task) {
  if (!NODE_LLAMA_CPP_LOG_SILENT || typeof task !== 'function') return task();
  const originalStderrWrite = process.stderr && process.stderr.write;
  if (typeof originalStderrWrite !== 'function') return task();

  const prefix = '[node-llama-cpp]';
  process.stderr.write = function patchedStderrWrite(chunk, encoding, callback) {
    const text = typeof chunk === 'string'
      ? chunk
      : (Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk || ''));
    const isNodeLlamaLog = text.startsWith(prefix);
    if (!isNodeLlamaLog) {
      return originalStderrWrite.call(this, chunk, encoding, callback);
    }
    if (typeof encoding === 'function') {
      try { encoding(); } catch { /* best effort */ }
    } else if (typeof callback === 'function') {
      try { callback(); } catch { /* best effort */ }
    }
    return true;
  };

  try {
    return await task();
  } finally {
    process.stderr.write = originalStderrWrite;
  }
}

async function canListenLoopback(forceRefresh = false) {
  const ttlMs = Math.max(
    1000,
    parseInt(process.env.KHY_LOCAL_LOOPBACK_PROBE_TTL_MS || '30000', 10) || 30000
  );
  const timeoutMs = Math.max(
    300,
    parseInt(process.env.KHY_LOCAL_LOOPBACK_PROBE_TIMEOUT_MS || '1200', 10) || 1200
  );

  if (!forceRefresh && _loopbackListenProbe.ok !== null && (Date.now() - _loopbackListenProbe.at) < ttlMs) {
    return _loopbackListenProbe.ok;
  }

  const result = await new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (ok, errMsg = '') => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch { /* ignore */ }
      resolve({ ok, error: errMsg });
    };

    server.once('error', (err) => {
      finish(false, err && err.message ? err.message : String(err || 'loopback listen failed'));
    });
    server.listen(0, '127.0.0.1', () => finish(true, ''));

    const timer = setTimeout(() => finish(false, 'loopback listen probe timed out'), timeoutMs);
    timer.unref?.();
  });

  _loopbackListenProbe = { ok: !!result.ok, at: Date.now(), error: String(result.error || '') };
  return _loopbackListenProbe.ok;
}

/**
 * Check if model file exists (checks default, Ollama-format, and export paths).
 */
function isModelAvailable(forceRefresh = false) {
  const refresh = typeof forceRefresh === 'object'
    ? !!forceRefresh.forceRefresh
    : !!forceRefresh;
  return _resolveModelAvailability(refresh);
}

/**
 * Find the best model path for ollama-runner.
 * Prefers Ollama-format GGUF (blob symlink) as it works without patches.
 */
function findRunnerModelPath() {
  // Ollama blob format works directly with ollama-runner (no tensor renaming needed)
  if (fs.existsSync(OLLAMA_MODEL_PATH)) return OLLAMA_MODEL_PATH;
  if (_resolveModelAvailability(false) && fs.existsSync(_modelPath)) return _modelPath;

  // Fallback to export model (may need patches for upstream llama.cpp, but works with ollama-runner)
  if (fs.existsSync(EXPORT_MODEL_PATH)) return EXPORT_MODEL_PATH;
  if (fs.existsSync(DEFAULT_MODEL_PATH)) return DEFAULT_MODEL_PATH;
  return _modelPath;
}

/**
 * Check if ollama binary supports the `runner` subcommand.
 * @param {string} [binPath=OLLAMA_BIN] - binary to probe; defaults to the
 *   module-load resolution. An explicit path is passed after on-demand
 *   provisioning, when OLLAMA_BIN (resolved at load time) may be stale.
 */
function isOllamaRunnerAvailable(binPath = OLLAMA_BIN) {
  try {
    // runner --help prints to stderr, so we need to capture both
    const result = spawnSync(binPath, ['runner', '--help'], {
      timeout: 3000,
      encoding: 'utf-8',
      windowsHide: true,
    });
    const output = (result.stdout || '') + (result.stderr || '');
    return output.includes('-model') || output.includes('Runner');
  } catch {
    return false;
  }
}

/**
 * Fast preflight: verify Python has llama-cpp-python importable.
 * Avoid waiting up to 60s on a detached server process that exits immediately.
 */
function isPythonLlamaCppAvailable(forceRefresh = false) {
  if (!forceRefresh && _pythonLlamaCppAvailable !== null) return _pythonLlamaCppAvailable;
  try {
    execFileSync(PYTHON_LAUNCHER.cmd, [...PYTHON_LAUNCHER.preArgs, '-c', 'import llama_cpp'], {
      stdio: 'ignore',
      timeout: 4000,
      env: process.env,
    });
    _pythonLlamaCppAvailable = true;
    _pythonLlamaCppError = '';
    return true;
  } catch (err) {
    _pythonLlamaCppAvailable = false;
    _pythonLlamaCppError = err.message || String(err || 'llama_cpp import failed');
    return false;
  }
}

/**
 * HTTP helper for ollama-runner (raw HTTP, streams NDJSON).
 * @param {number} port
 * @param {string} urlPath
 * @param {object} body
 * @param {object} [streamOpts] - { onChunk, timeoutMs }
 */
function runnerPost(port, urlPath, body, streamOpts = {}) {
  const timeoutMs = streamOpts.timeoutMs || 60_000;
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    let lastActivity = Date.now();

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    }, (res) => {
      const parsed = [];
      let partialLine = '';

      // Idle timer: abort if no data received for 30s during inference
      const idleLimit = 30_000;
      const idleCheck = setInterval(() => {
        if (Date.now() - lastActivity > idleLimit) {
          clearInterval(idleCheck);
          req.destroy(new Error('Runner inference stalled (no output for 30s)'));
        }
      }, 5000);
      if (idleCheck.unref) idleCheck.unref();

      res.on('data', chunk => {
        lastActivity = Date.now();
        partialLine += chunk.toString('utf-8');

        // Parse complete NDJSON lines as they arrive
        const lines = partialLine.split('\n');
        partialLine = lines.pop(); // keep incomplete last line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            parsed.push(obj);
            // Stream text chunks to caller immediately
            if (streamOpts.onChunk && obj.content) {
              streamOpts.onChunk({ type: 'text', text: obj.content });
            }
          } catch { /* skip malformed */ }
        }
      });

      res.on('end', () => {
        clearInterval(idleCheck);
        // Parse any remaining partial line
        if (partialLine.trim()) {
          try {
            const obj = JSON.parse(partialLine.trim());
            parsed.push(obj);
            if (streamOpts.onChunk && obj.content) {
              streamOpts.onChunk({ type: 'text', text: obj.content });
            }
          } catch { /* skip */ }
        }
        const raw = parsed.map(p => JSON.stringify(p)).join('\n');
        resolve({ status: res.statusCode, data: parsed, raw });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Runner request timeout')); });
    req.write(data);
    req.end();
  });
}

function runnerGet(port, urlPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method: 'GET',
      timeout: Math.max(200, Number(timeoutMs) || 5000),
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function _isRunnerHealthReady(data) {
  if (!data || typeof data !== 'object') return false;
  const status = data.status;
  const progress = Number(data.progress);
  const readyByStatus = status === 0
    || status === '0'
    || String(status || '').toLowerCase() === 'ready'
    || String(status || '').toLowerCase() === 'ok';
  if (!readyByStatus) return false;
  // Some runner builds may omit progress; treat missing progress as ready.
  if (!Number.isFinite(progress)) return true;
  return progress >= 1;
}

async function tryAdoptHotRunner(options = {}) {
  if (_backend && _backend !== 'ollama-runner') {
    return { adopted: false, ready: false, listening: false, reason: `backend already loaded: ${_backend}` };
  }
  const timeoutMs = Math.max(
    200,
    parseInt(options.timeoutMs || process.env.KHY_LOCAL_HOT_ATTACH_TIMEOUT_MS || String(RUNNER_HOT_ATTACH_TIMEOUT_MS), 10)
      || RUNNER_HOT_ATTACH_TIMEOUT_MS
  );
  try {
    const res = await runnerGet(OLLAMA_RUNNER_PORT, '/health', timeoutMs);
    if (res.status !== 200) {
      return { adopted: false, ready: false, listening: false, reason: `health ${res.status}` };
    }
    const health = (res && typeof res.data === 'object' && res.data) ? res.data : {};
    const ready = _isRunnerHealthReady(health);
    if (!ready) {
      _runnerReady = false;
      return { adopted: false, ready: false, listening: true, health };
    }
    _runnerReady = true;
    _backend = 'ollama-runner';
    _lastError = null;
    return { adopted: true, ready: true, listening: true, health };
  } catch (err) {
    return { adopted: false, ready: false, listening: false, reason: String(err && err.message ? err.message : err || 'unknown') };
  }
}

/**
 * Check if ollama-runner is healthy and model is loaded.
 * Runner health returns: status 0 = ready, 2 = launched, 3 = loading
 */
async function isRunnerReady() {
  try {
    const res = await runnerGet(
      OLLAMA_RUNNER_PORT,
      '/health',
      parseInt(process.env.KHY_LOCAL_RUNNER_HEALTH_TIMEOUT_MS || String(RUNNER_HEALTH_TIMEOUT_MS), 10) || RUNNER_HEALTH_TIMEOUT_MS
    );
    if (res.status !== 200) return false;
    const data = typeof res.data === 'object' ? res.data : {};
    return _isRunnerHealthReady(data);
  } catch {
    return false;
  }
}

/**
 * Check if ollama-runner is at least listening (not necessarily model loaded).
 */
async function isRunnerListening() {
  try {
    const res = await runnerGet(
      OLLAMA_RUNNER_PORT,
      '/health',
      parseInt(process.env.KHY_LOCAL_RUNNER_HEALTH_TIMEOUT_MS || String(RUNNER_HEALTH_TIMEOUT_MS), 10) || RUNNER_HEALTH_TIMEOUT_MS
    );
    return res.status === 200;
  } catch {
    return false;
  }
}

async function _loadRunnerModel(options = {}) {
  const requireChildAlive = options.requireChildAlive !== false;
  const loadTimeoutMs = Math.max(
    10000,
    parseInt(process.env.KHY_LOCAL_RUNNER_LOAD_TIMEOUT_MS || String(RUNNER_LOAD_TIMEOUT_MS), 10) || RUNNER_LOAD_TIMEOUT_MS
  );

    const numCPU = os.cpus().length;
  const loadRes = await runnerPost(OLLAMA_RUNNER_PORT, '/load', {
    Operation: 2, // LoadOperationCommit
    KvSize: 8192,
    BatchSize: 512,
    Parallel: 1,
    NumThreads: Math.max(1, Math.floor(numCPU * 0.75)),
    MultiUserCache: false,
  });

  if (loadRes.status !== 200) {
    localLLMLog(`[LocalLLM] Runner load failed: ${loadRes.raw?.slice(0, 300)}`);
    return false;
  }

  // Wait for model to be fully loaded
  // Runner health: status 0 = ready, 2 = launched, 3 = loading
  const loadDeadline = Date.now() + loadTimeoutMs;
  while (Date.now() < loadDeadline) {
    await new Promise(r => setTimeout(r, 1000));
    if (await isRunnerReady()) {
      _runnerReady = true;
      localLLMLog('[LocalLLM] Ollama runner model loaded successfully!');
      return true;
    }
    if (requireChildAlive && !_runnerProcess) {
      localLLMLog('[LocalLLM] Runner process died during model loading');
      return false;
    }
  }

  localLLMLog('[LocalLLM] Runner model loading timed out');
  return false;
}

/**
 * Start ollama runner as standalone subprocess and load the model.
 * Uses --ollama-engine flag to enable the Go-native engine (supports Qwen 3.5).
 */
async function startOllamaRunner(options = {}) {
  const allowSpawn = options.allowSpawn !== false;

  const adopted = await tryAdoptHotRunner({
    timeoutMs: parseInt(
      process.env.KHY_LOCAL_HOT_ATTACH_TIMEOUT_MS || String(RUNNER_HOT_ATTACH_TIMEOUT_MS),
      10
    ) || RUNNER_HOT_ATTACH_TIMEOUT_MS,
  });
  if (adopted.adopted) {
    localLLMLog('[LocalLLM] Reusing hot ollama-runner backend');
    return true;
  }

  const runnerListening = adopted.listening || await isRunnerListening();
  if (runnerListening) {
    localLLMLog('[LocalLLM] Existing ollama-runner detected; issuing model load...');
    try {
      if (await _loadRunnerModel({ requireChildAlive: false })) {
        _backend = 'ollama-runner';
        _lastError = null;
        return true;
      }
    } catch (err) {
      localLLMLog(`[LocalLLM] Existing runner load request failed: ${err.message}`);
    }
  }

  if (!allowSpawn) {
    localLLMLog('[LocalLLM] Loopback listen unavailable; skip spawning new ollama-runner process');
    return false;
  }

  // Provision the bundled ollama runner on first use if it isn't on disk yet.
  // The binaries are untracked from git and fetched on demand (per-platform,
  // SHA256-verified) into bin/ollama-runner — see runtimeProvisioner and
  // config/runtime-binaries.json. Never throws; on any failure we fall through
  // to the system-binary resolution baked into resolveOllamaBinary(). Because
  // OLLAMA_BIN was resolved at module-load time (before any fetch), re-resolve
  // here so a freshly provisioned binary is actually used.
  await require('./runtimeProvisioner').ensureRuntime('ollama-runner').catch(() => null);
  const ollamaBin = resolveOllamaBinary();

  if (!isOllamaRunnerAvailable(ollamaBin)) {
    localLLMLog('[LocalLLM] ollama binary does not support runner subcommand');
    return false;
  }

  const runnerModelPath = findRunnerModelPath();
  if (!fs.existsSync(runnerModelPath)) {
    localLLMLog('[LocalLLM] No suitable model file found for ollama-runner');
    return false;
  }

  try {
    localLLMLog(`[LocalLLM] Starting ollama runner on port ${OLLAMA_RUNNER_PORT}...`);
    localLLMLog(`[LocalLLM] Model: ${runnerModelPath}`);

    _runnerProcess = spawn(ollamaBin, [
      'runner',
      '--ollama-engine',  // Use Go-native engine (supports qwen35/qwen3next)
      '--model', runnerModelPath,
      '--port', String(OLLAMA_RUNNER_PORT),
    ], {
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OLLAMA_LOG_LEVEL: 'warn' },
      windowsHide: true,
    });

    // Collect stderr for debugging — log all output in first 30s for diagnostics
    let stderrBuf = '';
    const runnerStartTime = Date.now();
    _runnerProcess.stderr.on('data', (data) => {
      const line = data.toString();
      stderrBuf += line;
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048);
      // Always log during startup phase (first 30s) or on important keywords
      const isStartup = Date.now() - runnerStartTime < 30000;
      if (isStartup || line.includes('error') || line.includes('listening') || line.includes('loaded') || line.includes('ASSERT') || line.includes('fail')) {
        localLLMLog(`[OllamaRunner] ${line.trim()}`);
      }
    });

    _runnerProcess.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) localLLMLog(`[OllamaRunner:stdout] ${line}`);
    });

    _runnerProcess.on('exit', (code) => {
      localLLMLog(`[OllamaRunner] Process exited with code ${code}`);
      if (code !== 0 && stderrBuf) localLLMLog(`[OllamaRunner] Last stderr: ${stderrBuf.slice(-500)}`);
      _runnerProcess = null;
      _runnerReady = false;
    });

    _runnerProcess.unref();

    // Wait for server to come online (just listening, not model loaded yet)
    const startTimeoutMs = Math.max(
      3000,
      parseInt(process.env.KHY_LOCAL_RUNNER_START_TIMEOUT_MS || String(RUNNER_START_TIMEOUT_MS), 10) || RUNNER_START_TIMEOUT_MS
    );
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400));
      if (await isRunnerListening()) {
        localLLMLog('[LocalLLM] Ollama runner is online, loading model...');
        break;
      }
    }

    if (!(await isRunnerListening())) {
      localLLMLog('[LocalLLM] Ollama runner failed to start');
      if (_runnerProcess) terminateChildTree(_runnerProcess);
      _runnerProcess = null;
      return false;
    }

    if (!(await _loadRunnerModel({ requireChildAlive: true }))) {
      if (_runnerProcess) {
        terminateChildTree(_runnerProcess);
        _runnerProcess = null;
      }
      return false;
    }
    _backend = 'ollama-runner';
    _lastError = null;
    return true;
  } catch (err) {
    localLLMLog(`[LocalLLM] Failed to start ollama runner: ${err.message}`);
    _lastError = err;
    return false;
  }
}

/**
 * Generate via ollama-runner (standalone process).
 * Runner uses the same completion API as Ollama's internal runner protocol.
 *
 * Qwen 3.5 thinking mode is always active (runner doesn't support /no_think).
 * The <think>...</think> block is parsed out and returned separately.
 * Local model — no token billing, generous budget allocated.
 */
async function generateRunner(prompt, options) {
  // Build ChatML prompt from messages
  let fullPrompt = prompt;
  if (options.messages && Array.isArray(options.messages) && options.messages.length > 0) {
    const parts = [];
    if (options.system) {
      parts.push(`<|im_start|>system\n${options.system}<|im_end|>`);
    }
    for (const msg of options.messages) {
      if (msg.role === 'user') {
        parts.push(`<|im_start|>user\n${msg.content}<|im_end|>`);
      } else if (msg.role === 'assistant') {
        parts.push(`<|im_start|>assistant\n${msg.content}<|im_end|>`);
      } else if (msg.role === 'tool') {
        parts.push(`<|im_start|>user\n[Tool Results]: ${msg.content}<|im_end|>`);
      }
    }
    parts.push(`<|im_start|>assistant\n`);
    fullPrompt = parts.join('\n');
  } else if (options.system) {
    fullPrompt = `<|im_start|>system\n${options.system}<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`;
  } else if (prompt) {
    fullPrompt = `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`;
  }

  // Local model: reasonable token budget (avoid excessive thinking on simple queries)
  const numPredict = options.maxTokens ?? 1024;
  const inferenceTimeout = options.timeoutMs ?? 60_000;

  const res = await runnerPost(OLLAMA_RUNNER_PORT, '/completion', {
    Prompt: fullPrompt,
    Options: {
      temperature: options.temperature ?? 0.6,
      top_p: options.top_p ?? 0.85,
      num_predict: numPredict,
      stop: ['<|im_end|>', '<|endoftext|>'],
    },
  }, {
    onChunk: options.onChunk,
    timeoutMs: inferenceTimeout,
  });

  if (res.status !== 200) {
    throw new Error(`Runner completion failed: ${res.raw?.slice(0, 300)}`);
  }

  // Collect content from streamed NDJSON responses and token stats
  let rawContent = '';
  let promptEvalCount = 0;
  let evalCount = 0;
  for (const chunk of res.data) {
    if (chunk.content) rawContent += chunk.content;
    if (chunk.prompt_eval_count) promptEvalCount = chunk.prompt_eval_count;
    if (chunk.eval_count) evalCount = chunk.eval_count;
  }

  // Parse thinking block from output
  let thinking = '';
  let content = rawContent;

  const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    thinking = thinkMatch[1].trim();
    content = rawContent.replace(/<think>[\s\S]*?<\/think>\s*/, '').trim();
  } else {
    // Handle unclosed <think> block
    const unclosedMatch = rawContent.match(/<think>([\s\S]*)/);
    if (unclosedMatch) {
      // Try to find where thinking ends and content begins
      // Look for common patterns: double newline, or end of thinking markers
      const thinkingContent = unclosedMatch[1];
      const splitMatch = thinkingContent.match(/([\s\S]*?)(\n\n[\s\S]+)/);

      if (splitMatch) {
        // Found a natural break - first part is thinking, rest is content
        thinking = splitMatch[1].trim();
        content = splitMatch[2].trim();
      } else {
        // No clear break - treat everything as thinking, but keep it as content too
        thinking = thinkingContent.trim();
        content = thinkingContent.trim();
      }
    }
  }

  // Always return structured result with thinking + token stats
  return {
    content,
    thinking,
    tokenUsage: {
      promptTokens: promptEvalCount,
      completionTokens: evalCount,
      thinkingTokens: thinking ? Math.ceil(thinking.length / 3) : 0, // estimate
    },
  };
}

/**
 * HTTP request helper for Python inference server.
 */
function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(urlPath, INFERENCE_SERVER_URL);

    const req = http.request({
      hostname: '127.0.0.1',
      port: INFERENCE_SERVER_PORT,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 120_000,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => {
        const responseData = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ status: res.statusCode, data: JSON.parse(responseData) });
        } catch {
          resolve({ status: res.statusCode, data: responseData });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Inference server timeout')); });
    req.write(data);
    req.end();
  });
}

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, INFERENCE_SERVER_URL);
    const req = http.request({
      hostname: '127.0.0.1',
      port: INFERENCE_SERVER_PORT,
      path: url.pathname,
      method: 'GET',
      timeout: 3000,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Check if Python inference server is running.
 */
async function isPythonServerRunning() {
  try {
    const res = await httpGet('/health');
    return res.status === 200 && res.data?.status === 'ok';
  } catch {
    return false;
  }
}

/**
 * Check if Ollama is running and has the target model.
 */
async function isOllamaAvailable() {
  try {
    const url = new URL('/api/tags', OLLAMA_HOST);
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        timeout: 3000,
      }, (r) => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => {
          try { resolve({ status: r.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ status: r.statusCode, data }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    if (res.status === 200 && res.data?.models) {
      const models = res.data.models.map(m => m.name || m.model);
      return models.some(m => m.startsWith(OLLAMA_MODEL.split(':')[0]));
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Generate via Ollama HTTP API.
 */
async function generateOllama(prompt, options) {
  const messages = options.messages || [{ role: 'user', content: prompt }];
  const allMessages = [];
  if (options.system) {
    allMessages.push({ role: 'system', content: options.system });
  }
  allMessages.push(...messages);

  const url = new URL('/api/chat', OLLAMA_HOST);
  const enableThinking = options.think !== false;
  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    messages: allMessages,
    stream: false,
    think: enableThinking,
    options: {
      temperature: options.temperature ?? (enableThinking ? 0.6 : 0.1),
      top_p: options.top_p ?? 0.85,
      num_predict: enableThinking ? Math.max(options.maxTokens ?? 2048, 4096) : (options.maxTokens ?? 2048),
    },
  });

  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 300_000,
    }, (r) => {
      let data = '';
      r.on('data', c => { data += c; });
      r.on('end', () => {
        try { resolve({ status: r.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: r.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timeout')); });
    req.write(body);
    req.end();
  });

  if (res.status === 200 && res.data?.message) {
    const content = res.data.message.content || '';
    const thinking = res.data.message.thinking || '';
    if (options.returnThinking) {
      return { content, thinking };
    }
    return content;
  }

  throw new Error(res.data?.error || `Ollama returned ${res.status}`);
}

/**
 * Start Python inference server if not running.
 */
async function startPythonServer() {
  if (await isPythonServerRunning()) return true;

  const serverScript = path.join(__dirname, '../../inference_server.py');
  if (!fs.existsSync(serverScript)) return false;
  if (!isPythonLlamaCppAvailable()) {
    localLLMLog(`[LocalLLM] llama-cpp-python unavailable, skipping Python server (${_pythonLlamaCppError || 'import failed'})`);
    return false;
  }

  try {
    const startupTimeoutMs = Math.max(
      5000,
      parseInt(process.env.KHY_LOCAL_PY_SERVER_START_TIMEOUT_MS || '60000', 10) || 60000
    );
    const startupPollMs = Math.max(
      250,
      parseInt(process.env.KHY_LOCAL_PY_SERVER_START_POLL_MS || '500', 10) || 500
    );
    let exited = false;
    let exitCode = null;
    let stderrTail = '';

    _pythonProcess = spawn(PYTHON_LAUNCHER.cmd, [
      ...PYTHON_LAUNCHER.preArgs,
      serverScript,
      '--model', _modelPath,
      '--port', String(INFERENCE_SERVER_PORT),
      '--preload',
    ], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LOCAL_MODEL_PATH: _modelPath },
      windowsHide: true,
    });
    _pythonProcess.stdout?.on('data', () => { /* drain pipe */ });
    _pythonProcess.stderr?.on('data', (buf) => {
      const text = String(buf || '');
      if (!text) return;
      stderrTail += text;
      if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-2048);
    });
    _pythonProcess.on('exit', (code) => {
      exited = true;
      exitCode = code;
    });
    _pythonProcess.on('error', (err) => {
      exited = true;
      if (stderrTail.length < 512) {
        stderrTail += `\nspawn error: ${err && err.message ? err.message : String(err)}`;
      }
    });
    _pythonProcess.unref?.();

    // Wait for server to come online. If process exits early, fail fast.
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        const msg = String(stderrTail || '').replace(/\s+/g, ' ').trim();
        _lastError = new Error(
          msg
            ? `Python inference server exited early (code=${exitCode}): ${msg.slice(0, 260)}`
            : `Python inference server exited early (code=${exitCode})`
        );
        _pythonProcess = null;
        return false;
      }
      if (await isPythonServerRunning()) return true;
      await new Promise(r => setTimeout(r, startupPollMs));
    }

    const timeoutMsg = String(stderrTail || '').replace(/\s+/g, ' ').trim();
    _lastError = new Error(
      timeoutMsg
        ? `Python inference server startup timed out after ${Math.round(startupTimeoutMs / 1000)}s: ${timeoutMsg.slice(0, 260)}`
        : `Python inference server startup timed out after ${Math.round(startupTimeoutMs / 1000)}s`
    );
    return false;
  } catch (err) {
    _lastError = err;
    return false;
  }
}

/**
 * Classify a model-load failure into a structured, actionable diagnosis.
 *
 * Pure and never throws. Distinguishes the GGUF/engine ARCHITECTURE
 * incompatibility family — where the bundled llama.cpp cannot parse the model's
 * hyperparameters (e.g. "qwen35.rope.dimension_sections has wrong array length;
 * expected 4, got 3", "error loading model hyperparameters", "unknown model
 * architecture") — from a merely missing engine or missing model file. This is
 * the root cause behind the bare "AI 超时" symptom: the real reason is the model
 * format, not a timeout. Returns null for unrelated errors so callers fall back.
 *
 * @param {string} message raw error text from the inference engine
 * @returns {{code:string, cause:string, solutions:string[]}|null}
 */
function classifyModelLoadError(message) {
  const t = String(message == null ? '' : message);
  if (!t) return null;
  // Hyperparameter / architecture mismatch — the model file is structurally
  // incompatible with this llama.cpp build (NOT a crash / connection issue).
  const INCOMPAT = /dimension_sections|wrong array length|error loading model hyperparameters|unknown\s+model\s+architecture|unsupported\s+model\s+architecture|unknown\s+(?:general\.)?architecture|llama_model_load[^]*?error|failed to load model/i;
  if (INCOMPAT.test(t)) {
    return {
      code: 'LOCAL_MODEL_INCOMPATIBLE',
      cause: '本地推理引擎（内置 node-llama-cpp / llama.cpp）无法解析该模型格式：GGUF 超参或架构与当前引擎版本不兼容（常见于较新的 Qwen 3.5 等模型，期望的 rope 维度分段数与文件不一致）。',
      solutions: [
        '改用 Ollama 运行该模型（Ollama 自带已打补丁的 llama.cpp，对新模型支持更好）：先运行 `ollama serve`，再 `ollama pull qwen3.5:4b`，Khyos 会自动经 Ollama 后端推理。',
        '换用与当前内置引擎兼容的 GGUF（例如标准 Qwen2.5 系列，或用新版 llama.cpp 重新量化导出）。',
        '升级内置推理引擎 node-llama-cpp 到支持该模型架构的版本后重试。',
      ],
    };
  }
  return null;
}

/**
 * Decide whether Ollama can serve the configured model, with an actionable
 * verdict and an auto-correct suggestion. Pure (no I/O) — the caller supplies
 * the probe result ({ online, tags }). The matching mirrors isOllamaAvailable's
 * prefix rule, then refines it: isOllamaAvailable() passes on a same-FAMILY tag,
 * but generateOllama() sends the EXACT configured tag, so a family-only match
 * would still 404 at generation. We surface that gap and point OLLAMA_MODEL at
 * the installed tag.
 *
 * @param {{online?:boolean, tags?:string[], configuredModel?:string}} p
 * @returns {{ok:boolean, level:'info'|'warn', detail:string, suggestion:string|null, matchedTag:string|null}}
 */
function diagnoseOllamaModel({ online = false, tags = [], configuredModel } = {}) {
  const model = String(configuredModel || OLLAMA_MODEL || MODELS.localBrain);
  const family = model.split(':')[0];
  const list = Array.isArray(tags) ? tags.filter(Boolean).map(String) : [];

  if (!online) {
    return {
      ok: false, level: 'warn', matchedTag: null, suggestion: null,
      detail: `未检测到 Ollama 服务（${OLLAMA_HOST}）。启动：\`ollama serve\`；拉取模型：\`ollama pull ${model}\`（Ollama 在其它主机时设 OLLAMA_HOST）。`,
    };
  }
  if (list.includes(model)) {
    return {
      ok: true, level: 'info', matchedTag: model, suggestion: null,
      detail: `✓ Ollama 在线，已安装 ${model}，本地推理可用。`,
    };
  }
  // Same-family tag present but the exact configured tag is missing → fixable by
  // pointing OLLAMA_MODEL at the installed tag (or pulling the configured one).
  const familyMatch = list.find((t) => t.startsWith(family));
  if (familyMatch) {
    return {
      ok: false, level: 'warn', matchedTag: familyMatch, suggestion: `OLLAMA_MODEL=${familyMatch}`,
      detail: `Ollama 在线，但配置的 ${model} 未安装；检测到同系 ${familyMatch}。设环境变量 OLLAMA_MODEL=${familyMatch}（或 \`ollama pull ${model}\`）即可用。`,
    };
  }
  const shown = list.length ? list.slice(0, 8).join(', ') : '（当前无已安装模型）';
  return {
    ok: false, level: 'warn', matchedTag: null, suggestion: list.length ? 'OLLAMA_MODEL=<已安装的tag>' : null,
    detail: `Ollama 在线，但未安装与 ${model} 匹配的模型。已安装：${shown}。请 \`ollama pull ${model}\`，或设 OLLAMA_MODEL=<上述某个 tag>。`,
  };
}

/**
 * Try to load via node-llama-cpp (ESM dynamic import).
 */
async function tryNodeLlamaCpp() {
  try {
    await _withNodeLlamaCppLogSilenced(async () => {
      const { getLlama } = await import('node-llama-cpp');
      // Silence the engine AT THE SOURCE: a no-op logger keeps the native
      // `[node-llama-cpp]` llama.cpp lines (which bypass the JS stderr patch via
      // direct fd writes) out of the TUI. Fall back to the default getLlama if a
      // given version rejects these options.
      try {
        _llama = await getLlama(
          NODE_LLAMA_CPP_LOG_SILENT ? { logLevel: 'error', logger: () => {} } : {}
        );
      } catch {
        _llama = await getLlama();
      }
      _model = await _llama.loadModel({
        modelPath: _modelPath,
        gpuLayers: 0,
      });
    });
    _context = await _model.createContext({ contextSize: 4096 });
    _backend = 'node-llama-cpp';
    return true;
  } catch (err) {
    // node-llama-cpp not available OR the model format is unsupported. Preserve
    // a structured diagnosis for the incompatibility case so it is not lost when
    // we fall through to the next backend (the fix for the swallowed real cause).
    const diag = classifyModelLoadError(err && err.message);
    if (diag) {
      _modelLoadDiagnosis = diag;
      localLLMLog(`[LocalLLM] node-llama-cpp cannot load this model (${diag.code}): ${err.message}`);
    } else {
      localLLMLog(`[LocalLLM] node-llama-cpp unavailable: ${err.message}`);
    }
    return false;
  }
}

/**
 * Ensure inference backend is ready.
 */
async function ensureLoaded() {
  if (_backend) return _backend;
  if (_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    try {
      const modelFileExists = isModelAvailable();
      const loopbackAvailable = await canListenLoopback();
      if (!loopbackAvailable) {
        localLLMLog(`[LocalLLM] Loopback sockets unavailable (${_loopbackListenProbe.error || 'listen failed'}), spawn-based local backends may be restricted`);
      }

      // Strategy 1: ollama-runner (standalone subprocess, best Qwen 3.5 support)
      // Even when loopback listen is blocked, still try to attach to an already-running runner.
      {
        localLLMLog('[LocalLLM] Trying ollama-runner (standalone)...');
        if (await startOllamaRunner({ allowSpawn: loopbackAvailable && modelFileExists })) {
          _backend = 'ollama-runner';
          _lastError = null;
          localLLMLog(`[LocalLLM] Using ollama-runner backend (no Ollama service needed)`);
          return _backend;
        }
      }

      // Strategy 2: try node-llama-cpp (requires model file)
      if (modelFileExists && await tryNodeLlamaCpp()) {
        _lastError = null;
        return _backend;
      }

      // Strategy 3: Python inference server (requires model file)
      if (!modelFileExists) {
        localLLMLog('[LocalLLM] No model file, skipping Python server...');
      }
      localLLMLog('[LocalLLM] Falling back to Python inference server...');
      const started = modelFileExists && loopbackAvailable && await startPythonServer();
      if (started) {
        _backend = 'python-server';
        _lastError = null;
        return _backend;
      }

      // Strategy 4: Ollama HTTP API (uses Ollama's own llama.cpp which supports newer models)
      localLLMLog('[LocalLLM] Falling back to Ollama HTTP API...');
      if (await isOllamaAvailable()) {
        _backend = 'ollama';
        _lastError = null;
        localLLMLog(`[LocalLLM] Using Ollama backend with model: ${OLLAMA_MODEL}`);
        return _backend;
      }

      // If the built-in engine rejected the model as INCOMPATIBLE and every
      // fallback is also unavailable, surface the real cause + concrete fixes.
      // This replaces the bare "AI 超时" / generic "no backend" with an
      // actionable diagnosis (the model format, not a timeout, is the problem).
      if (_modelLoadDiagnosis) {
        const d = _modelLoadDiagnosis;
        const err = new Error(
          `${d.cause}\n` +
          `Khyos 已自动尝试回退其它本地后端（Python 推理服务 / Ollama HTTP），但当前均不可用。可选解决方案：\n` +
          d.solutions.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
        );
        err.code = d.code;
        err.diagnosis = d;
        throw err;
      }

      if (!loopbackAvailable) {
        throw new Error(
          `No inference backend available in current runtime: loopback listen is not permitted (${_loopbackListenProbe.error || 'listen failed'}), and no hot local runner/Ollama HTTP backend was reachable.`
        );
      }
      throw new Error('No inference backend available. Install ollama (for ollama-runner), node-llama-cpp, llama-cpp-python, or run Ollama service.');
    } catch (err) {
      _lastError = err;
      _loadingPromise = null;
      throw err;
    }
  })();

  return _loadingPromise;
}

/**
 * Generate via node-llama-cpp.
 */
async function generateNodeLlama(prompt, options) {
  const { LlamaChatSession } = await import('node-llama-cpp');
  const sequence = _context.getSequence();
  const session = new LlamaChatSession({ contextSequence: sequence });
  return session.prompt(prompt, {
    temperature: options.temperature ?? 0.1,
    topP: options.top_p ?? 0.85,
    maxTokens: options.maxTokens ?? 2048,
  });
}

/**
 * Generate via Python HTTP server.
 */
async function generatePython(prompt, options) {
  const messages = options.messages || [{ role: 'user', content: prompt }];

  // Prepend system message if provided
  const allMessages = [];
  if (options.system) {
    allMessages.push({ role: 'system', content: options.system });
  }
  allMessages.push(...messages);

  const res = await httpPost('/v1/chat/completions', {
    messages: allMessages,
    temperature: options.temperature ?? 0.1,
    top_p: options.top_p ?? 0.85,
    max_tokens: options.maxTokens ?? 2048,
  });

  if (res.status === 200 && res.data?.choices?.[0]) {
    return res.data.choices[0].message?.content || '';
  }

  throw new Error(res.data?.error || `Inference server returned ${res.status}`);
}

/**
 * Reset backend state so the next call to ensureLoaded() re-detects.
 * Called automatically when a connection error indicates the backend crashed.
 */
function _resetBackend(reason) {
  localLLMLog(`[LocalLLM] Backend reset: ${reason}`);
  _backend = null;
  _loadingPromise = null;
  _runnerReady = false;
}

/**
 * Check if an error indicates the backend process died or is unreachable.
 */
function _isBackendCrashError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return /econnrefused|econnreset|epipe|socket hang up|channel closed|stalled|spawn|exited/i.test(msg)
    || err.code === 'ECONNREFUSED'
    || err.code === 'ECONNRESET'
    || err.code === 'EPIPE';
}

/**
 * Generate a response using the local model.
 * Auto-recovers from backend crashes by resetting and retrying once.
 */
async function generate(prompt, options = {}) {
  await ensureLoaded();

  const dispatch = async () => {
    if (_backend === 'ollama-runner') {
      return generateRunner(prompt, options);
    }
    if (_backend === 'node-llama-cpp') {
      return generateNodeLlama(prompt, options);
    }
    if (_backend === 'python-server') {
      return generatePython(prompt, options);
    }
    if (_backend === 'ollama') {
      return generateOllama(prompt, options);
    }
    throw new Error('No inference backend loaded');
  };

  try {
    return await dispatch();
  } catch (err) {
    // If the backend crashed (ECONNREFUSED, etc.), reset and retry once
    if (_isBackendCrashError(err)) {
      _resetBackend(`backend crash detected: ${err.message}`);
      try {
        await ensureLoaded();
        return await dispatch();
      } catch (retryErr) {
        // Second failure is final — don't loop
        throw retryErr;
      }
    }
    throw err;
  }
}

/**
 * Dispose resources (for graceful shutdown).
 */
async function dispose() {
  try {
    if (_context) { await _context.dispose(); _context = null; }
    if (_model) { await _model.dispose(); _model = null; }
    if (_llama) { await _llama.dispose(); _llama = null; }
    if (_pythonProcess) {
      terminateChildTree(_pythonProcess);
      _pythonProcess = null;
    }
    if (_runnerProcess) {
      terminateChildTree(_runnerProcess);
      _runnerProcess = null;
      _runnerReady = false;
    }
    _loadingPromise = null;
    _backend = null;
    _pythonLlamaCppAvailable = null;
    _pythonLlamaCppError = '';
    _loopbackListenProbe = { ok: null, at: 0, error: '' };
  } catch (err) {
    console.error('Error disposing local LLM:', err);
  }
}

/**
 * Get current status.
 */
function getStatus() {
  const available = isModelAvailable();
  const state = _modelAvailabilityState || {};
  return {
    modelPath: _modelPath,
    available,
    loaded: _backend !== null,
    backend: _backend,
    inferenceServerPort: INFERENCE_SERVER_PORT,
    runnerPort: OLLAMA_RUNNER_PORT,
    runnerReady: _runnerReady,
    lastError: _lastError ? _lastError.message : null,
    // Surface a model-format incompatibility (built-in engine ↔ GGUF) so the UI
    // can show the real cause + fixes instead of a generic failure/timeout.
    modelIncompatible: !!_modelLoadDiagnosis,
    modelLoadDiagnosis: _modelLoadDiagnosis || null,
    loopbackListenAvailable: _loopbackListenProbe.ok,
    loopbackListenError: _loopbackListenProbe.error || null,
    modelDiscoveryReason: state.reason || (available ? 'available' : 'unknown'),
    modelArtifactKind: state.artifactKind || null,
    modelArtifactPath: state.artifactPath || null,
    modelImportHint: state.importHint || null,
    modelImportCommand: state.importCommand || null,
    discoveryError: state.lastError || null,
    runtimeArtifact: state.runtime || null,
    importableArtifact: state.importable || null,
    nonRuntimeArtifact: state.nonRuntime || null,
    modelScanRoots: Array.isArray(state.roots) ? state.roots : [],
    modelScannedAt: Number(state.scannedAt || 0) || null,
    modelCheckedAt: Number(state.checkedAt || 0) || null,
  };
}

module.exports = {
  isModelAvailable,
  canListenLoopback,
  tryAdoptHotRunner,
  ensureLoaded,
  generate,
  dispose,
  getStatus,
  isPythonServerRunning,
  classifyModelLoadError,
  diagnoseOllamaModel,
  OLLAMA_MODEL,
  OLLAMA_HOST,
};
