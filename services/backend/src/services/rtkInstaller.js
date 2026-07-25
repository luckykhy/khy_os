'use strict';

/**
 * rtkInstaller —— RTK 二进制的「首次缺失时自动安装」器(一次性、异步、非阻塞、永不抛)。
 *
 * 由 shellCommand 接缝在 rtk 缺失且 rtkMode.autoInstallEnabled() 时 fire-and-forget 触发
 * (kickoff)。绝不阻塞当前回合:本回合静默回落 smartTruncation,安装完成后续回合
 * resolveBinary 自然命中新二进制。
 *
 * 安装顺序(权威来源 github.com/rtk-ai/rtk 的 README):
 *   1. 已存在(PATH / ~/.khy/bin)→ 直接成功。
 *   2. cargo 可用 → `cargo install --git <RTK_GIT_URL> --root <appHome>`
 *      → 二进制落 ~/.khy/bin/rtk(resolveBinary 的优先定位点)。
 *   3. 否则 → 官方 install.sh(`curl … | sh`,装到 ~/.local/bin)→ 拷入 ~/.khy/bin。
 *   任一失败 → 记日志 + 静默回落,绝不抛、绝不阻塞。门控 KHY_RTK_AUTO_INSTALL。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const rtkMode = require('./rtkMode');
const { getAppHome } = require('../utils/dataHome');

// 安装来源(可经 env 覆盖;默认取 RTK 官方仓库)。非 khy 云端点,gate 不拦。
const RTK_GIT_URL = process.env.KHY_RTK_GIT_URL || 'https://github.com/rtk-ai/rtk';
const RTK_INSTALL_SCRIPT_URL = process.env.KHY_RTK_INSTALL_SCRIPT_URL
  || 'https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh';

function _log() {
  try { return require('../utils/logger'); } catch { return null; }
}
function _warn(msg) { const l = _log(); if (l && l.warn) { try { l.warn(msg); } catch { /* ignore */ } } }
function _info(msg) { const l = _log(); if (l && l.info) { try { l.info(msg); } catch { /* ignore */ } } }

// ── 可注入 spawn(测试入口)──────────────────────────────────────────────────
let _spawnImpl = null; // (file, args, opts) => Promise<{ code, stdout, stderr }>
function __setSpawn(fn) { _spawnImpl = fn; }
function __clearSpawn() { _spawnImpl = null; }

function _spawnAsync(file, args, opts = {}) {
  if (typeof _spawnImpl === 'function') return Promise.resolve(_spawnImpl(file, args, opts));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(file, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
        windowsHide: true,
        shell: !!opts.shell,
      });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ code: -1, stdout, stderr: stderr + '\n[timeout]' });
    }, opts.timeout || 300000);
    if (child.stdout) child.stdout.on('data', (d) => { stdout += String(d); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String((err && err.message) || err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function _hasCommand(cmd) {
  const r = await _spawnAsync(cmd, ['--version'], { timeout: 5000 });
  return r && r.code === 0;
}

// ── 一次性缓存:同进程内只尝试一次安装 ───────────────────────────────────────
let _attemptPromise = null;

/**
 * 触发安装(fire-and-forget,非阻塞,永不抛)。供接缝在缺失时调用。
 */
function kickoff() {
  if (!rtkMode.autoInstallEnabled()) return;
  // 不 await:本回合立即返回,安装在后台进行。
  ensureInstalled().catch(() => { /* 已在内部记日志 */ });
}

/**
 * 确保 rtk 已安装。一次性缓存:同进程内只跑一次。返回
 * { success, method, path?, reason? }。永不抛。
 */
function ensureInstalled() {
  if (_attemptPromise) return _attemptPromise;
  _attemptPromise = _doInstall().catch((err) => {
    _warn(`[rtkInstaller] install attempt threw (non-fatal): ${(err && err.message) || err}`);
    return { success: false, method: null, reason: 'exception' };
  });
  return _attemptPromise;
}

async function _doInstall() {
  // 1) 已存在?
  const existing = await rtkMode.resolveBinary({ force: true });
  if (existing) return { success: true, method: 'existing', path: existing };

  if (!rtkMode.autoInstallEnabled()) {
    return { success: false, method: null, reason: 'auto-install disabled' };
  }

  const appHome = (() => { try { return getAppHome(); } catch { return null; } })();
  const localBin = rtkMode.localBinPath();

  // 2) cargo install --git … --root <appHome>(落 ~/.khy/bin/rtk)
  if (appHome && await _hasCommand('cargo')) {
    _info(`[rtkInstaller] installing rtk via cargo from ${RTK_GIT_URL} …`);
    const r = await _spawnAsync(
      'cargo',
      ['install', '--git', RTK_GIT_URL, '--root', appHome, '--force'],
      { timeout: 600000 }
    );
    if (r && r.code === 0) {
      rtkMode.__clearCache();
      const resolved = await rtkMode.resolveBinary({ force: true });
      if (resolved) { _info('[rtkInstaller] rtk installed via cargo'); return { success: true, method: 'cargo', path: resolved }; }
    }
    _warn(`[rtkInstaller] cargo install failed (code ${r && r.code}); trying install script`);
  }

  // 3) 官方 install.sh(装到 ~/.local/bin)→ 拷入 ~/.khy/bin
  if (process.platform !== 'win32' && await _hasCommand('curl')) {
    _info('[rtkInstaller] installing rtk via official install.sh …');
    const r = await _spawnAsync(
      'sh',
      ['-c', `curl -fsSL ${RTK_INSTALL_SCRIPT_URL} | sh`],
      { timeout: 300000 }
    );
    if (r && r.code === 0) {
      const localBinDir = path.join(require('os').homedir(), '.local', 'bin', 'rtk');
      try {
        if (localBin && fs.existsSync(localBinDir)) {
          fs.mkdirSync(path.dirname(localBin), { recursive: true });
          fs.copyFileSync(localBinDir, localBin);
          fs.chmodSync(localBin, 0o755);
        }
      } catch (err) {
        _warn(`[rtkInstaller] copy to ~/.khy/bin failed: ${(err && err.message) || err}`);
      }
      rtkMode.__clearCache();
      const resolved = await rtkMode.resolveBinary({ force: true });
      if (resolved) { _info('[rtkInstaller] rtk installed via install.sh'); return { success: true, method: 'script', path: resolved }; }
    }
    _warn(`[rtkInstaller] install.sh failed (code ${r && r.code})`);
  }

  _warn('[rtkInstaller] no install method succeeded; falling back to smartTruncation');
  return { success: false, method: null, reason: 'no method succeeded' };
}

// ── 测试入口 ────────────────────────────────────────────────────────────────
function __reset() { _attemptPromise = null; }

module.exports = {
  kickoff,
  ensureInstalled,
  RTK_GIT_URL,
  RTK_INSTALL_SCRIPT_URL,
  __setSpawn,
  __clearSpawn,
  __reset,
};
