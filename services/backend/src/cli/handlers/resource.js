'use strict';

const { createResourceManager } = require('../../services/resources/resourceManager');
const { printSuccess, printError, printInfo, printWarn, printTable } = require('../formatters');

function manager(options = {}) {
  return createResourceManager(options);
}

function printResources(rows) {
  printTable(['资源', '类型', '版本', '状态', '路径'], rows.map(row => [row.id, row.kind, row.version || '-', row.status, row.path || '-']));
}

async function handleResource(subCommand, args = [], options = {}) {
  const sub = String(subCommand || 'status').toLowerCase();
  let resources;
  try { resources = manager(options); } catch (err) { printError(`无法读取资源清单: ${err.message}`); return; }
  const id = args[0];
  try {
    if (sub === 'list' || sub === 'status') {
      const rows = id ? [resources.inspect(id)] : resources.list();
      printResources(rows);
      return;
    }
    if (sub === 'fetch' || sub === 'prefetch') {
      const targets = id ? [id] : resources.list().filter(row => row.policy === 'prefetch').map(row => row.id);
      if (!targets.length) { printInfo('没有匹配的预取资源。'); return; }
      const results = [];
      const { createResourceTaskAdapter } = require('../../services/resources/resourceTask');
      const taskAdapter = createResourceTaskAdapter({ manager: resources });
      for (const target of targets) {
        const fetched = await taskAdapter.fetch(target);
        results.push(fetched.result);
      }
      printResources(results);
      if (results.every(row => ['present', 'provisioned'].includes(row.status))) printSuccess('资源已就绪。');
      else printWarn('部分资源未能就绪。');
      return;
    }
    if (sub === 'verify') {
      const targets = id ? [id] : resources.list().map(row => row.id);
      printResources(targets.map(target => resources.verify(target)));
      return;
    }
    if (sub === 'path') {
      const result = resources.resolve(id);
      if (result.path) console.log(result.path); else printWarn(`资源尚未就绪: ${id}`);
      return;
    }
    if (sub === 'rollback') {
      const result = resources.rollback(id, args[1]);
      if (result.status === 'rolled-back') printSuccess(`已回滚 ${id} 到 ${args[1]}`); else printError(result.error || '回滚失败');
      return;
    }
    if (sub === 'gc') {
      const result = resources.gc({ apply: args.includes('--apply') });
      printInfo(`${result.status === 'cleaned' ? '已清理' : '待清理'} ${result.count} 个未引用 blob（根目录: ${result.root}）`);
      return;
    }
    printError(`未知 resource 子命令: ${sub}`);
  } catch (err) { printError(err.message || String(err)); }
}

module.exports = { handleResource };
