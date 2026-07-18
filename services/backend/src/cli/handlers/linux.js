/**
 * Linux capability handlers:
 * - Network diagnostics for AI connectivity
 * - Safe allowlisted Linux command execution
 */
const os = require('os');
const dns = require('dns').promises;
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printError, printInfo, printSuccess, printWarn, printTable } = require('../formatters');

const ALLOWLIST = new Set([
  'pwd', 'ls', 'cat', 'head', 'tail', 'grep', 'find', 'wc',
  'du', 'df', 'ps', 'whoami', 'uname', 'date', 'ip', 'ss',
  'ping', 'curl',
]);

function _listInterfaces() {
  const rows = [];
  try {
    const all = os.networkInterfaces();
    for (const [name, entries] of Object.entries(all || {})) {
      for (const item of (entries || [])) {
        if (!item || item.internal) continue;
        rows.push([name, item.family, item.address, item.mac || '-']);
      }
    }
  } catch (err) {
    printWarn(`读取网卡信息失败: ${err.message || err}`);
  }
  return rows;
}

async function _checkDns(host) {
  const startedAt = Date.now();
  try {
    const result = await dns.lookup(host);
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      address: result.address,
      family: result.family,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err.message || 'dns lookup failed',
    };
  }
}

function _checkHttps(host, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = https.request({
      hostname: host,
      path: '/',
      method: 'HEAD',
      timeout: timeoutMs,
      headers: { 'User-Agent': 'khy-os-linux-netcheck/1.0' },
    }, (res) => {
      res.resume();
      resolve({
        ok: true,
        statusCode: res.statusCode,
        latencyMs: Date.now() - startedAt,
      });
    });
    req.on('error', (err) => {
      resolve({
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: err.message || 'https request failed',
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`timeout (${timeoutMs}ms)`));
    });
    req.end();
  });
}

function _printLinuxHelp() {
  console.log('');
  console.log(chalk.cyan.bold('  🐧 Linux 能力'));
  console.log('');
  console.log('  linux status                    系统与运行环境状态');
  const defaultNetHost = require('../../constants/serviceDefaults').CLOUD_DEFAULT_HOST;
  console.log(`  linux net [host]               网络诊断（默认 ${defaultNetHost}）`);
  console.log('  linux run <cmd> [args...]      运行基础 Linux 命令（白名单）');
  console.log('');
  console.log('  示例:');
  console.log('    linux net');
  console.log('    linux run pwd');
  console.log('    linux run ls -la');
  console.log('    linux run ping -c 2 1.1.1.1');
  console.log('');
  console.log('  说明: 无网络时云端 AI 不可用，请使用本地模型（models list / khy run <model-id>）。');
  console.log('');
}

function _printStatus() {
  const infoRows = [
    ['Platform', `${os.platform()} ${os.release()}`],
    ['Arch', os.arch()],
    ['Kernel', os.version ? os.version() : '-'],
    ['Host', os.hostname()],
    ['User', os.userInfo().username],
    ['CWD', process.cwd()],
  ];
  console.log('');
  console.log(chalk.cyan.bold('  系统状态'));
  printTable(['项目', '值'], infoRows);
  const interfaces = _listInterfaces();
  if (interfaces.length === 0) {
    printWarn('未检测到可用网卡（非 loopback）');
  } else {
    printInfo(`检测到 ${interfaces.length} 个网络地址`);
    printTable(['网卡', '族', '地址', 'MAC'], interfaces);
  }
}

async function _printNetStatus(hostArg) {
  const host = (hostArg || require('../../constants/serviceDefaults').CLOUD_DEFAULT_HOST).trim();
  if (!host) {
    printError('用法: linux net [host]');
    return;
  }
  console.log('');
  console.log(chalk.cyan.bold(`  网络诊断: ${host}`));
  const interfaces = _listInterfaces();
  if (interfaces.length > 0) {
    printTable(['网卡', '族', '地址', 'MAC'], interfaces);
  } else {
    printWarn('未检测到可用网卡（非 loopback）');
  }

  const dnsResult = await _checkDns(host);
  if (dnsResult.ok) {
    printSuccess(`DNS 正常: ${host} -> ${dnsResult.address} (${dnsResult.latencyMs}ms)`);
  } else {
    printError(`DNS 失败: ${dnsResult.error || 'unknown error'} (${dnsResult.latencyMs}ms)`);
  }

  const httpsResult = await _checkHttps(host);
  if (httpsResult.ok) {
    printSuccess(`HTTPS 可达: status ${httpsResult.statusCode || '-'} (${httpsResult.latencyMs}ms)`);
  } else {
    printError(`HTTPS 失败: ${httpsResult.error || 'unknown error'} (${httpsResult.latencyMs}ms)`);
  }

  if (!dnsResult.ok || !httpsResult.ok) {
    console.log('');
    printWarn('网络异常会影响云端 AI 调用。');
    printInfo('建议:');
    console.log('  1) 先运行 `khy gateway status` 查看通道可用性');
    console.log('  2) 使用本地模型: `models list` / `khy run <model-id>`');
  }
  console.log('');
}

function _runLinuxCommand(cmd, cmdArgs, options = {}) {
  if (!ALLOWLIST.has(cmd)) {
    printError(`不允许的命令: ${cmd}`);
    printInfo(`允许命令: ${Array.from(ALLOWLIST).join(', ')}`);
    return;
  }

  if ((cmdArgs || []).length > 64) {
    printError('参数过多，已拒绝执行');
    return;
  }
  if ((cmdArgs || []).some(a => String(a).length > 1024)) {
    printError('参数长度超限，已拒绝执行');
    return;
  }

  const timeoutMs = Math.min(20000, Math.max(1000, parseInt(options.timeout || '8000', 10) || 8000));
  const builtInHandled = _runBuiltinCommand(cmd, cmdArgs);
  if (builtInHandled) return;

  const startedAt = Date.now();
  const result = spawnSync(cmd, cmdArgs, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const elapsed = Date.now() - startedAt;

  if (result.error) {
    printError(`执行失败: ${result.error.message || result.error}`);
    if (String(result.error.message || '').includes('ENOENT')) {
      printInfo(`系统未安装命令: ${cmd}`);
    }
    return;
  }

  const stdout = (result.stdout || '').trimEnd();
  const stderr = (result.stderr || '').trimEnd();

  if (stdout) console.log(stdout);
  if (stderr) console.log(chalk.yellow(stderr));

  if (result.status === 0) {
    printSuccess(`命令执行成功 (${elapsed}ms)`);
  } else {
    // 红线：不止显示退出码——给出真实原因（stderr）+ 解决方案。
    try {
      require('../cliErrorReporter').reportCliError(
        { exitCode: result.status, stderr, error: result.error && result.error.message },
        { context: '本地命令执行', title: `命令失败（退出码 ${result.status}，${elapsed}ms）` }
      );
    } catch {
      printError(`命令退出码: ${result.status} (${elapsed}ms)`);
    }
  }
}

function _runBuiltinCommand(cmd, cmdArgs) {
  if (cmd === 'pwd') {
    console.log(process.cwd());
    printSuccess('命令执行成功 (builtin)');
    return true;
  }
  if (cmd === 'whoami') {
    console.log(os.userInfo().username);
    printSuccess('命令执行成功 (builtin)');
    return true;
  }
  if (cmd === 'date') {
    console.log(new Date().toString());
    printSuccess('命令执行成功 (builtin)');
    return true;
  }
  if (cmd === 'uname') {
    console.log(`${os.platform()} ${os.release()} ${os.arch()}`);
    printSuccess('命令执行成功 (builtin)');
    return true;
  }
  if (cmd === 'ls') {
    const target = (cmdArgs || []).find(a => !String(a).startsWith('-')) || '.';
    const abs = path.resolve(process.cwd(), target);
    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((e) => {
          const mark = e.isDirectory() ? '/' : '';
          console.log(`${e.name}${mark}`);
        });
      printSuccess('命令执行成功 (builtin)');
    } catch (err) {
      printError(`ls 失败: ${err.message || err}`);
    }
    return true;
  }
  return false;
}

async function handleLinuxCommand(subCommand, args, options = {}) {
  const action = (subCommand || '').toLowerCase();

  if (!action) {
    if (!args || args.length === 0) {
      _printLinuxHelp();
      return;
    }
    // Convenience: "linux ls -la" equals "linux run ls -la"
    _runLinuxCommand(args[0], args.slice(1), options);
    return;
  }

  if (action === 'help') {
    _printLinuxHelp();
    return;
  }
  if (action === 'status') {
    _printStatus();
    return;
  }
  if (action === 'net') {
    await _printNetStatus(args[0]);
    return;
  }
  if (action === 'run') {
    const cmd = args[0];
    if (!cmd) {
      printError('用法: linux run <cmd> [args...]');
      return;
    }
    _runLinuxCommand(cmd, args.slice(1), options);
    return;
  }

  printError(`未知子命令: ${action}`);
  _printLinuxHelp();
}

module.exports = {
  handleLinuxCommand,
};
