'use strict';

/**
 * manage handler — `khy manage`（统一管理面 CLI 适配层）
 *
 *   khy manage                      列出所有可管理资源及其能力矩阵
 *   khy manage list                 同上
 *   khy manage <resource>           列出某资源（等价于 <resource> list）
 *   khy manage <resource> <op> [k=v ...] [--json]
 *
 * 本 handler 不直接读写任何数据源。它只是把命令解析成
 * managementRegistry.invoke(resource, op, args, { source: 'cli' })，
 * 与 Web 适配层走同一个漏斗 —— 因此 CLI 与可视化管理永不矛盾。
 */

function fmt() {
  return require('../formatters');
}

const registry = () => require('../../services/management');

/** 解析 `key=value` 形式的位置参数为 args 对象；数字串转 number。 */
function _parseKvArgs(tokens) {
  const out = {};
  for (const tok of tokens) {
    const raw = String(tok || '');
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    let val = raw.slice(eq + 1);
    if (!key) continue;
    if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
    out[key] = val;
  }
  return out;
}

function _printMatrix(reg, f) {
  const rows = reg.describe();
  f.printInfo('统一管理面 · 可管理资源');
  f.printInfo('─'.repeat(56));
  for (const r of rows) {
    f.printSuccess(`${r.id}  (${r.label})`);
    f.printInfo(`  来源: ${r.source}:${r.sourceDetail}`);
    f.printInfo(`  能力: ${r.capabilities.join(', ')}`);
  }
  f.printInfo('─'.repeat(56));
  f.printInfo('用法: khy manage <resource> <op> [key=value ...] [--json]');
}

async function handleManage(parsed = {}) {
  const f = fmt();
  const rawArgs = Array.isArray(parsed.args) ? parsed.args.slice() : [];
  const jsonMode = rawArgs.includes('--json');
  const tokens = rawArgs.filter((a) => a !== '--json');

  // parsed.subCommand 是第一个位置参数（资源名或 list）。
  const first = String(parsed.subCommand || tokens[0] || '').trim();
  const reg = registry();

  // 无参数 / `list` → 打印能力矩阵。
  if (!first || first.toLowerCase() === 'list') {
    if (jsonMode) {
      f.printRaw ? f.printRaw(JSON.stringify(reg.describe(), null, 2)) : console.log(JSON.stringify(reg.describe(), null, 2));
    } else {
      _printMatrix(reg, f);
    }
    return true;
  }

  const resourceId = first;
  // tokens[0] 即资源名（若 subCommand 已吃掉它，则 op 在 tokens[0]，否则 tokens[1]）。
  const restAfterResource = parsed.subCommand
    ? tokens.filter((t) => t !== parsed.subCommand)
    : tokens.slice(1);

  const contract = reg.get(resourceId);
  if (!contract) {
    f.printError(`未知资源: ${resourceId}`);
    f.printInfo(`可用资源: ${reg.listIds().join(', ')}`);
    process.exitCode = 1;
    return true;
  }

  // 缺 op → 默认 list（若支持），否则列出能力。
  let op = String(restAfterResource[0] || '').trim();
  const opArgsTokens = restAfterResource.slice(1);
  if (!op) {
    if (contract.capabilities.includes('list')) {
      op = 'list';
    } else {
      f.printInfo(`资源 ${resourceId} 的能力: ${contract.capabilities.join(', ')}`);
      return true;
    }
  }

  if (!contract.capabilities.includes(op)) {
    f.printError(`资源 ${resourceId} 不支持操作: ${op}`);
    f.printInfo(`可用操作: ${contract.capabilities.join(', ')}`);
    process.exitCode = 1;
    return true;
  }

  const opArgs = _parseKvArgs(opArgsTokens);

  try {
    const result = await reg.invoke(resourceId, op, opArgs, { source: 'cli' });
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      _renderResult(resourceId, op, result, f);
    }
    return true;
  } catch (err) {
    f.printError(`管理操作失败 [${resourceId} ${op}]: ${err.message}`);
    process.exitCode = 1;
    return true;
  }
}

/** 人类可读渲染；结构未知时回退为 JSON。 */
function _renderResult(resourceId, op, result, f) {
  if (result == null) {
    f.printSuccess(`${resourceId} ${op}: 完成`);
    return;
  }
  // 安装类操作的分级回执（manualOnly / offline）。
  if (result.manualOnly) {
    f.printWarn(result.reason || '该依赖需手动安装。');
    if (result.displayCommand) f.printInfo(`  命令: ${result.displayCommand}`);
    if (result.docsUrl) f.printInfo(`  文档: ${result.docsUrl}`);
    return;
  }
  if (result.offline) {
    f.printError(result.error || '当前离线，无法安装。');
    return;
  }
  // 列表类：尝试打印数组字段。
  const arrayKey = Object.keys(result).find((k) => Array.isArray(result[k]));
  if (arrayKey) {
    f.printInfo(`${resourceId} ${op} · ${result[arrayKey].length} 项`);
    for (const item of result[arrayKey]) {
      f.printInfo(`  ${typeof item === 'object' ? JSON.stringify(item) : item}`);
    }
    return;
  }
  if (result.success === false) {
    f.printError(`${resourceId} ${op} 失败${result.error ? `: ${result.error}` : ''}`);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { handleManage, _parseKvArgs };
