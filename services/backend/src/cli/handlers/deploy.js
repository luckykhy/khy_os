'use strict';

/**
 * `khy deploy` CLI handler.
 *
 * Helps deploy an arbitrary project to a specified location and start it:
 *   khy deploy <target> [source] [--from <src>] [--start] [--cmd "<command>"]
 *                                [--port N] [--name <id>] [--no-install] [--no-build]
 *   khy deploy list
 *   khy deploy status [name]
 *   khy deploy stop   [name]
 *   khy deploy logs   [name] [--lines N]
 *
 * Output is fully transparent: every pipeline step (detect/sync/install/build/
 * start) is printed with its status so the user can see exactly what happened.
 */

const path = require('path');
const fs = require('fs');
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { printError, printInfo, printSuccess, printWarn, printTable } = require('../formatters');
const { safeKill } = require('../../tools/platformUtils');

const SUB_COMMANDS = new Set(['list', 'status', 'stop', 'logs', 'help']);

const STATUS_ICON = {
  ok: chalk.green('✓'),
  skipped: chalk.gray('•'),
  failed: chalk.red('✗'),
};

function lazyDeploy() {
  return require('../../services/deploy');
}

function lazyLedger() {
  return require('../../services/deploy/deployLedger');
}

function printUsage() {
  printInfo('用法:');
  console.log('  khy deploy <目标路径> [源路径]   部署项目到目标位置');
  console.log('    --from <路径>    指定源目录 (默认当前目录)');
  console.log('    --start          部署后立即启动');
  console.log('    --cmd "<命令>"   显式指定启动命令 (覆盖自动探测)');
  console.log('    --port <N>       记录服务端口');
  console.log('    --name <id>      部署标识 (默认目标目录名)');
  console.log('    --no-install     跳过依赖安装');
  console.log('    --no-build       跳过构建步骤');
  console.log('  khy deploy list                  列出所有部署');
  console.log('  khy deploy status [name]         查看部署状态');
  console.log('  khy deploy stop [name]           停止已启动的部署');
  console.log('  khy deploy logs [name] [--lines N]  查看部署日志');
}

function renderSteps(result) {
  for (const step of result.steps) {
    const icon = STATUS_ICON[step.status] || '?';
    const head = `${icon} ${chalk.bold(step.name)}`;
    const detail = String(step.detail || '');
    if (detail.includes('\n')) {
      console.log(`  ${head}`);
      for (const line of detail.split('\n')) console.log(`      ${chalk.gray(line)}`);
    } else {
      console.log(`  ${head}  ${chalk.gray(detail)}`);
    }
  }
}

async function runDeploy(args, options) {
  const target = options.to || args[0];
  if (!target) {
    printError('缺少目标路径');
    printUsage();
    return true;
  }
  const source = options.from || args[1] || process.cwd();

  printInfo(`部署 ${chalk.cyan(path.resolve(source))} → ${chalk.cyan(path.resolve(target))}`);

  let result;
  try {
    result = lazyDeploy().deployProject({
      source,
      target,
      name: options.name,
      start: Boolean(options.start),
      install: !(options['no-install'] || options.noInstall),
      build: !(options['no-build'] || options.noBuild),
      startCmd: options.cmd ? String(options.cmd) : null,
      port: options.port ? parseInt(options.port, 10) : null,
    });
  } catch (err) {
    printError(`部署失败: ${err.message || err}`);
    return true;
  }

  renderSteps(result);

  if (!result.ok) {
    printError(`部署未完成 (${result.name})`);
    return true;
  }

  if (result.status === 'running') {
    printSuccess(`部署完成并已启动: ${result.name} (pid ${result.pid})`);
    if (result.port) printInfo(`端口: ${result.port}`);
    printInfo(`日志: khy deploy logs ${result.name}`);
    printInfo(`停止: khy deploy stop ${result.name}`);
  } else {
    printSuccess(`部署完成: ${result.name} → ${result.target}`);
    if (!options.start && result.plan && result.plan.start) {
      printInfo(`启动命令: ${result.plan.start.display}`);
      printInfo(`如需启动: khy deploy <目标> --start`);
    }
  }
  if (result.notes && result.notes.length) {
    for (const note of result.notes) printWarn(note);
  }
  return true;
}

function resolveOne(name) {
  const ledger = lazyLedger();
  const records = ledger.listReconciled();
  if (records.length === 0) return { error: '尚无部署记录' };
  if (name) {
    const rec = records.find((r) => r.name === name);
    return rec ? { rec } : { error: `未找到部署: ${name}` };
  }
  if (records.length === 1) return { rec: records[0] };
  return { error: '存在多个部署，请指定名称 (khy deploy list)' };
}

async function runList() {
  const records = lazyLedger().listReconciled();
  if (records.length === 0) {
    printInfo('尚无部署记录');
    return true;
  }
  printTable(
    ['名称', '类型', '状态', 'PID', '端口', '目标'],
    records.map((r) => [
      r.name,
      r.type || '-',
      colorStatus(r.status),
      r.pid ? String(r.pid) : '-',
      r.port ? String(r.port) : '-',
      r.target,
    ]),
  );
  return true;
}

function colorStatus(status) {
  switch (status) {
    case 'running': return chalk.green(status);
    case 'deployed': return chalk.cyan(status);
    case 'stopped':
    case 'exited': return chalk.yellow(status);
    case 'failed': return chalk.red(status);
    default: return status || '-';
  }
}

async function runStatus(args) {
  const { rec, error } = resolveOne(args[0]);
  if (error) { printError(error); return true; }
  printTable(
    ['项目', '值'],
    [
      ['名称', rec.name],
      ['类型', rec.type || '-'],
      ['状态', colorStatus(rec.status)],
      ['PID', rec.pid ? String(rec.pid) : '-'],
      ['端口', rec.port ? String(rec.port) : '-'],
      ['源', rec.source || '-'],
      ['目标', rec.target || '-'],
      ['启动命令', rec.startCmd || '-'],
      ['日志', rec.logFile || '-'],
      ['最近启动', rec.startedAt || '-'],
    ],
  );
  return true;
}

async function runStop(args) {
  const { rec, error } = resolveOne(args[0]);
  if (error) { printError(error); return true; }
  if (!rec.pid) {
    printWarn(`部署 ${rec.name} 没有运行中的进程`);
    return true;
  }
  const ledger = lazyLedger();
  const alive = ledger.defaultDeps().isAlive(rec.pid);
  if (!alive) {
    ledger.upsert({ ...rec, status: 'stopped', pid: null });
    printInfo(`进程 ${rec.pid} 已不在运行，已更新状态为 stopped`);
    return true;
  }
  safeKill(rec.pid);
  ledger.upsert({ ...rec, status: 'stopped', pid: null });
  printSuccess(`已停止部署 ${rec.name} (pid ${rec.pid})`);
  return true;
}

async function runLogs(args, options) {
  const { rec, error } = resolveOne(args[0]);
  if (error) { printError(error); return true; }
  if (!rec.logFile || !fs.existsSync(rec.logFile)) {
    printWarn(`部署 ${rec.name} 暂无日志文件`);
    return true;
  }
  const lines = options.lines ? parseInt(options.lines, 10) : 40;
  let content = '';
  try {
    content = fs.readFileSync(rec.logFile, 'utf8');
  } catch (err) {
    printError(`读取日志失败: ${err.message || err}`);
    return true;
  }
  const tail = content.split('\n').slice(-lines).join('\n');
  printInfo(`${rec.name} 日志 (末 ${lines} 行) — ${rec.logFile}`);
  console.log(tail);
  return true;
}

/**
 * Router entrypoint.
 * @param {{subCommand?:string, args?:string[], options?:Object}} parsed
 */
async function handleDeploy(parsed = {}) {
  const args = Array.isArray(parsed.args) ? parsed.args : [];
  const options = parsed.options || {};
  const sub = String(parsed.subCommand || '').toLowerCase();

  if (sub === 'help' || options.help) { printUsage(); return true; }
  if (sub === 'list') return runList();
  if (sub === 'status') return runStatus(args);
  if (sub === 'stop') return runStop(args);
  if (sub === 'logs') return runLogs(args, options);

  // No recognised sub-command → treat the whole tail as a deploy invocation.
  // `subCommand` may actually be the target path (router splits the 2nd token),
  // so fold it back into args when it is not a known verb.
  const deployArgs = (parsed.subCommand && !SUB_COMMANDS.has(sub))
    ? [parsed.subCommand, ...args]
    : args;
  return runDeploy(deployArgs, options);
}

module.exports = { handleDeploy, SUB_COMMANDS };
