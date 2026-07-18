'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getDataDir } = require('../utils/dataHome');

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/windows-clipboard-img2file.ps1');
const DEFAULT_POLL_MS = 500;
const DEFAULT_KEEP_FILES = 8;
const DEFAULT_MARKER = 'KHYClipboardImg2File';
const MIN_POLL_MS = 120;
const MAX_POLL_MS = 5000;
const MIN_KEEP_FILES = 1;
const MAX_KEEP_FILES = 200;

let _child = null;
let _startedAt = 0;
let _startMeta = null;
let _hooksInstalled = false;

function _isTruthy(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function isSupported() {
  return process.platform === 'win32';
}

function isEnabledByEnv() {
  // 默认**开**:剪贴板→文件桥是用户粘贴图片识图的主路径,默认关会让用户「无法从剪贴板读到图片」
  // (实测反馈:更新后粘贴失效)。原先担心的「抓到很久以前复制的陈旧图片、只提『图片』二字就被带偏」
  // 已由**新鲜度窗口**(isClipboardImageFresh,默认 8 秒)根治:只有足够新的剪贴板图片才算有效
  // 附件,陈旧图自动忽略。因此这里恢复默认开;仍可用 KHY_CLIPBOARD_IMG2FILE_ENABLED=0 显式关闭。
  return _isTruthy(process.env.KHY_CLIPBOARD_IMG2FILE_ENABLED, true);
}

// 「即使开启也不要那么敏感」:一张剪贴板图片只有在**足够新**(捕获时间距当前在该窗口内)时才算
// 有效附件,避免把很久以前复制、早已与当前对话无关的陈旧图片反复抓进来。默认 8 秒,可经
// KHY_CLIPBOARD_IMG2FILE_FRESH_MS 覆盖(夹在 [1s, 5min])。返回毫秒。
const DEFAULT_FRESH_WINDOW_MS = 8000;
const MIN_FRESH_WINDOW_MS = 1000;
const MAX_FRESH_WINDOW_MS = 300000;

function getFreshWindowMs() {
  return _clampInt(
    process.env.KHY_CLIPBOARD_IMG2FILE_FRESH_MS,
    DEFAULT_FRESH_WINDOW_MS,
    MIN_FRESH_WINDOW_MS,
    MAX_FRESH_WINDOW_MS,
  );
}

/**
 * 判定一张已捕获的剪贴板图片是否「新到」可作为本轮有效附件。
 * 只看捕获时间与当前时刻之差是否在新鲜窗口内——陈旧图片(窗口外)一律忽略,
 * 从根上避免「提到图片就抓陈旧剪贴板图」。异常 → false(宁可漏抓不误抓)。
 * @param {number} capturedAtMs 图片捕获时间戳(epoch ms),通常取文件 mtime
 * @param {number} [nowMs]
 * @returns {boolean}
 */
function isClipboardImageFresh(capturedAtMs, nowMs = Date.now()) {
  try {
    const captured = Number(capturedAtMs);
    const now = Number(nowMs);
    if (!Number.isFinite(captured) || captured <= 0) return false;
    if (!Number.isFinite(now)) return false;
    const age = now - captured;
    if (age < 0) return false; // 未来时间戳 → 视为不可信
    return age <= getFreshWindowMs();
  } catch {
    return false;
  }
}

function _clampInt(raw, fallback, min, max) {
  const parsed = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function _resolveOutputDir() {
  const fromEnv = String(process.env.KHY_CLIPBOARD_IMG2FILE_DIR || '').trim();
  const outDir = fromEnv ? path.resolve(fromEnv) : path.join(getDataDir(), 'clipboard-img2file');
  fs.mkdirSync(outDir, { recursive: true });
  return outDir;
}

function _resolveShell() {
  const fromEnv = String(process.env.KHY_CLIPBOARD_IMG2FILE_SHELL || '').trim();
  if (fromEnv) return fromEnv;
  return 'powershell.exe';
}

function _buildConfigFromEnv() {
  return {
    pollMs: _clampInt(process.env.KHY_CLIPBOARD_IMG2FILE_POLL_MS, DEFAULT_POLL_MS, MIN_POLL_MS, MAX_POLL_MS),
    keepFiles: _clampInt(process.env.KHY_CLIPBOARD_IMG2FILE_KEEP_FILES, DEFAULT_KEEP_FILES, MIN_KEEP_FILES, MAX_KEEP_FILES),
    marker: String(process.env.KHY_CLIPBOARD_IMG2FILE_MARKER || DEFAULT_MARKER).trim() || DEFAULT_MARKER,
    outputDir: _resolveOutputDir(),
    shell: _resolveShell(),
  };
}

function _installLifecycleHooks() {
  if (_hooksInstalled) return;
  _hooksInstalled = true;
  process.once('exit', () => {
    stopClipboardImg2FileBridge({ force: true });
  });
  process.once('SIGTERM', () => {
    stopClipboardImg2FileBridge({ force: true });
  });
}

function _toSpawnArgs(config) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Sta',
    '-WindowStyle', 'Hidden',
    '-File', SCRIPT_PATH,
    '-OutputDir', config.outputDir,
    '-PollMs', String(config.pollMs),
    '-KeepFiles', String(config.keepFiles),
    '-Marker', config.marker,
  ];
}

function startClipboardImg2FileBridge() {
  if (!isSupported()) {
    return { ok: false, started: false, reason: 'unsupported_platform' };
  }
  if (!isEnabledByEnv()) {
    return { ok: false, started: false, reason: 'disabled_by_env' };
  }
  if (_child && !_child.killed) {
    return {
      ok: true,
      started: false,
      reason: 'already_running',
      pid: _child.pid,
      startedAt: _startedAt || 0,
      meta: _startMeta,
    };
  }
  if (!fs.existsSync(SCRIPT_PATH)) {
    return { ok: false, started: false, reason: 'script_not_found', scriptPath: SCRIPT_PATH };
  }

  const config = _buildConfigFromEnv();
  const args = _toSpawnArgs(config);

  try {
    const child = spawn(config.shell, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
      detached: false,
    });

    child.once('error', () => {
      if (_child && _child.pid === child.pid) {
        _child = null;
        _startedAt = 0;
        _startMeta = null;
      }
    });
    child.once('exit', () => {
      if (_child && _child.pid === child.pid) {
        _child = null;
        _startedAt = 0;
        _startMeta = null;
      }
    });

    _child = child;
    _startedAt = Date.now();
    _startMeta = { ...config, scriptPath: SCRIPT_PATH };
    _installLifecycleHooks();

    return {
      ok: true,
      started: true,
      pid: child.pid,
      startedAt: _startedAt,
      meta: _startMeta,
    };
  } catch (err) {
    _child = null;
    _startedAt = 0;
    _startMeta = null;
    return {
      ok: false,
      started: false,
      reason: 'spawn_failed',
      error: err && err.message ? err.message : String(err),
      shell: config.shell,
    };
  }
}

function stopClipboardImg2FileBridge(options = {}) {
  if (!_child) return false;
  const target = _child;
  _child = null;
  _startedAt = 0;
  _startMeta = null;

  try {
    if (!target.killed) {
      const { safeKill } = require('../tools/platformUtils');
      safeKill(target, 'SIGTERM', options.force ? 0 : 3000);
    }
    return true;
  } catch {
    return false;
  }
}

function getClipboardImg2FileBridgeStatus() {
  const running = Boolean(_child && !_child.killed);
  return {
    supported: isSupported(),
    enabled: isEnabledByEnv(),
    running,
    pid: running ? _child.pid : null,
    startedAt: running ? _startedAt : 0,
    meta: running ? _startMeta : null,
    scriptPath: SCRIPT_PATH,
  };
}

module.exports = {
  isSupported,
  isEnabledByEnv,
  isClipboardImageFresh,
  getFreshWindowMs,
  startClipboardImg2FileBridge,
  stopClipboardImg2FileBridge,
  getClipboardImg2FileBridgeStatus,
};
