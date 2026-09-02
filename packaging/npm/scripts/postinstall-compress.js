// Compress the installed package directory with transparent filesystem
// compression: NTFS LZX on Windows, btrfs/zstd or ZFS on Linux.
// Best-effort: every failure is swallowed so installs never break.
// Detached spawn keeps `npm install` fast; compression finishes in background.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';

function spawnDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, {
      cwd: packageRoot,
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch (err) {
    // best-effort only: compression is an optimization, never a requirement
  }
}

if (process.platform === 'win32') {
  const compact = path.join(systemRoot, 'System32', 'compact.exe');
  // compact.exe syntax note: the positional argument is a filename pattern,
  // /s:<dir> sets the recursion root and an explicit "*" pattern is required,
  // otherwise compact matches no files and compresses nothing.
  spawnDetached(compact, ['/c', '/s:' + packageRoot, '/q', '/exe:lzx', '*']);
} else if (process.platform === 'linux' || process.platform === 'darwin') {
  const helper = path.join(__dirname, 'install', 'enable-fs-compression.sh');
  spawnDetached('bash', [helper, '--project-root', packageRoot, '--no-pnpm-store']);
}
// Other platforms have no supported transparent compression; do nothing.

process.exit(0);
