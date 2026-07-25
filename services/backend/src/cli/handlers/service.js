/**
 * Service management CLI handlers: server start/status, db init/seed/status.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const http = require('http');
const chalk = require('chalk').default || require('chalk');
const { bootstrap } = require('../bootstrap');
const { printSuccess, printError, printInfo, printTable, withSpinner } = require('../formatters');

const BACKEND_DIR = path.resolve(__dirname, '../../../');

async function handleServerStart(options = {}) {
  const { spawn } = require('child_process');
  const net = require('net');
  const PORT = parseInt(options.port || process.env.PORT || '3000', 10);
  if (options.port) process.env.PORT = String(PORT);
  const STARTUP_WAIT_MS = parseInt(process.env.KHY_SERVER_START_WAIT_MS || '6000', 10);
  const MAX_ERR_CHARS = 1200;

  // Check if already running
  const inUse = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    srv.once('listening', () => { srv.close(); resolve(false); });
    srv.listen(PORT);
  });

  if (inUse) {
    printSuccess(`后端服务已在运行 (端口 ${PORT})`);
    return;
  }

  printInfo('启动后端服务...');
  const serverScript = path.join(BACKEND_DIR, 'server.js');
  const child = spawn(process.execPath, [serverScript], {
    cwd: BACKEND_DIR,
    env: { ...process.env, PORT: String(PORT) },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.unref();

  let earlyExit = false;
  let exitCode = null;
  let earlyError = '';
  const captureEarlyOutput = (chunk) => {
    if (earlyError.length >= MAX_ERR_CHARS) return;
    earlyError += String(chunk || '').slice(0, MAX_ERR_CHARS - earlyError.length);
  };
  child.on('exit', (code) => {
    earlyExit = true;
    exitCode = code;
  });
  child.stdout.on('data', captureEarlyOutput);
  child.stderr.on('data', captureEarlyOutput);

  // Wait for server to bind
  await new Promise(r => setTimeout(r, STARTUP_WAIT_MS));
  const portInUse = async () => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
    srv.once('listening', () => { srv.close(); resolve(false); });
    srv.listen(PORT);
  });
  let nowRunning = await portInUse();
  if (!nowRunning) {
    await new Promise(r => setTimeout(r, 1500));
    nowRunning = await portInUse();
  }

  if (nowRunning) {
    printSuccess(`后端服务已启动 → http://localhost:${PORT}`);
    return;
  }

  if (earlyExit) {
    printError(`后端服务启动失败 (exit code: ${exitCode == null ? 'unknown' : exitCode})`);
    const hint = String(earlyError || '')
      .split('\n')
      .map(s => s.trim())
      .find(Boolean);
    if (hint) {
      printInfo(`错误摘要: ${hint.slice(0, 180)}`);
    } else {
      printInfo('请直接运行: node backend/server.js 查看详细错误');
    }
    return;
  }

  const bindError = /listen\\s+E(?:PERM|ADDRINUSE|ACCES)|uncaught\\s+exception/i.test(earlyError);
  if (bindError) {
    printError('后端服务启动失败 (端口监听异常)');
    const hint = String(earlyError || '')
      .split('\n')
      .map(s => s.trim())
      .find(s => /listen\\s+E(?:PERM|ADDRINUSE|ACCES)|uncaught\\s+exception/i.test(s))
      || String(earlyError || '').split('\n').map(s => s.trim()).find(Boolean);
    if (hint) printInfo(`错误摘要: ${hint.slice(0, 180)}`);
    return;
  }

  printInfo(`后端服务启动中... (端口 ${PORT})，请稍后用 server status 检查`);
}

async function handleServerStatus() {
  const port = process.env.PORT || '3000';
  const host = process.env.HOST || '127.0.0.1';
  const url = `http://${host}:${port}/health`;

  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          printSuccess(`服务运行中 (端口 ${port})`);
          printTable(
            ['项目', '状态'],
            [
              ['状态', chalk.green(data.status || 'ok')],
              ['端口', String(port)],
              ['数据库', data.database || data.db || '-'],
              ['运行时间', data.uptime ? Math.floor(data.uptime) + 's' : '-'],
            ]
          );
        } catch {
          printSuccess(`服务运行中 (端口 ${port})`);
        }
        resolve();
      });
    });

    req.on('error', () => {
      printError(`服务未运行 (端口 ${port})`);
      printInfo('运行 server start 启动服务');
      resolve();
    });

    req.on('timeout', () => {
      req.destroy();
      printError(`服务响应超时 (端口 ${port})`);
      resolve();
    });
  });
}

async function handleDbInit() {
  await withSpinner('初始化数据库...', () => bootstrap({ syncSchema: true }));
  const mode = process.env.DB_MODE || 'sqlite';
  printSuccess(`数据库已初始化 (${mode})`);
}

async function handleDbSeed() {
  await bootstrap({ syncSchema: true, silent: true });

  printInfo('填充示例数据...');
  try {
    execFileSync('node', ['scripts/seed.js'], {
      cwd: BACKEND_DIR,
      stdio: 'inherit',
      timeout: 30000,
    });
    printSuccess('示例数据填充完成');
  } catch (err) {
    printError('数据填充失败: ' + (err.message || 'unknown error'));
  }
}

async function handleDbStatus() {
  await bootstrap({ silent: true });

  const { sequelize, User, Strategy, Instrument, Backtest, Trade } = require('../../models');
  const mode = process.env.DB_MODE || 'unknown';

  printSuccess(`数据库连接正常 (${mode})`);

  const counts = await Promise.all([
    User.count().catch(() => 0),
    Strategy.count().catch(() => 0),
    Instrument.count().catch(() => 0),
    Backtest.count().catch(() => 0),
    Trade.count().catch(() => 0),
  ]);

  printTable(
    ['表', '记录数'],
    [
      ['用户 (User)', String(counts[0])],
      ['策略 (Strategy)', String(counts[1])],
      ['品种 (Instrument)', String(counts[2])],
      ['回测 (Backtest)', String(counts[3])],
      ['交易 (Trade)', String(counts[4])],
    ]
  );

  if (mode === 'sqlite') {
    const { getSQLitePath } = require('../../config/database');
    printInfo(`SQLite 路径: ${getSQLitePath()}`);
  }
}

module.exports = {
  handleServerStart,
  handleServerStatus,
  handleDbInit,
  handleDbSeed,
  handleDbStatus,
};
