/**
 * Cross-platform Electron dev launcher.
 * Sets ELECTRON_DEV=1 and spawns the electron process.
 */
const { spawn } = require('child_process');
const path = require('path');

const isWindows = process.platform === 'win32';

const env = { ...process.env, ELECTRON_DEV: '1' };

const child = spawn(
  isWindows ? 'electron.cmd' : 'electron',
  [path.join(__dirname, '../electron/main.js')],
  {
    stdio: 'inherit',
    env,
    shell: isWindows,
  }
);

child.on('exit', (code) => {
  process.exit(code || 0);
});
