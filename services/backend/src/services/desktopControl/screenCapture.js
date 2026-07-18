'use strict';

/**
 * desktopControl/screenCapture.js — 眼：把当前桌面截成 PNG（DESIGN-ARCH-056）。
 *
 * 用 backendDetector 选出的截屏后端（screencapture/grim/scrot/import/powershell-gdi…），
 * 经 backendRegistry 构建 argv，execFile 落盘到受管临时目录。**绝不拼 shell**。
 * 截屏结果是一个本地 PNG 路径，可直接喂给既有 OCR / 多模态视觉模型实现「看懂屏幕」。
 *
 * 缺后端时不抛错，返回 { success:false, installHints } 让上游按需提示安装（依赖自愈）。
 *
 * 注意：截屏属于隐私敏感读操作（会拍下整块屏幕）。它本身不改变系统，归 safetyGate 的
 * 低风险审批级（见 safetyGate.js），但仍受总闸门 KHY_DESKTOP_CONTROL 管辖。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const detector = require('./backendDetector');

const CAPTURE_DIR = path.join(os.tmpdir(), 'khy-desktop', 'captures');

function ensureDir() {
  if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  return CAPTURE_DIR;
}

/** 用单调计数器命名，避免依赖被禁用的 Date.now/random（确定性 + 可测）。 */
let _seq = 0;
function _outPath(prefix) {
  _seq += 1;
  return path.join(ensureDir(), `${prefix}_${process.pid}_${_seq}.png`);
}

function _isFiniteInt(n) {
  return typeof n === 'number' && Number.isFinite(n) && Math.floor(n) === n;
}

function _runExecFile(cmd, args, deps, timeoutMs = 15000) {
  const runner = deps.execFile || execFile;
  return new Promise((resolve) => {
    runner(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (err && err.message) || String(err), stderr: String(stderr || '') });
      else resolve({ ok: true, stdout: String(stdout || '') });
    });
  });
}

/**
 * 截屏。
 * @param {object} [opts] { region:{x,y,w,h}, outPath, platform }
 * @param {object} [deps] { detect, resolveBackend, execFile, exists } 测试注入
 * @returns {Promise<{success, path?, backend?, bytes?, error?, installHints?}>}
 */
async function capture(opts = {}, deps = {}) {
  const detectFn = deps.detect || detector.detect;
  const caps = detectFn(deps.detectDeps || {});
  const platform = opts.platform || caps.platform;

  if (!caps.eyes || !caps.eyes.available) {
    return {
      success: false,
      error: '本机没有可用的截屏后端（眼未就绪）。',
      installHints: (caps.eyes && caps.eyes.installHints) || [],
    };
  }

  const resolve = deps.resolveBackend || detector.resolveBackend;
  const backend = resolve(platform, 'capture', caps.eyes.backend);
  if (!backend || !backend.ops) {
    return { success: false, error: `截屏后端 ${caps.eyes.backend} 无法解析。` };
  }

  const out = opts.outPath || _outPath('screen');
  let built;
  if (opts.region) {
    const { x, y, w, h } = opts.region;
    if (![x, y, w, h].every(_isFiniteInt) || w <= 0 || h <= 0 || x < 0 || y < 0) {
      return { success: false, error: '区域截屏参数非法：x,y,w,h 必须为非负整数且 w,h>0。' };
    }
    built = backend.ops.region ? backend.ops.region(x, y, w, h, out) : null;
    if (!built) {
      return { success: false, error: `后端 ${backend.id} 不支持脚本化区域截屏，请改用全屏或换后端。` };
    }
  } else {
    built = backend.ops.full(out);
  }

  const res = await _runExecFile(built.cmd, built.args, deps);
  const exists = deps.exists || fs.existsSync;
  if (!res.ok && !exists(out)) {
    return { success: false, backend: backend.id, error: `截屏失败：${res.error}`, stderr: res.stderr };
  }
  if (!exists(out)) {
    return { success: false, backend: backend.id, error: '截屏命令返回成功但未生成文件。' };
  }

  let bytes = 0;
  try { bytes = (deps.statSize ? deps.statSize(out) : fs.statSync(out).size); } catch { /* ignore */ }

  return { success: true, path: out, backend: backend.id, bytes, region: opts.region || null };
}

module.exports = {
  capture,
  CAPTURE_DIR,
  ensureDir,
  _internals: { _isFiniteInt, _outPath },
};
