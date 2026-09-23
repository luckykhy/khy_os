// launch detached electron, log to file
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = 'D:/Portable/khy-os/apps/khyos-desktop';
const electron = path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe');
const logFile = fs.openSync(app + '/.verify_run2.log', 'w');
const child = spawn(electron, [path.join(app, 'out', 'main', 'index.js')], {
  cwd: app,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', logFile, logFile],
  detached: true,
});
child.on('exit', (code) => { console.log('electron exited', code); });
child.unref();
console.log('spawned pid', child.pid);
setTimeout(() => process.exit(0), 3000);
