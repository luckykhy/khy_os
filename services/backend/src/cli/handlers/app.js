/**
 * /app command handler — manage khy platform applications.
 *
 * Usage:
 *   /app                  — list installed apps
 *   /app install <name>   — install an app via pip
 *   /app uninstall <name> — uninstall an app
 *   /app start <name>     — start an app's backend
 *   /app stop <name>      — stop an app
 *   /app status           — show all apps and their running state
 */
const chalk = require('chalk').default || require('chalk');
const { printSuccess, printError, printInfo, printTable } = require('../formatters');
const { SUPPORTED_ABIS, DEFAULT_ABI } = require('../../constants/wasmDefaults');

const SUPPORTED_WASM_IMPORTS = Object.freeze({
  khy_sys: new Set([
    'cap_check',
    'ipc_call',
    'ipc_last_len',
    'ipc_last_status',
    'shm_create',
    'shm_map',
  ]),
  spectest: new Set([
    'print_char',
  ]),
});

let _registry;
function registry() {
  if (!_registry) _registry = require('../../services/appRegistry');
  return _registry;
}

/**
 * Main handler — dispatches to sub-commands.
 */
async function handleApp(subCommand, args, options) {
  // KHYanything sub-commands (khy-*) and legacy CLI-Anything aliases (cli-*)
  if (subCommand && (subCommand.startsWith('khy-') || subCommand.startsWith('cli-'))) {
    return await _handleCLIAnything(subCommand, args, options);
  }

  switch (subCommand) {
    case 'register':
      return await handleRegister(args[0], options);
    case 'install':
      return await handleInstall(args[0], options);
    case 'uninstall':
      return await handleUninstall(args[0]);
    case 'start':
      return await handleStart(args[0], options);
    case 'stop':
      return await handleStop(args[0]);
    case 'run':
      return await handleRun(args[0], args.slice(1), options);
    case 'ipc':
      return await handleIpc(args[0], args.slice(1), options);
    case 'exports':
      return await handleExports(args[0]);
    case 'status':
      return await handleStatus();
    case 'list':
    default:
      return await handleList();
  }
}

function _parseCommandsFromOptions(name, options = {}) {
  const raw = (options.commands || '').trim();
  if (!raw) return [name];
  const parsed = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : [name];
}

function _parseCapabilitiesOption(rawCaps) {
  if (!rawCaps || rawCaps === true) return ['ipc'];
  const allowed = new Set(['ipc', 'net', 'fs_read', 'fs_write', 'window', 'shm', 'irq_bind']);
  const caps = String(rawCaps)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (caps.length === 0) return ['ipc'];

  for (const cap of caps) {
    if (!allowed.has(cap)) {
      throw new Error(`不支持的 capability: ${cap}`);
    }
  }

  return [...new Set(caps)];
}

function _inspectWasmModuleMeta(wasmPath) {
  const fs = require('fs');
  const bytes = fs.readFileSync(wasmPath);
  const module = new WebAssembly.Module(bytes);
  const exportsMeta = WebAssembly.Module.exports(module);
  const importsMeta = WebAssembly.Module.imports(module);
  return {
    exportsMeta,
    importsMeta,
    functionExports: exportsMeta.filter(e => e.kind === 'function').map(e => e.name),
  };
}

function _resolveDefaultWasmExport(meta, requestedExport) {
  const funcs = meta.functionExports || [];
  if (!funcs.length) return null;

  if (requestedExport) {
    return funcs.includes(requestedExport) ? requestedExport : null;
  }

  if (funcs.includes('main')) return 'main';
  if (funcs.includes('_start')) return '_start';
  if (funcs.length === 1) return funcs[0];
  return null;
}

function _formatImportRef(imp) {
  return `${imp.module}.${imp.name} (${imp.kind})`;
}

function _findUnsupportedWasmImports(importsMeta = []) {
  const unsupported = [];
  for (const imp of importsMeta) {
    const supportedNames = SUPPORTED_WASM_IMPORTS[imp.module];
    if (!supportedNames) {
      unsupported.push(imp);
      continue;
    }
    if (imp.kind !== 'function') {
      unsupported.push(imp);
      continue;
    }
    if (!supportedNames.has(imp.name)) {
      unsupported.push(imp);
    }
  }
  return unsupported;
}

async function handleList() {
  const apps = registry().list();

  console.log('');
  console.log(chalk.cyan.bold('  KHY 应用管理'));
  console.log('');

  if (apps.length === 0) {
    printInfo('暂无已安装的应用');
    printInfo('使用 /app install <name> 安装应用，例如: /app install khyquant');
    console.log('');
    return;
  }

  for (const app of apps) {
    const st = await registry().status(app.name);
    const statusIcon = st.running
      ? chalk.green('● 运行中')
      : chalk.dim('○ 未启动');
    const portInfo = st.running ? chalk.dim(` :${st.port}`) : '';

    console.log(`  ${statusIcon} ${chalk.white.bold(app.name)}${portInfo}`);
    console.log(chalk.dim(`    ${app.description || '-'}`));
    console.log(chalk.dim(`    版本: ${app.version} · 来源: ${app.source} · 运行时: ${app.runtime || 'node'} · 命令: ${(app.commands || []).join(', ')}`));
    console.log('');
  }

  // Discover pip-installed khy-* packages not yet registered
  try {
    const discovered = await registry().discover();
    const registered = new Set(apps.map(a => a.name));
    const unregistered = discovered.filter(d => !registered.has(d.name.replace('khy-', '')));
    if (unregistered.length > 0) {
      console.log(chalk.dim('  可用的未注册应用:'));
      for (const pkg of unregistered) {
        console.log(chalk.dim(`    ${pkg.name} (${pkg.version}) — 运行 /app install ${pkg.name.replace('khy-', '')}`));
      }
      console.log('');
    }
  } catch { /* discovery is best-effort */ }
}

async function handleRegister(name, options = {}) {
  if (!name) {
    printError('用法: /app register <name> --entry <path> [--runtime node|wasm]');
    printInfo('WASM 例子: /app register demo --runtime wasm --wasm /abs/demo.wasm --abi numeric-v1 --export main');
    printInfo('WASM string-v2: /app register echo --runtime wasm --wasm /abs/echo.wasm --abi string-v2 --export run');
    printInfo('WASM json-v2: /app register score --runtime wasm --wasm /abs/score.wasm --abi json-v2 --export run');
    printInfo('WASM capability: --caps ipc,net,window (默认仅 ipc)');
    printInfo('WASM khy_sys: --khy-memory <exportName> (默认 memory)');
    return;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    printError('应用名只能包含字母、数字、连字符和下划线');
    return;
  }

  if (registry().get(name)) {
    printError(`应用 "${name}" 已注册`);
    return;
  }

  const runtime = String(options.runtime || 'node').toLowerCase();
  const source = options.source || 'local';
  const commands = _parseCommandsFromOptions(name, options);
  const description = options.description || (runtime === 'wasm' ? `${name} WASM component` : `${name} app`);

  if (runtime === 'wasm') {
    const pathModule = require('path');
    const fs = require('fs');
    const wasmPathRaw = options.wasm || options.entry;
    if (!wasmPathRaw) {
      printError('WASM 应用必须提供 --wasm <path> 或 --entry <path>');
      return;
    }

    const wasmPath = pathModule.resolve(wasmPathRaw);
    if (!fs.existsSync(wasmPath)) {
      printError(`WASM 文件不存在: ${wasmPath}`);
      return;
    }

    const abi = String(options.abi || DEFAULT_ABI).toLowerCase();
    if (!SUPPORTED_ABIS.includes(abi)) {
      printError(`不支持的 WASM ABI: ${abi} (仅支持 ${SUPPORTED_ABIS.join('|')})`);
      return;
    }

    let capabilities;
    try {
      capabilities = _parseCapabilitiesOption(options.caps);
    } catch (err) {
      printError(err.message);
      printInfo('可选 capability: ipc, net, fs_read, fs_write, window, shm, irq_bind');
      return;
    }

    let moduleMeta;
    try {
      moduleMeta = _inspectWasmModuleMeta(wasmPath);
    } catch (err) {
      printError(`WASM 模块解析失败: ${err.message}`);
      return;
    }

    const unsupportedImports = _findUnsupportedWasmImports(moduleMeta.importsMeta);
    if (unsupportedImports.length > 0) {
      const preview = unsupportedImports
        .slice(0, 6)
        .map(_formatImportRef)
        .join(', ');
      const remain = unsupportedImports.length > 6
        ? ` (+${unsupportedImports.length - 6} more)`
        : '';
      printError(`WASM 模块包含当前运行时不支持的导入: ${preview}${remain}`);
      printInfo('当前支持导入: khy_sys.(cap_check,ipc_call,ipc_last_len,ipc_last_status,shm_create,shm_map), spectest.print_char');
      return;
    }

    const requestedExport = options.export || '';
    const resolvedExport = _resolveDefaultWasmExport(moduleMeta, requestedExport);
    if (requestedExport && !resolvedExport) {
      printError(`导出函数不存在: ${requestedExport}`);
      printInfo(`可用导出: ${moduleMeta.functionExports.join(', ') || '(none)'}`);
      return;
    }
    if (!requestedExport && !resolvedExport) {
      if (!moduleMeta.functionExports.length) {
        printError('WASM 模块没有可调用的函数导出');
      } else {
        printError('WASM 模块存在多个函数导出，且未检测到 main/_start，请使用 --export 显式指定');
        printInfo(`可用导出: ${moduleMeta.functionExports.join(', ')}`);
      }
      return;
    }

    if (abi === 'string-v2' || abi === 'json-v2') {
      const stringMemoryExport = options.memory || 'memory';
      const allocExport = options.alloc || 'alloc';
      const freeExport = options.free || '';
      const returnMode = options['return-mode'] || 'i64-ptr-len';

      if (returnMode !== 'i64-ptr-len') {
        printError(`不支持的 return-mode: ${returnMode} (仅支持 i64-ptr-len)`);
        return;
      }

      const hasStringMemoryExport = moduleMeta.exportsMeta.some(
        e => e.kind === 'memory' && e.name === stringMemoryExport
      );
      if (!hasStringMemoryExport) {
        printError(`string ABI 所需内存导出不存在: ${stringMemoryExport}`);
        return;
      }

      if (!moduleMeta.functionExports.includes(allocExport)) {
        printError(`string ABI 所需分配函数不存在: ${allocExport}`);
        return;
      }

      if (freeExport && !moduleMeta.functionExports.includes(freeExport)) {
        printError(`string ABI 指定的释放函数不存在: ${freeExport}`);
        return;
      }
    }

    const khyMemoryExport = options['khy-memory'] || 'memory';
    const hasKhyIpcImport = moduleMeta.importsMeta.some(
      i => i.module === 'khy_sys' && i.kind === 'function' && i.name === 'ipc_call'
    );
    const hasExpectedMemoryExport = moduleMeta.exportsMeta.some(
      e => e.kind === 'memory' && e.name === khyMemoryExport
    );
    if (hasKhyIpcImport && !hasExpectedMemoryExport) {
      if (abi === 'numeric-v1') {
        printError(
          `WASM ABI 不兼容: 检测到 khy_sys.ipc_call 导入，但未找到内存导出 "${khyMemoryExport}"。`
        );
        printInfo('numeric-v1 需要 ptr/len + 线性内存 ABI；当前模块很可能是 MoonBit wasm-gc externref ABI。');
        printInfo('请改用兼容产物，或使用 string-v2/json-v2 并仅通过 /app ipc 在宿主侧发起 IPC。');
        return;
      }

      printInfo(
        `警告: 检测到 khy_sys.ipc_call 导入，但未找到内存导出 "${khyMemoryExport}"。` +
        '这通常是 MoonBit wasm-gc externref ABI，当前 khy_sys host 不兼容，运行时可能出现 EPROTO。'
      );
      printInfo('建议: 使用兼容 ptr/len + 线性内存的 WASM 产物，或仅通过 /app ipc 在宿主侧发起 IPC。');
    }

    registry().register({
      name,
      version: options.version || '0.1.0',
      description,
      entry: wasmPath,
      source,
      commands,
      autoStart: false,
      runtime: 'wasm',
      wasm: {
        path: wasmPath,
        defaultExport: resolvedExport,
        abi,
        capabilities,
        khySys: {
          memoryExport: khyMemoryExport,
        },
        stringAbi: (abi === 'string-v2' || abi === 'json-v2') ? {
          memoryExport: options.memory || 'memory',
          allocExport: options.alloc || 'alloc',
          freeExport: options.free || '',
          returnMode: options['return-mode'] || 'i64-ptr-len',
        } : undefined,
      },
    });

    printSuccess(`WASM 应用 "${name}" 注册成功`);
    printInfo(`模块: ${wasmPath}`);
    printInfo(`默认导出: ${resolvedExport}`);
    printInfo(`ABI: ${abi}`);
    printInfo(`Capabilities: ${capabilities.join(', ')}`);
    printInfo(`khy_sys memory export: ${khyMemoryExport}`);
    printInfo(`运行: /app run ${name}`);
    return;
  }

  if (runtime !== 'node') {
    printError(`不支持的 runtime: ${runtime} (仅支持 node|wasm)`);
    return;
  }

  const pathModule = require('path');
  const fs = require('fs');
  const entryRaw = options.entry;
  if (!entryRaw) {
    printError('Node 应用必须提供 --entry <path>');
    return;
  }

  const entry = pathModule.resolve(entryRaw);
  if (!fs.existsSync(entry)) {
    printError(`入口文件不存在: ${entry}`);
    return;
  }

  const port = Number(options.port || 3000);
  if (!Number.isFinite(port) || port <= 0) {
    printError('端口必须是正整数');
    return;
  }

  registry().register({
    name,
    version: options.version || '0.1.0',
    description,
    entry,
    port,
    source,
    commands,
    autoStart: false,
    runtime: 'node',
  });

  printSuccess(`Node 应用 "${name}" 注册成功`);
  printInfo(`入口: ${entry}`);
}

async function handleInstall(name, options = {}) {
  if (!name) {
    printError('用法: /app install <name>  例如: /app install khyquant');
    return;
  }

  // Check if already registered
  const existing = registry().get(name);
  if (existing) {
    printInfo(`应用 "${name}" 已安装 (版本 ${existing.version})`);
    return;
  }

  const pipPkg = name.startsWith('khy-') ? name : `khy-${name}`;
  printInfo(`正在通过 pip 安装 ${pipPkg}...`);

  const { execFileSync } = require('child_process');
  const pipCmd = process.platform === 'win32' ? 'pip' : 'pip3';

  // Validate name (only allow alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    printError('应用名只能包含字母、数字、连字符和下划线');
    return;
  }

  try {
    execFileSync(pipCmd, ['install', pipPkg], {
      stdio: 'inherit',
      timeout: 300000, // 5 min
    });

    // After pip install, try to discover and register
    // The installed package should have put a manifest or we detect its entry
    const discovered = await registry().discover();
    const match = discovered.find(d => d.name === pipPkg);
    if (match) {
      // Try to locate the entry point
      try {
        const showOutput = execFileSync(pipCmd, ['show', pipPkg, '-f'], {
          encoding: 'utf-8',
          timeout: 10000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Parse location from pip show output
        const locMatch = showOutput.match(/^Location:\s*(.+)$/m);
        if (locMatch) {
          const pkgDir = locMatch[1].trim();
          const possibleEntry = require('path').join(pkgDir, name.replace(/-/g, '_'), 'bundled', 'backend', 'server.js');
          if (require('fs').existsSync(possibleEntry)) {
            registry().register({
              name: name.replace('khy-', ''),
              version: match.version,
              description: `${name} 应用`,
              entry: possibleEntry,
              port: 3000,
              source: 'pip',
              commands: [name.replace('khy-', ''), name],
            });
            printSuccess(`应用 "${name}" 安装并注册成功!`);
            return;
          }
        }
      } catch { /* best effort */ }
    }

    printSuccess(`pip 包 ${pipPkg} 已安装`);
    printInfo('如需手动注册，请检查安装路径');
  } catch (err) {
    printError(`安装失败: ${err.message || 'pip install error'}`);
  }
}

async function handleUninstall(name) {
  if (!name) {
    printError('用法: /app uninstall <name>');
    return;
  }

  const app = registry().get(name);
  if (!app) {
    printError(`应用 "${name}" 未注册`);
    return;
  }

  // Stop if running
  const st = await registry().status(name);
  if (st.running) {
    printInfo('正在停止应用...');
    registry().stop(name);
    // Wait a moment
    await new Promise(r => setTimeout(r, 1000));
  }

  // Unregister
  registry().unregister(name);
  printSuccess(`应用 "${name}" 已卸载`);

  // Optionally pip uninstall
  if (app.source === 'pip') {
    const { promptCompat } = require('../uiPrompt');
    const { remove } = await promptCompat([{
      type: 'confirm',
      name: 'remove',
      message: `是否同时 pip uninstall khy-${name}?`,
      default: false,
    }]);
    if (remove) {
      const { execFileSync } = require('child_process');
      const pipCmd = process.platform === 'win32' ? 'pip' : 'pip3';
      try {
        execFileSync(pipCmd, ['uninstall', `khy-${name}`, '-y'], { stdio: 'inherit', timeout: 60000 });
        printSuccess(`pip 包 khy-${name} 已卸载`);
      } catch {
        printInfo('pip 卸载失败，请手动运行: pip uninstall khy-' + name);
      }
    }
  }
}

async function handleStart(name, options = {}) {
  if (!name) {
    printError('用法: /app start <name>');
    return;
  }

  const result = await registry().start(name, options);
  if (result.success) {
    if (result.alreadyRunning) {
      printInfo(`应用 "${name}" 已在运行 (端口 ${result.port})`);
    } else {
      printSuccess(`应用 "${name}" 已启动 → http://localhost:${result.port}`);
    }

    // Auto-open browser
    const app = registry().get(name);
    const frontendPort = app && app.frontendPort;
    const url = frontendPort
      ? `http://localhost:${frontendPort}`
      : `http://localhost:${result.port}`;
    _openBrowser(url);
  } else {
    printError(result.error);
  }
}

async function handleRun(name, args = [], options = {}) {
  if (!name) {
    printError('用法: /app run <name> [export] [arg1 arg2 ...] [--export fn]');
    printInfo('numeric-v1: /app run <name> <export> 1 2');
    printInfo('string-v2: /app run <name> your text payload');
    printInfo('json-v2:   /app run <name> --json \'{"x":1}\'');
    return;
  }

  const app = registry().get(name);
  if (!app) {
    printError(`应用 "${name}" 未注册`);
    return;
  }

  if ((app.runtime || 'node') !== 'wasm') {
    printError(`应用 "${name}" 不是 WASM 运行时，使用 /app start ${name}`);
    return;
  }

  const abi = app?.wasm?.abi || 'numeric-v1';
  let exportName = options.export || '';
  let callArgs = args;
  if (abi === 'numeric-v1' && !exportName && args.length > 0) {
    const first = args[0];
    const looksNumeric = /^-?\d+n$/.test(first)
      || /^-?\d+$/.test(first)
      || /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(first);
    if (!looksNumeric) {
      exportName = first;
      callArgs = args.slice(1);
    }
  }
  if (abi === 'string-v2' && !exportName) {
    // For string payload ABI, treat positional args as payload by default.
    // Use --export to target non-default exports.
    exportName = '';
  }
  if (abi === 'json-v2') {
    if (options.json !== undefined) {
      callArgs = [String(options.json)];
    } else if (callArgs.length > 0) {
      callArgs = [callArgs.join(' ')];
    } else {
      printError('json-v2 需要 JSON 输入: 使用 --json \'{"key":"value"}\'');
      return;
    }
  }

  const startedAt = process.hrtime.bigint();
  try {
    const wasmService = require('../../services/wasmAppService');
    const result = await wasmService.runFunction(name, exportName, callArgs);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    let latencySummary = null;
    try {
      const telemetry = require('../../services/telemetryService');
      latencySummary = telemetry.trackAppRunLatency({
        app: name,
        abi,
        exportName: result.exportName,
        elapsedMs,
        success: true,
      });
    } catch { /* telemetry should never break command path */ }

    printSuccess(`WASM 执行成功: ${result.app}.${result.exportName}`);
    console.log('');
    console.log(chalk.cyan.bold('  结果'));
    console.log(chalk.dim('  ─────────────────────────'));
    console.log(`  args:   ${JSON.stringify(result.args)}`);
    console.log(`  result: ${JSON.stringify(result.result)}`);
    const currentMs = Math.round(elapsedMs);
    if (latencySummary) {
      console.log(`  latency:${currentMs}ms  p50:${latencySummary.p50}ms  p95:${latencySummary.p95}ms  n=${latencySummary.successCount}`);
    } else {
      console.log(`  latency:${currentMs}ms`);
    }
    console.log('');
  } catch (err) {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    try {
      const telemetry = require('../../services/telemetryService');
      telemetry.trackAppRunLatency({
        app: name,
        abi,
        exportName: exportName || app?.wasm?.defaultExport || 'main',
        elapsedMs,
        success: false,
      });
    } catch { /* telemetry should never break command path */ }
    printError(`WASM 执行失败: ${err.message}`);
  }
}

async function handleIpc(name, args = [], options = {}) {
  if (!name) {
    printError('用法: /app ipc <name> <service> <method> [--json \'{"k":"v"}\'] [--timeout 3000]');
    printInfo('示例: /app ipc weather net http_get --json \'{"city":"shanghai"}\'');
    return;
  }

  const app = registry().get(name);
  if (!app) {
    printError(`应用 "${name}" 未注册`);
    return;
  }
  if ((app.runtime || 'node') !== 'wasm') {
    printError(`应用 "${name}" 不是 WASM 运行时`);
    return;
  }

  const service = options.service || args[0];
  const method = options.method || args[1];
  if (!service || !method) {
    printError('必须提供 service 和 method');
    printInfo('示例: /app ipc weather net http_get --json \'{"city":"shanghai"}\'');
    return;
  }

  let payload = {};
  if (options.json !== undefined) {
    try {
      payload = JSON.parse(String(options.json));
    } catch (err) {
      printError(`--json 不是合法 JSON: ${err.message}`);
      return;
    }
  } else if (args.length > 2) {
    const extra = args.slice(2).join(' ').trim();
    if (extra) {
      try {
        payload = JSON.parse(extra);
      } catch {
        payload = { text: extra };
      }
    }
  }

  const timeoutMs = options.timeout ? Number(options.timeout) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    printError('--timeout 必须是正整数毫秒');
    return;
  }

  try {
    const wasmService = require('../../services/wasmAppService');
    const result = await wasmService.runIpcCall(name, service, method, payload, { timeoutMs });
    printSuccess(`IPC 调用成功: ${name} -> ${service}.${method}`);
    console.log('');
    console.log(chalk.cyan.bold('  IPC Result'));
    console.log(chalk.dim('  ─────────────────────────'));
    console.log(`  requestId: ${String(result.requestId)}`);
    console.log(`  status:    ${result.status}`);
    console.log(`  ok:        ${result.ok}`);
    console.log(`  data:      ${JSON.stringify(result.data)}`);
    console.log('');
  } catch (err) {
    printError(`IPC 调用失败: ${err.message}`);
  }
}

async function handleExports(name) {
  if (!name) {
    printError('用法: /app exports <name>');
    return;
  }
  const app = registry().get(name);
  if (!app) {
    printError(`应用 "${name}" 未注册`);
    return;
  }
  if ((app.runtime || 'node') !== 'wasm') {
    printError(`应用 "${name}" 不是 WASM 运行时`);
    return;
  }
  try {
    const wasmService = require('../../services/wasmAppService');
    const exportsList = await wasmService.listFunctionExports(name);
    console.log('');
    console.log(chalk.cyan.bold(`  ${name} 可用导出函数`));
    console.log(chalk.dim('  ─────────────────────────'));
    if (!exportsList.length) {
      console.log(chalk.dim('  (none)'));
    } else {
      exportsList.forEach(fn => console.log(`  - ${fn}`));
    }
    console.log('');
  } catch (err) {
    printError(`读取导出失败: ${err.message}`);
  }
}

async function handleStop(name) {
  if (!name) {
    printError('用法: /app stop <name>');
    return;
  }

  const result = registry().stop(name);
  if (result.success) {
    printSuccess(`应用 "${name}" 已停止`);
  } else {
    printError(result.error);
  }
}

async function handleStatus() {
  const apps = registry().list();

  console.log('');
  console.log(chalk.cyan.bold('  应用运行状态'));
  console.log('');

  if (apps.length === 0) {
    printInfo('暂无已安装的应用');
    console.log('');
    return;
  }

  const rows = [];
  for (const app of apps) {
    const st = await registry().status(app.name);
    rows.push([
      app.name,
      app.runtime || 'node',
      st.running ? chalk.green('运行中') : chalk.dim('已停止'),
      st.running && st.port ? String(st.port) : '-',
      st.pid ? String(st.pid) : '-',
      app.version,
    ]);
  }

  printTable(
    ['应用', '运行时', '状态', '端口', 'PID', '版本'],
    rows
  );
  console.log('');
}

function _openBrowser(url) {
  try {
    const { openDefault } = require('../../tools/platformUtils');
    openDefault(url);
  } catch { /* non-critical */ }
}

// ── KHYanything Sub-command Router (legacy CLI-Anything cli-* still supported) ─

let _cliAnything;
function cliAnything() {
  if (!_cliAnything) _cliAnything = require('../../services/cliAnythingService');
  return _cliAnything;
}

let _khyProxy;
function khyProxy() {
  if (!_khyProxy) _khyProxy = require('../../services/khyAnythingProxy');
  return _khyProxy;
}

async function _handleCLIAnything(subCommand, args, options) {
  // Normalize legacy cli-* to khy-*; both prefixes are accepted.
  const cmd = subCommand.replace(/^cli-/, 'khy-');
  switch (cmd) {
    // ── Instant proxy onboarding (khyanything core) ──
    case 'khy-add':
      return _handleKhyAdd(args, options);
    case 'khy-remove':
      return _handleKhyRemove(args);
    case 'khy-proxies':
      return _handleKhyProxies();
    case 'khy-run':
      return _handleKhyRun(args, options);
    // ── Registry commands (khy-* and legacy cli-* aliases) ──
    case 'khy-search':
      return _handleCLISearch(args, options);
    case 'khy-install':
      return _handleCLIInstall(args, options);
    case 'khy-uninstall':
      return _handleCLIUninstall(args);
    case 'khy-list':
      return _handleCLIList(options);
    case 'khy-sync':
      return _handleCLISync();
    case 'khy-import':
      return _handleCLIImport(args, options);
    case 'khy-invoke':
      return _handleCLIInvoke(args, options);
    case 'khy-gen':
      return _handleCLIGen(args, options);
    default:
      printError(`未知 KHYanything 子命令: ${subCommand}`);
      printInfo('代理接入: khy-add, khy-remove, khy-proxies, khy-run');
      printInfo('注册表: khy-search, khy-install, khy-uninstall, khy-list, khy-sync, khy-import, khy-invoke, khy-gen');
      return;
  }
}

// ── Instant proxy onboarding handlers ────────────────────────────────────────

function _handleKhyAdd(args, options) {
  const source = args[0];
  if (!source) {
    printError('用法: app khy-add <本地项目路径> [--name <别名>] [--deep]');
    printInfo('示例: app khy-add ~/projects/my-tool');
    printInfo('  --deep 走 7 阶段 AI 深度生成(高质量封装)');
    return;
  }

  // Deep mode → forward to the 7-stage AI generator.
  if (options.deep) {
    return _handleCLIGen(args, options);
  }

  const result = khyProxy().addProxy(source, { name: options.name });
  if (!result.success) {
    printError(result.error);
    return;
  }

  printSuccess(`已接入代理: ${result.name}`);
  printInfo(`路径: ${result.path}`);
  printInfo(`语言: ${result.language} · 构建系统: ${result.buildSystem}`);
  printInfo(`可用命令: ${result.commands.join(', ')}`);
  if (result.registered && result.registered.errors.length > 0) {
    for (const e of result.registered.errors.slice(0, 3)) {
      console.log(chalk.dim(`  ⚠ ${e}`));
    }
  }
  printInfo(`调用: app khy-run ${result.name} <command> [args...]`);
}

function _handleKhyRemove(args) {
  const name = args[0];
  if (!name) {
    printError('用法: app khy-remove <name>');
    return;
  }
  const result = khyProxy().removeProxy(name);
  if (result.success) printSuccess(`已移除代理: ${name}`);
  else printError(result.error);
}

function _handleKhyProxies() {
  const proxies = khyProxy().listProxies();
  console.log('');
  console.log(chalk.cyan.bold('  已接入的项目代理 (KHYanything)'));
  console.log('');
  if (proxies.length === 0) {
    printInfo('暂无代理。使用 app khy-add <本地项目路径> 接入');
    console.log('');
    return;
  }
  for (const p of proxies) {
    console.log(`  ${chalk.white.bold(p.name)} ${chalk.dim('[' + p.language + '/' + p.buildSystem + ']')}`);
    console.log(`    ${chalk.dim(p.path)}`);
    console.log(`    命令: ${chalk.dim(p.runSpec.commands.map(c => c.command).join(', '))}`);
    console.log('');
  }
}

function _handleKhyRun(args, options) {
  const name = args[0];
  const command = args[1];
  if (!name || !command) {
    printError('用法: app khy-run <name> <command> [args...]');
    return;
  }
  const result = khyProxy().invokeProxy(name, command, args.slice(2), {
    timeout: options.timeout ? Number(options.timeout) : 120000,
  });
  if (result.success) {
    console.log(result.data);
  } else {
    printError(result.error);
    if (result.stderr) console.log(chalk.dim(result.stderr));
  }
}


function _handleCLISearch(args, options) {
  const query = args.join(' ').trim();
  if (!query) {
    const stats = cliAnything().getRegistryStats();
    console.log('');
    console.log(chalk.cyan.bold('  CLI-Anything 注册表'));
    console.log(`  共 ${stats.total} 个工具 (Harness: ${stats.harness}, Public: ${stats.public})`);
    console.log('');
    for (const [cat, count] of Object.entries(stats.categories).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${chalk.dim('•')} ${cat}: ${count}`);
    }
    console.log('');
    printInfo('使用 app cli-search <关键词> 搜索具体工具');
    return;
  }

  const results = cliAnything().searchRegistry(query);
  if (results.length === 0) {
    printInfo(`未找到与 "${query}" 匹配的 CLI 工具`);
    return;
  }

  console.log('');
  console.log(chalk.cyan.bold(`  搜索结果: "${query}" (${results.length} 条)`));
  console.log('');
  for (const cli of results.slice(0, 15)) {
    const source = cli._source === 'harness' ? chalk.green('[Harness]') : chalk.blue('[Public]');
    const cat = chalk.dim(`[${cli.category || 'other'}]`);
    console.log(`  ${source} ${chalk.white.bold(cli.display_name || cli.name)} ${cat}`);
    console.log(`    ${chalk.dim(cli.description || '-')}`);
    if (cli.requires) console.log(`    ${chalk.dim('需要: ' + cli.requires)}`);
    console.log('');
  }
  if (results.length > 15) {
    printInfo(`还有 ${results.length - 15} 条结果未显示`);
  }
}

function _handleCLIInstall(args) {
  const name = args[0];
  if (!name) {
    printError('用法: app cli-install <name>');
    printInfo('先用 app cli-search <关键词> 搜索可用工具');
    return;
  }

  printInfo(`正在安装 cli-anything-${name}...`);
  const result = cliAnything().installCLI(name);
  if (result.success) {
    printSuccess(`cli-anything-${name} 安装成功 (策略: ${result.strategy})`);

    printInfo('正在注册为 KHY 工具和技能...');
    const regResult = cliAnything().registerAllAsKHYTools();
    printInfo(`注册完成: ${regResult.tools} 工具, ${regResult.skills} 技能, ${regResult.apps} 应用`);
    if (regResult.errors.length > 0) {
      for (const e of regResult.errors.slice(0, 3)) {
        console.log(chalk.dim(`  ⚠ ${e}`));
      }
    }
  } else {
    printError(result.error);
  }
}

function _handleCLIUninstall(args) {
  const name = args[0];
  if (!name) {
    printError('用法: app cli-uninstall <name>');
    return;
  }
  const result = cliAnything().uninstallCLI(name);
  if (result.success) {
    printSuccess(`cli-anything-${name} 已卸载`);
  } else {
    printError(result.error);
  }
}

function _handleCLIList(options) {
  const installed = cliAnything().getInstalledCLIs();

  console.log('');
  console.log(chalk.cyan.bold('  已安装的 CLI-Anything 工具'));
  console.log('');

  if (installed.length === 0) {
    printInfo('暂无已安装的 CLI-Anything 工具');
    printInfo('使用 app cli-search <关键词> 搜索，app cli-install <name> 安装');
    console.log('');
    return;
  }

  for (const cli of installed) {
    const source = cli._source === 'harness' ? chalk.green('H') : cli._source === 'public' ? chalk.blue('P') : chalk.dim('L');
    console.log(`  [${source}] ${chalk.white.bold(cli.displayName || cli.name)} ${chalk.dim('v' + cli.version)}`);
    console.log(`    ${chalk.dim(cli.entryPoint)} — ${cli.description || '-'}`);
    if (cli.commandGroups.length > 0) {
      console.log(`    命令组: ${chalk.dim(cli.commandGroups.join(', '))}`);
    }
    console.log('');
  }
}

function _handleCLIImport(args) {
  const srcPath = args[0];
  if (!srcPath) {
    printError('用法: app cli-import <zip或目录>');
    printInfo('示例: app cli-import ~/Downloads/CLI-Anything-main.zip');
    return;
  }

  printInfo(`正在导入离线快照: ${srcPath} ...`);
  const result = cliAnything().importFromArchive(srcPath);
  if (!result.success) {
    printError(result.error);
    return;
  }

  printSuccess(`导入完成: ${result.total} 个工具 (Harness: ${result.harness}, Public: ${result.public})`);
  printInfo(`离线 bundle: ${result.bundleRoot}`);
  printInfo('后续: app cli-search <关键词> 搜索, app cli-install <name> 离线安装');
}

function _handleCLISync() {
  printInfo('正在同步 CLI-Anything 注册表...');
  cliAnything().fetchRegistry(true);
  const stats = cliAnything().getRegistryStats();
  printSuccess(`注册表已同步: ${stats.total} 个工具 (Harness: ${stats.harness}, Public: ${stats.public})`);

  printInfo('正在扫描已安装 CLI...');
  const installed = cliAnything().discoverInstalled();
  printInfo(`发现 ${installed.length} 个已安装 CLI`);

  if (installed.length > 0) {
    printInfo('正在更新 KHY 注册...');
    const regResult = cliAnything().registerAllAsKHYTools();
    printSuccess(`注册完成: ${regResult.tools} 工具, ${regResult.skills} 技能, ${regResult.apps} 应用`);
  }
}

function _handleCLIInvoke(args, options) {
  const name = args[0];
  if (!name) {
    printError('用法: app cli-invoke <name> <command> [args...]');
    return;
  }

  const cmdArgs = args.slice(1);
  const result = cliAnything().invokeCommand(name, cmdArgs, { timeout: options.timeout ? Number(options.timeout) : 60000 });

  if (result.success) {
    if (result.format === 'json' && typeof result.data === 'object') {
      console.log(JSON.stringify(result.data, null, 2));
    } else {
      console.log(result.data);
    }
  } else {
    printError(`调用失败: ${result.error}`);
    if (result.stderr) console.log(chalk.dim(result.stderr));
  }
}

function _handleCLIGen(args, options) {
  const source = args[0];
  if (!source) {
    printError('用法: app cli-gen <repo-url-or-local-path> [--runtime python|node]');
    printInfo('示例:');
    printInfo('  app cli-gen https://github.com/user/my-app');
    printInfo('  app cli-gen /path/to/local/project');
    printInfo('  app cli-gen https://github.com/user/my-app --runtime node');
    return;
  }

  const runtime = (options.runtime || 'python').toLowerCase();
  if (runtime !== 'python' && runtime !== 'node') {
    printError('--runtime 仅支持 python 或 node');
    return;
  }

  // Forward to AI agent as a generation task
  const prompt = [
    `请为以下软件项目生成 Agent 可控的 CLI 工具。`,
    ``,
    `源码位置: ${source}`,
    `目标运行时: ${runtime}`,
    ``,
    `请按照 CLI-Anything 的 7 阶段流水线执行:`,
    `1. 源码获取 — ${source.startsWith('http') ? 'git clone 仓库' : '验证本地路径'}`,
    `2. 代码分析 — 识别后端引擎、数据模型、API/GUI 映射`,
    `3. 架构设计 — 设计命令组、状态模型、输出格式`,
    `4. 实现 — 生成 ${runtime === 'python' ? 'Click CLI + core/ + utils/' : 'Commander CLI + KHY 扩展结构'}`,
    `5. 测试规划 — 编写 unit + E2E 测试计划`,
    `6. 测试实现 — 编写测试代码`,
    `7. 打包 — ${runtime === 'python' ? 'setup.py + pip install -e .' : 'package.json + npm link'} + 注册到 KHY`,
    ``,
    `核心原则:`,
    `- 必须调用真实软件后端（subprocess），不能重新实现功能`,
    `- 支持 --json 标志输出结构化数据`,
    `- 实现 Session 管理（undo/redo + 项目状态持久化）`,
    `- 生成 SKILL.md 供 Agent 发现`,
    `- 输出到 ~/.khy/cli-anything/generated/ 目录`,
  ].join('\n');

  return { aiForward: prompt };
}

module.exports = { handleApp };
