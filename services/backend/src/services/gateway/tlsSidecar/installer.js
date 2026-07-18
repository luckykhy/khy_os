/**
 * TLS Sidecar Installer — build the Go binary from bundled source, or adopt
 * a user-supplied prebuilt binary.
 *
 * tls-sidecar is a first-party Go program (no third-party prebuilt upstream):
 *   1) if a prebuilt binary already sits at ~/.khyquant/bin/tls-sidecar, use it;
 *   2) otherwise, when Go 1.21+ is installed, compile it locally from the
 *      bundled `sidecar.go` source (`buildFromSource`).
 * There is deliberately no remote download step — see `describeSidecarDownload`
 * for the "where does the binary come from" guidance surfaced to the Web UI.
 */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.khyquant');
const BIN_DIR = path.join(DATA_DIR, 'bin');
const BINARY_NAME = process.platform === 'win32' ? 'tls-sidecar.exe' : 'tls-sidecar';
const BINARY_PATH = path.join(BIN_DIR, BINARY_NAME);
const SOURCE_PATH = path.join(__dirname, 'sidecar.go');

/**
 * Check if binary exists and is executable.
 */
function isInstalled() {
  try {
    fs.accessSync(BINARY_PATH, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the binary path.
 */
function getBinaryPath() {
  return BINARY_PATH;
}

/**
 * Check if Go toolchain is available.
 */
function hasGo() {
  try {
    const result = spawnSync('go', ['version'], { encoding: 'utf-8', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Build from source using Go.
 */
function buildFromSource() {
  if (!hasGo()) return false;

  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });

    // Initialize go module in a temp dir for building
    const buildDir = path.join(DATA_DIR, 'tls-sidecar-build');
    fs.mkdirSync(buildDir, { recursive: true });

    // Copy source
    fs.copyFileSync(SOURCE_PATH, path.join(buildDir, 'sidecar.go'));

    // Init module and get dependency
    execSync('go mod init tls-sidecar', { cwd: buildDir, stdio: 'pipe', timeout: 30000 });
    execSync('go get github.com/refraction-networking/utls', { cwd: buildDir, stdio: 'pipe', timeout: 120000 });
    execSync(`go build -o "${BINARY_PATH}" sidecar.go`, { cwd: buildDir, stdio: 'pipe', timeout: 120000 });

    // Cleanup build dir
    fs.rmSync(buildDir, { recursive: true, force: true });

    return isInstalled();
  } catch (err) {
    console.error(`[TLS Sidecar] Build failed: ${err.message}`);
    return false;
  }
}

/**
 * Attempt to install the TLS sidecar binary.
 * Priority: existing binary → build from source → fail.
 */
function install() {
  if (isInstalled()) return { success: true, path: BINARY_PATH, method: 'existing' };

  if (buildFromSource()) return { success: true, path: BINARY_PATH, method: 'built' };

  return { success: false, path: null, method: null, error: 'Go toolchain not found. Install Go 1.21+ (https://go.dev/dl/) to build the TLS sidecar, or place a prebuilt tls-sidecar binary in ~/.khyquant/bin/.' };
}

/**
 * Describe where the tls-sidecar binary comes from — the deterministic SSOT
 * for the "去哪下载" guidance the Web UI (Settings → Proxy) and CLI surface.
 *
 * tls-sidecar has NO third-party prebuilt upstream: it is compiled locally from
 * the bundled `sidecar.go`. So the honest answer has two paths, both returned
 * here for the frontend to render as clickable link + copyable landing path:
 *   - install the Go toolchain (go.dev/dl) → the sidecar auto-builds on start;
 *   - or drop your own prebuilt `tls-sidecar` at `dest` and restart.
 *
 * Pure/read-only: reads no env, touches no network, never throws. Gating (the
 * KHY_PROXY_CORE_DOWNLOAD_HINT master switch) lives in the caller (getStatus),
 * mirroring proxyCoreManager._coreDownload → describeCoreDownload.
 */
function describeSidecarDownload() {
  return {
    binaryName: BINARY_NAME,
    binDir: BIN_DIR,
    dest: BINARY_PATH,
    sourcePath: SOURCE_PATH,
    // First-party program: the "download" is really "install Go, auto-build",
    // so we point at the Go toolchain rather than a binary release asset.
    goDownloadUrl: 'https://go.dev/dl/',
    minGoVersion: '1.21',
    buildFromSource: true,
    note: '本机装 Go 1.21+ 后启动即自动从内置源码编译；或将已编译的 tls-sidecar 放到落地路径后重启。',
  };
}

module.exports = { isInstalled, getBinaryPath, hasGo, buildFromSource, install, describeSidecarDownload };
