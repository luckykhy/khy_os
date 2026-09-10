const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let backendProcess = null;

function findBackendEntry() {
  // Try workspace backend first (dev), then packaged path.
  const candidates = [
    path.join(__dirname, '../../services/backend/bin/khy.js'),
    path.join(__dirname, '../services/backend/bin/khy.js'),
    path.join(process.resourcesPath || '', 'services/backend/bin/khy.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const backendService = {
  getStatus() {
    return {
      running: !!backendProcess,
      pid: backendProcess?.pid || null,
      uptime: backendProcess ? Date.now() - backendProcess.startTime : 0,
    };
  },

  async start() {
    if (backendProcess) {
      return { success: true, pid: backendProcess.pid, alreadyRunning: true };
    }

    const entry = findBackendEntry();
    if (!entry) {
      throw new Error('启动失败：未找到后端入口文件 (services/backend/bin/khy.js)');
    }

    try {
      backendProcess = spawn(process.execPath, [entry], {
        cwd: path.dirname(entry),
        env: { ...process.env, KHY_BACKEND_MODE: 'desktop' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      backendProcess.startTime = Date.now();

      backendProcess.stdout.on('data', (data) => {
        console.log(`[backend] ${data.toString().trim()}`);
      });

      backendProcess.stderr.on('data', (data) => {
        console.error(`[backend:err] ${data.toString().trim()}`);
      });

      backendProcess.on('exit', (code) => {
        console.log(`[backend] 进程退出，退出码 ${code}`);
        backendProcess = null;
      });

      return { success: true, pid: backendProcess.pid };
    } catch (err) {
      backendProcess = null;
      throw new Error(`启动后端失败：${err.message}`);
    }
  },

  async stop() {
    if (!backendProcess) {
      return { success: true, wasRunning: false };
    }

    const pid = backendProcess.pid;
    try {
      backendProcess.kill('SIGTERM');
      // Give it 3s to exit gracefully, then force kill.
      const forceKill = setTimeout(() => {
        if (backendProcess) {
          try { backendProcess.kill('SIGKILL'); } catch { /* already dead */ }
        }
      }, 3000);

      // If it exits before the timeout, clear the force-kill timer.
      backendProcess.on('exit', () => clearTimeout(forceKill));

      backendProcess = null;
      return { success: true, pid };
    } catch (err) {
      throw new Error(`停止后端失败 (pid ${pid})：${err.message}`);
    }
  },
};

module.exports = backendService;
