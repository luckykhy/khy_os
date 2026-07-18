'use strict';

/**
 * handlers/tools.js — `khy tools` 便携 CLI 管理命令。
 *
 * 让用户/AI 显式管理装进 khy 数据家 `~/.khy/tools/` 的便携 CLI(claude/codex/opencode):
 *   - `khy tools list`             列出全部便携工具及其安装/解析状态。
 *   - `khy tools install <tool>`   把某工具的便携版装进数据家(npm install <pkg>@latest)。
 *   - `khy tools update <tool>`    更新到最新(与 install 同实现,@latest)。
 *   - `khy tools path <tool>`      打印该工具便携安装的包目录(供诊断)。
 *
 * 这是 ide.js 交互确认自动安装之外的显式入口——同一套注册表/解析器/安装器。
 */

const { printSuccess, printError, printInfo, printWarn, printTable } = require('../formatters');
const registry = require('../../services/gateway/adapters/portableCliRegistry');
const resolver = require('../../services/gateway/adapters/portableCliResolver');
const installer = require('../../services/gateway/adapters/portableCliInstaller');

/**
 * 便携工具根目录(默认 `~/.khy/tools`)。解析器是纯叶子、不会自行定位数据家,
 * 因此这里由(非纯的)handler 注入。用 getDataHome()+join 而非 getDataDir,
 * 避免在只读的 list/path 路径上顺手创建空的 tools 目录(真正安装时安装器才建)。
 * KHY_TOOLS_DIR 若已设置,解析器内部会优先采用它——这里的注入只作缺省。
 */
function _toolsRoot() {
  try {
    const path = require('path');
    const { getDataHome } = require('../../utils/dataHome');
    return path.join(getDataHome(), 'tools');
  } catch {
    return undefined;
  }
}

/** 渲染全部便携工具的状态表。 */
function handleToolsList() {
  const toolsRoot = _toolsRoot();
  const rows = registry.listTools().map((t) => {
    const installed = resolver.isInstalled(t.key, { toolsRoot });
    const native = registry.hasNativeResolver(t.key);
    let state;
    if (native) state = installed ? '便携已装(专用解析)' : '专用解析(PATH/便携)';
    else state = installed ? '便携已装' : '未装(可 khy tools install)';
    return [t.key, t.pkg, installed ? '✓' : '', state];
  });
  console.log('');
  console.log('  便携 CLI 工具');
  console.log('');
  printTable(['工具', 'npm 包', '已装', '状态'], rows);
  console.log('');
  printInfo('安装/更新:khy tools install <工具> · khy tools update <工具>');
}

/** 装或更新一个工具(verb 仅影响提示文案,底层同实现)。 */
async function _installOrUpdate(toolKey, verb) {
  if (!registry.isKnownTool(toolKey)) {
    printError(`未知便携工具: ${toolKey || '(空)'}。可用:${registry.listTools().map((t) => t.key).join(' / ')}`);
    return;
  }
  const tool = registry.getTool(toolKey);
  printInfo(`正在${verb} ${tool.key} 便携版(${tool.pkg}@latest)…`);
  const result = await installer.install(tool.key, {
    onProgress: (text) => { const s = String(text).trim(); if (s) process.stdout.write(`  ${s}\n`); },
  });
  if (result.ok) {
    printSuccess(`${tool.key} 便携版已${verb}到 ${result.packageDir || '数据家 tools 目录'}`);
    printInfo(`现在可直接运行:khy ${tool.key}`);
  } else if (result.gated) {
    printWarn(result.error);
  } else {
    printError(`${verb} ${tool.key} 失败: ${result.error || '未知错误'}`);
  }
}

/** 打印某工具便携安装的包目录。 */
function handleToolsPath(toolKey) {
  if (!registry.isKnownTool(toolKey)) {
    printError(`未知便携工具: ${toolKey || '(空)'}`);
    return;
  }
  const toolsRoot = _toolsRoot();
  const dir = resolver.packageDir(toolKey, { toolsRoot });
  const installed = resolver.isInstalled(toolKey, { toolsRoot });
  console.log(dir || '(无法定位便携根目录)');
  if (!installed) printInfo('尚未安装:khy tools install ' + toolKey);
}

/** 路由入口:khy tools <sub> [tool]。 */
async function handleToolsCommand(subCommand, args = []) {
  const sub = String(subCommand || 'list').toLowerCase();
  const tool = (args && args[0]) || '';
  if (sub === 'list' || sub === 'ls' || sub === 'status') return handleToolsList();
  if (sub === 'install' || sub === 'add') return _installOrUpdate(tool, '安装');
  if (sub === 'update' || sub === 'upgrade') return _installOrUpdate(tool, '更新');
  if (sub === 'path' || sub === 'where') return handleToolsPath(tool);
  printError(`未知子命令: ${sub}。可用:list | install <工具> | update <工具> | path <工具>`);
}

module.exports = { handleToolsCommand };
