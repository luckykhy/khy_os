/**
 * dev-clean.js — Kill lingering Electron processes before dev server.
 *
 * electron-vite's hot-reload uses ps.kill() which sends SIGTERM on Windows.
 * Electron doesn't handle SIGTERM, so old processes survive and lock the
 * GPUCache directory, causing "Unable to move the cache: ACCESS_DENIED" errors.
 *
 * This script force-kills stale electron.exe processes, then waits for
 * Windows to release file locks before electron-vite starts.
 *
 * NOTE: We must NOT kill node.exe here because that would kill our own
 * parent process (npm run dev → node scripts/dev-clean.js).
 */
const { execSync } = require('child_process')

try {
  execSync('taskkill /F /IM electron.exe 2>nul', { stdio: 'ignore' })
} catch {
  // No matching process
}

// Wait for Windows to release file locks on GPUCache
try {
  execSync('ping -n 4 127.0.0.1 >nul', { stdio: 'ignore' })
} catch {
  // ignore
}

console.log('[dev-clean] Stale electron processes killed, file locks released')
