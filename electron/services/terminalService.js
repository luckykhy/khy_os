const { randomUUID } = require('crypto');
const os = require('os');

let pty;
try {
  pty = require('node-pty');
} catch {
  // node-pty not installed — terminal feature unavailable.
  pty = null;
}

const processes = new Map();

function getShell() {
  if (os.platform() === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function sendToRenderer(channel, id, data) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, id, data);
  }
}

const terminalService = {
  async create(options = {}) {
    if (!pty) {
      throw new Error('终端不可用：node-pty 未安装，请运行 npm install node-pty');
    }

    const id = randomUUID();
    const shell = options.shell || getShell();
    const cols = options.cols || 80;
    const rows = options.rows || 24;
    const cwd = options.cwd || os.homedir();

    try {
      const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });

      ptyProcess.onData((data) => {
        sendToRenderer('terminal:data', id, data);
      });

      ptyProcess.onExit(({ exitCode }) => {
        sendToRenderer('terminal:exit', id, exitCode);
        processes.delete(id);
      });

      processes.set(id, { process: ptyProcess, shell, cwd });
      return { id, shell, cols, rows, cwd };
    } catch (err) {
      throw new Error(`创建终端失败：${err.message}`);
    }
  },

  async write(id, data) {
    const entry = processes.get(id);
    if (!entry) {
      throw new Error(`终端不存在：${id}`);
    }
    try {
      entry.process.write(data);
      return { success: true };
    } catch (err) {
      throw new Error(`写入终端失败 (${id})：${err.message}`);
    }
  },

  async resize(id, cols, rows) {
    const entry = processes.get(id);
    if (!entry) {
      throw new Error(`终端不存在：${id}`);
    }
    try {
      entry.process.resize(cols, rows);
      return { success: true, cols, rows };
    } catch (err) {
      throw new Error(`调整终端大小失败 (${id})：${err.message}`);
    }
  },

  async kill(id) {
    const entry = processes.get(id);
    if (!entry) {
      throw new Error(`终端不存在：${id}`);
    }
    try {
      entry.process.kill();
      processes.delete(id);
      return { success: true };
    } catch (err) {
      throw new Error(`终止终端失败 (${id})：${err.message}`);
    }
  },
};

module.exports = terminalService;
