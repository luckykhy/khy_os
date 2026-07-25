'use strict';

/**
 * Handler for `khy modules` command.
 * Manages modular packaging — list, info, and build standalone executables.
 */

const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

// Path to module catalog
const MODULES_JSON = path.resolve(__dirname, '../../../../packaging/modules/modules.json');

function loadModulesCatalog() {
  try {
    return JSON.parse(fs.readFileSync(MODULES_JSON, 'utf8'));
  } catch (err) {
    return null;
  }
}

async function handleModules(args) {
  const subCommand = args[0] || 'list';

  switch (subCommand) {
    case 'list':
      return listModules();
    case 'info':
      return infoModule(args[1]);
    case 'build':
      return buildModule(args[1]);
    default:
      console.log(chalk.yellow(`未知子命令: ${subCommand}`));
      console.log('用法: khy modules [list|info|build] [module-id]');
  }
}

function listModules() {
  const catalog = loadModulesCatalog();
  if (!catalog) {
    console.log(chalk.red('模块清单未找到，请确认 packaging/modules/modules.json 存在。'));
    return;
  }

  const Table = require('cli-table3');
  const table = new Table({
    head: [
      chalk.cyan('Module ID'),
      chalk.cyan('Name'),
      chalk.cyan('Platforms'),
      chalk.cyan('Handlers'),
    ],
    style: { head: [], border: [] },
  });

  for (const mod of catalog.modules) {
    table.push([
      chalk.green(mod.id),
      mod.name,
      mod.platforms.length + ' targets',
      Array.isArray(mod.handlers) ? (mod.handlers[0] === '*' ? 'ALL' : mod.handlers.length.toString()) : '0',
    ]);
  }

  console.log(chalk.bold('\n  Khy OS Modules\n'));
  console.log(table.toString());
  console.log(`\n  Total: ${catalog.modules.length} modules | Version: ${catalog.version}`);
  console.log(`  Build: ${chalk.dim('khy modules build <module-id>')}\n`);
}

function infoModule(moduleId) {
  if (!moduleId) {
    console.log(chalk.yellow('用法: khy modules info <module-id>'));
    return;
  }

  const catalog = loadModulesCatalog();
  if (!catalog) {
    console.log(chalk.red('模块清单未找到。'));
    return;
  }

  const mod = catalog.modules.find(m => m.id === moduleId);
  if (!mod) {
    console.log(chalk.red(`模块 "${moduleId}" 未找到。`));
    console.log('可用模块: ' + catalog.modules.map(m => m.id).join(', '));
    return;
  }

  console.log(chalk.bold(`\n  Module: ${mod.name} (${mod.id})\n`));
  console.log(`  ${chalk.dim('Description:')} ${mod.description}`);
  console.log(`  ${chalk.dim('Entry:')}       ${mod.entry}`);
  console.log(`  ${chalk.dim('Platforms:')}   ${mod.platforms.join(', ')}`);
  console.log(`  ${chalk.dim('Handlers:')}    ${Array.isArray(mod.handlers) ? (mod.handlers[0] === '*' ? 'ALL' : mod.handlers.join(', ')) : 'none'}`);
  if (mod.excludeDeps && mod.excludeDeps.length > 0) {
    console.log(`  ${chalk.dim('Excluded:')}    ${mod.excludeDeps.join(', ')}`);
  }
  console.log('');
}

async function buildModule(moduleId) {
  const catalog = loadModulesCatalog();
  if (!catalog) {
    console.log(chalk.red('模块清单未找到。'));
    return;
  }

  if (moduleId && !catalog.modules.find(m => m.id === moduleId)) {
    console.log(chalk.red(`模块 "${moduleId}" 未找到。`));
    return;
  }

  const buildScript = path.resolve(__dirname, '../../../../packaging/build/build-all.js');
  if (!fs.existsSync(buildScript)) {
    console.log(chalk.red('构建脚本未找到: packaging/build/build-all.js'));
    console.log(chalk.dim('请先完成构建基础设施的搭建。'));
    return;
  }

  const { spawn } = require('child_process');
  const spawnArgs = [buildScript];
  if (moduleId) spawnArgs.push('--module', moduleId);

  const target = moduleId || '所有模块';
  console.log(chalk.cyan(`\n  正在构建 ${target}...\n`));

  const child = spawn(process.execPath, spawnArgs, {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '../../../..'),
    windowsHide: true,
  });

  return new Promise((resolve) => {
    child.on('close', (code) => {
      if (code === 0) {
        console.log(chalk.green(`\n  构建完成: ${target}`));
      } else {
        console.log(chalk.red(`\n  构建失败，退出码 ${code}`));
      }
      resolve();
    });
  });
}

module.exports = handleModules;
