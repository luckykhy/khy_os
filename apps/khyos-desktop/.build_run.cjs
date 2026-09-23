const { spawn } = require('child_process');
const npmCli = 'D:/Portable/Tools/commandcode/npm-global/node_modules/npm/bin/npm-cli.js';
const appDir = 'D:/Portable/khy-os/apps/khyos-desktop';
const child = spawn(process.execPath, [npmCli, 'run', 'build'], { cwd: appDir, stdio: 'inherit' });
child.on('exit', (code) => { console.log('BUILD EXIT', code); process.exitCode = code || 0; });
