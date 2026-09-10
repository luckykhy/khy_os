'use strict';

/**
 * NSIS Installer Build Script for khy-os
 *
 * Reads version from pyproject.toml → packages payload zip → invokes makensis
 *
 * Usage:
 *   node packaging/installer/build_installer.js
 *
 * Prerequisites:
 *   - NSIS 3.x installed and in PATH (makensis)
 *   - dist/executables/win-x64/khy-win-x64.exe exists (run build-all.js first)
 *   - packaging/installer/assets/ contains wizard.ico and header.bmp
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PAYLOAD_DIR = path.join(__dirname, 'payload');
const ASSETS_DIR = path.join(__dirname, 'assets');
const RELEASES_DIR = path.join(ROOT, 'dist', 'releases');

// ── Read version from pyproject.toml ──
function getVersion() {
  const tomlPath = path.join(ROOT, 'pyproject.toml');
  const content = fs.readFileSync(tomlPath, 'utf8');
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error('Could not find version in pyproject.toml');
  return match[1];
}

// ── Locate the khy executable ──
function findKhyExecutable(version) {
  const candidates = [
    path.join(ROOT, 'dist', 'executables', 'win-x64', 'khy-win-x64.exe'),
    path.join(ROOT, 'dist', 'executables', 'win-x64', `khy-${version}-win-x64.exe`),
    path.join(ROOT, 'dist', 'executables', 'win-x64', 'khy-os-win-x64.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fallback: glob for any .exe
  const exeDir = path.join(ROOT, 'dist', 'executables', 'win-x64');
  if (fs.existsSync(exeDir)) {
    const files = fs.readdirSync(exeDir).filter(f => f.endsWith('.exe'));
    if (files.length > 0) return path.join(exeDir, files[0]);
  }
  return null;
}

// ── Create payload directory with khy.exe + _internal structure ──
function buildPayload(khyExe) {
  console.log('\n[build_installer] Building payload...');

  // Clean and create payload dir
  if (fs.existsSync(PAYLOAD_DIR)) {
    fs.rmSync(PAYLOAD_DIR, { recursive: true });
  }
  fs.mkdirSync(PAYLOAD_DIR, { recursive: true });
  fs.mkdirSync(path.join(PAYLOAD_DIR, '_internal'), { recursive: true });

  // Copy khy.exe as the main entry
  fs.copyFileSync(khyExe, path.join(PAYLOAD_DIR, 'khy.exe'));

  // Write version marker
  const version = getVersion();
  fs.writeFileSync(path.join(PAYLOAD_DIR, '_internal', 'version.txt'), version);

  // Copy any bundled runtime files if they exist
  const runtimeDir = path.join(ROOT, 'platform', 'khy_platform', 'bundled', 'runtime', 'khy');
  if (fs.existsSync(runtimeDir)) {
    fs.copyFileSync(
      path.join(runtimeDir, 'bundle.mjs'),
      path.join(PAYLOAD_DIR, '_internal', 'bundle.mjs')
    );
  }

  // Create zip archive of payload
  const zipPath = path.join(__dirname, 'khy-pkg.zip');

  // Use PowerShell to create zip (Windows-native, no extra deps)
  try {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${PAYLOAD_DIR}\\*' -DestinationPath '${zipPath}' -Force"`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    // Fallback: use Node's built-in if available (Node 22+ has zip support)
    console.warn('[build_installer] PowerShell zip failed, trying alternative...', e.message);
    // Last resort: just copy files directly into installer dir
    console.log('[build_installer] Will embed files directly (no zip)');
    return null;
  }

  const zipSize = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[build_installer] Payload zip: ${zipSize} MB → ${path.relative(ROOT, zipPath)}`);
  return zipPath;
}

// ── Check NSIS availability ──────
function checkNsis() {
  try {
    const output = execSync('makensis /VERSION', { encoding: 'utf8' });
    console.log(`[build_installer] NSIS: ${output.trim()}`);
    return true;
  } catch (e) {
    console.error('[build_installer] NSIS not found. Install from https://nsis.sourceforge.io/Download');
    console.error('[build_installer] Or: winget install NSIS.NSIS');
    return false;
  }
}

// ── Run makensis ──
function compileNsi(nsiFile, version) {
  console.log(`\n[build_installer] Compiling ${path.basename(nsiFile)}...`);

  if (!fs.existsSync(RELEASES_DIR)) {
    fs.mkdirSync(RELEASES_DIR, { recursive: true });
  }

  const args = [
    `/V4`,
    `/DVERSION=${version}`,
    `/XOutFile "${path.join(RELEASES_DIR, `khy-os_setup_v${version}.exe`)}"`,
    `"${nsiFile}"`,
  ];

  try {
    execFileSync('makensis', args, { stdio: 'inherit', windowsHide: true });
  } catch (e) {
    console.error('[build_installer] makensis failed. Ensure NSIS is in PATH and assets exist.');
    throw e;
  }
}

// ── Main ──
async function main() {
  console.log('═'.repeat(60));
  console.log('  khy-os NSIS Installer Builder');
  console.log('═'.repeat(60));

  const version = getVersion();
  console.log(`\n  Version: ${version}`);

  // Check prerequisites
  if (!checkNsis()) {
    console.error('\n[build_installer] ⚠ NSIS not available. Creating stub for dev mode.');
    console.log('[build_installer] To build the full installer, install NSIS and re-run.');
    process.exit(1);
  }

  // Find khy executable
  const khyExe = findKhyExecutable(version);
  if (!khyExe) {
    console.error('[build_installer] khy executable not found. Run "node packaging/build/build-all.js" first.');
    console.error('[build_installer] Expected at: dist/executables/win-x64/khy-win-x64.exe');
    process.exit(1);
  }
  console.log(`  Executable: ${path.relative(ROOT, khyExe)}`);

  // Build payload
  buildPayload(khyExe);

  // Compile installer
  const nsiPath = path.join(__dirname, 'khyos_setup.nsi');
  if (!fs.existsSync(nsiPath)) {
    console.error(`[build_installer] NSIS script not found: ${nsiPath}`);
    process.exit(1);
  }

  compileNsi(nsiPath, version);

  // Output result
  const outFile = path.join(RELEASES_DIR, `khy-os_setup_v${version}.exe`);
  if (fs.existsSync(outFile)) {
    const size = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(1);
    console.log(`\n  ✓ Installer created: ${path.relative(ROOT, outFile)}`);
    console.log(`  Size: ${size} MB`);
  } else {
    console.error('[build_installer] Output file not generated.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n[build_installer] Fatal error:', err);
  process.exit(1);
});
