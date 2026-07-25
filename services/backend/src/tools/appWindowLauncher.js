'use strict';

/**
 * appWindowLauncher — open a URL in a dedicated Chromium `--app` window
 * (no address bar / tab strip), falling back to a regular browser tab via
 * platformUtils.openDefault when no --app capable browser is available.
 *
 * Pattern mirrors tools/khyos-markdown/khyos-md-bridge.js (findAppModeBrowsers
 * + openBrowser) but lives in the backend tree so the CLI handlers can use it
 * without a reverse dependency on the markdown tool.
 *
 * The URL is passed as a single argv element straight to spawn (no shell),
 * so metacharacters like `&` never need escaping on the --app path.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Dynamically discover Chromium-based browsers that support --app mode on
 * Windows. Paths are assembled from environment variables only (zero
 * hardcoded install locations beyond the standard env fallbacks).
 * Edge first (Windows 11+ standard), then Chrome.
 * @returns {string[]} Array of verified browser executable paths
 */
function findAppModeBrowsers() {
  const candidates = [];
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const la = process.env.LOCALAPPDATA || '';

  // Edge candidates — check most common install location first.
  const edgePaths = [
    la && path.join(la, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);

  // Chrome candidates
  const chromePaths = [
    la && path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);

  for (const p of edgePaths) {
    try { if (fs.existsSync(p)) { candidates.push(p); break; } } catch { /* next */ }
  }
  for (const p of chromePaths) {
    try { if (fs.existsSync(p)) { candidates.push(p); break; } } catch { /* next */ }
  }

  return candidates;
}

/**
 * Spawn one --app window attempt. Returns true when spawn did not throw
 * synchronously (detached fire-and-forget, same contract as the reference
 * implementation in khyos-md-bridge.js).
 */
function _trySpawnApp(sp, executable, url) {
  try {
    const child = sp(executable, [`--app=${url}`], { detached: true, stdio: 'ignore' });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback: open the URL as a regular tab in the default browser.
 * @returns {{ opened: boolean, mode: 'tab' }}
 */
function _openDefaultTab(url, openDefaultImpl) {
  const openDefault = openDefaultImpl || require('./platformUtils').openDefault;
  try {
    openDefault(url);
    return { opened: true, mode: 'tab' };
  } catch {
    return { opened: false, mode: 'tab' };
  }
}

/**
 * Open a URL in a dedicated app window, degrading to a browser tab.
 *
 * @param {string} url - Target URL (passed verbatim to spawn argv, no shell)
 * @param {object} [options]
 * @param {Function} [options.spawnImpl] - Injectable spawn for unit tests
 * @param {Function} [options.openDefaultImpl] - Injectable tab-fallback opener for unit tests
 * @returns {{ opened: boolean, mode: 'app-window' | 'tab' }}
 *   mode 'app-window' → dedicated window opened; 'tab' → fell back to the
 *   default browser (opened=false when even the tab fallback failed).
 */
function openAppWindow(url, { spawnImpl, openDefaultImpl } = {}) {
  const sp = spawnImpl || spawn;
  const target = String(url || '').trim();
  if (!target) return { opened: false, mode: 'tab' };

  if (process.platform === 'win32') {
    for (const browser of findAppModeBrowsers()) {
      if (_trySpawnApp(sp, browser, target)) return { opened: true, mode: 'app-window' };
    }
    return _openDefaultTab(target, openDefaultImpl);
  }

  if (process.platform === 'darwin') {
    const macBrowsers = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const browser of macBrowsers) {
      let exists = false;
      try { exists = fs.existsSync(browser); } catch { exists = false; }
      if (exists && _trySpawnApp(sp, browser, target)) return { opened: true, mode: 'app-window' };
    }
    return _openDefaultTab(target, openDefaultImpl);
  }

  // Linux and others: try common Chromium-family commands from PATH.
  const linuxBrowsers = ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'microsoft-edge'];
  for (const cmd of linuxBrowsers) {
    if (_trySpawnApp(sp, cmd, target)) return { opened: true, mode: 'app-window' };
  }
  return _openDefaultTab(target, openDefaultImpl);
}

module.exports = {
  findAppModeBrowsers,
  openAppWindow,
};
