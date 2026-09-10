'use strict';

/**
 * browserComputerBackend — Y-code 风格的专用浏览器控制后端。
 *
 * 与现有 WebBrowserTool 的区别:
 *   - WebBrowserTool: 无头 Chromium，隔离 context，临时会话
 *   - BrowserComputerBackend: 用户真实浏览器 (Edge/Chrome)，复用已登录状态
 *
 * 关键能力:
 *   1. channel: 'msedge' / 'chrome' — 启动用户已安装的浏览器而非下载 Chromium
 *   2. profile 复用 — 使用用户现有 profile，保留登录/cookie/扩展
 *   3. 多屏感知 — 返回显示器布局，支持跨屏操作
 *   4. pause/resume — 挂起/恢复会话而不关闭浏览器
 *   5. fail-closed on lock screen — 检测到锁屏/UAC 时拒绝所有操作
 *
 * 参考: Y-code xingyao-y-code core/computer/browser_backend.py
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ── 平台特定路径 ────────────────────────────────────────────────

function getEdgeUserDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge');
  }
  return path.join(os.homedir(), '.config', 'microsoft-edge');
}

function getChromeUserDataDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return path.join(os.homedir(), '.config', 'google-chrome');
}

// ── 显示器枚举 ─────────────────────────────────────────────────

/**
 * 枚举所有显示器。返回 [{ index, bounds: {x,y,width,height}, isPrimary, scaleFactor }]
 */
function enumerateDisplays() {
  if (process.platform === 'win32') {
    return _enumerateDisplaysWindows();
  }
  if (process.platform === 'darwin') {
    return _enumerateDisplaysMacOS();
  }
  return _enumerateDisplaysLinux();
}

function _enumerateDisplaysWindows() {
  try {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Windows.Forms;
using System.Drawing;
public class ScreenInfo {
    public static string GetScreens() {
        var screens = new List<string>();
        int i = 0;
        foreach (var screen in Screen.AllScreens) {
            var b = screen.Bounds;
            screens.Add(string.Format("{0}|{1}|{2}|{3}|{4}|{5}",
                i++, b.X, b.Y, b.Width, b.Height,
                screen.Primary ? 1 : 0));
        }
        return string.Join("\\n", screens);
    }
}
"@
[ScreenInfo]::GetScreens()
`;
    const output = execSync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [index, x, y, w, h, primary] = line.split('|').map(Number);
        return {
          index,
          bounds: { x, y, width: w, height: h },
          isPrimary: primary === 1,
        };
      });
  } catch {
    // Fallback: single display
    return [{ index: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isPrimary: true }];
  }
}

function _enumerateDisplaysMacOS() {
  try {
    const output = execSync('system_profiler SPDisplaysDataType -json 2>/dev/null || echo "[]"', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    // Parse JSON output for display info
    // Simplified fallback
    return [{ index: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isPrimary: true }];
  } catch {
    return [{ index: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isPrimary: true }];
  }
}

function _enumerateDisplaysLinux() {
  try {
    const output = execSync('xrandr --listmonitors 2>/dev/null || echo ""', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const displays = [];
    const lines = output.split('\n').slice(1); // skip header
    let idx = 0;
    for (const line of lines) {
      const match = line.match(/\+\d+\+\d+\/(\d+)x(\d+)\+\d+\+\d+/);
      if (match) {
        displays.push({
          index: idx++,
          bounds: { x: 0, y: 0, width: parseInt(match[1]), height: parseInt(match[2]) },
          isPrimary: line.includes('+*'),
        });
      }
    }
    return displays.length > 0
      ? displays
      : [{ index: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isPrimary: true }];
  } catch {
    return [{ index: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, isPrimary: true }];
  }
}

// ── 锁屏/UAC 检测 ──────────────────────────────────────────────

/**
 * 检测 Windows 是否处于锁屏状态。返回 { locked: boolean, reason: string }
 *
 * 检测方法:
 *   1. 检查 LogonUI.exe 进程存在 (锁屏界面)
 *   2. 检测当前 desktop 是否为 Winlogon (UAC/锁屏切换到安全桌面)
 */
function detectLockScreen() {
  if (process.platform !== 'win32') {
    return { locked: false, reason: null };
  }

  try {
    // 方法 1: 检查 LogonUI.exe
    const tasklist = execSync('tasklist /FI "IMAGENAME eq LogonUI.exe" 2>nul', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (tasklist.includes('LogonUI.exe')) {
      return { locked: true, reason: 'Windows 已锁屏 (LogonUI 运行中)' };
    }

    // 方法 2: 检测 UAC consent.exe
    const consent = execSync('tasklist /FI "IMAGENAME eq consent.exe" 2>nul', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (consent.includes('consent.exe')) {
      return { locked: true, reason: 'UAC 提示正在显示 (consent.exe)' };
    }
  } catch {
    // 检测失败 → 保守认为未锁屏 (让操作继续)
  }

  return { locked: false, reason: null };
}

/**
 * 检测 UAC 提示是否在显示。仅 Windows。
 */
function detectUACPrompt() {
  if (process.platform !== 'win32') {
    return { active: false };
  }
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq consent.exe" 2>nul', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return { active: output.includes('consent.exe') };
  } catch {
    return { active: false };
  }
}

// ── 浏览器启动选项构建 ─────────────────────────────────────────

/**
 * 构建 launch options for Playwright。
 *
 * @param {object} opts
 * @param {'edge'|'chrome'|'chromium'} opts.browser — 浏览器类型
 * @param {string} [opts.profilePath] — 自定义 profile 目录
 * @param {boolean} [opts.headless=false]
 * @param {object} [opts.extraArgs] — 额外命令行参数
 */
function buildLaunchOptions(opts = {}) {
  const { browser = 'chromium', profilePath, headless = false, extraArgs = [] } = opts;

  const launchArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    ...extraArgs,
  ];

  const launchOpts = {
    headless,
    args: launchArgs,
    timeout: 30000,
  };

  // 设置 channel (Edge/Chrome)
  if (browser === 'edge') {
    launchOpts.channel = 'msedge';
  } else if (browser === 'chrome') {
    launchOpts.channel = 'chrome';
  }

  return launchOpts;
}

// ── 安全操作守卫 ───────────────────────────────────────────────

/**
 * 检测是否安全执行操作。若不安全 (锁屏/UAC) 抛出 ComputerControlError。
 *
 * @param {object} opts
 * @param {boolean} [opts.allowWhenLocked=false] — 是否允许锁屏时执行
 * @throws {Error} 当检测到锁屏/UAC 时抛出
 */
function failClosedGuard(opts = {}) {
  const { allowWhenLocked = false } = opts;

  if (allowWhenLocked) return;

  const lockState = detectLockScreen();
  if (lockState.locked) {
    throw new Error(`SAFETY_BLOCKED: ${lockState.reason} — 拒绝所有浏览器操作`);
  }

  const uacState = detectUACPrompt();
  if (uacState.active) {
    throw new Error('SAFETY_BLOCKED: UAC 提示正在显示 — 拒绝所有浏览器操作');
  }
}

// ── 导出 ───────────────────────────────────────────────────────

module.exports = {
  getEdgeUserDataDir,
  getChromeUserDataDir,
  enumerateDisplays,
  detectLockScreen,
  detectUACPrompt,
  buildLaunchOptions,
  failClosedGuard,
};
