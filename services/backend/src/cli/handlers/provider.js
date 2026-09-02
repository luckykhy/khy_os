'use strict';

/**
 * provider.js — khy provider 命令 (sprint 17 cmdc-as-provider wiring)
 *
 * Sub-commands:
 *   khy provider list                       列出可选 provider (含 cmdc)
 *   khy provider use cmdc [model]           切到 cmdc; 复用 ~/.commandcode/auth.json
 *                                            里的 user_xxx key, 不需要重新输
 *   khy provider use cmdc --reuse-key       显式声明复用 (默认行为, 加了更稳)
 *   khy provider use cmdc --key <user_xxx>  重输 (写 ~/.commandcode/auth.json)
 *   khy provider login cmdc                 等价于 `cmdcode login`
 *   khy provider logout cmdc                删除 ~/.commandcode/auth.json
 *   khy provider status                     当前 preferred adapter + model
 *
 * 设计: 不走 OpenAI wire 的 provider (cmdc) 走子进程, 不在 providerPresets
 * 里出现。 khy 启动器 (khy.bat / khy.sh) 默认设 KHY_COMMANDCODE=1, 让
 * aiGateway 把 commandcode adapter 视为 enabled。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const chalk = require('picocolors');
const { spawn } = require('child_process');
const { printSuccess, printError, printInfo, printWarn } = require('../formatters');

// ── cmdc 凭证位置 (单一真源: 与 commandCodeAdapter._readConfigJson 同形) ──

function _cmdcHome(env) {
  return env && env.COMMAND_CODE_HOME
    ? require('../../services/externalApps/_shared').expandHome(env.COMMAND_CODE_HOME, env)
    : path.join(os.homedir(), '.commandcode');
}

function _cmdcAuthFile(env) {
  return path.join(_cmdcHome(env), 'auth.json');
}

function _readAuth(env) {
  const file = _cmdcAuthFile(env);
  try {
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function _writeAuth(auth, env) {
  const file = _cmdcAuthFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort on Windows */ }
}

function _deleteAuth(env) {
  const file = _cmdcAuthFile(env);
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// ── flag 解析 (跟 taste handler 同构, 但 router 已经把全局 flag 放 opts) ──

function _verb(parsed) {
  return (parsed.subCommand || parsed.args[0] || '').toLowerCase();
}

function _rest(parsed) {
  return parsed.subCommand ? parsed.args : parsed.args.slice(1);
}

function _parseFlags(rest) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === '--') { positional.push(...rest.slice(i + 1)); break; }
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      let key, value;
      if (eq >= 0) { key = body.slice(0, eq); value = body.slice(eq + 1); }
      else {
        key = body;
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) { value = next; i += 1; }
        else { value = true; }
      }
      opts[key] = value;
    } else { positional.push(tok); }
  }
  return { opts, positional };
}

function _mergeRouterOpts(parsed, opts) {
  const routerOpts = (parsed && parsed.options && typeof parsed.options === 'object') ? parsed.options : {};
  for (const k of Object.keys(routerOpts)) {
    if (routerOpts[k] !== undefined && opts[k] === undefined) {
      opts[k] = routerOpts[k];
    }
  }
}

// ── 子命令实现 ──

async function _listProviders() {
  console.log('');
  console.log(chalk.bold('  khy provider — 可选 provider 列表'));
  console.log(chalk.dim('  ' + '─'.repeat(60)));

  // 1) HTTP / OpenAI-wire providers (走 providerPresets)
  try {
    const { getProviderPresets } = require('../../services/gateway/providerPresets');
    const presets = getProviderPresets();
    console.log('');
    console.log(chalk.cyan('  [HTTP providers]'));
    for (const p of presets) {
      console.log(`    ${chalk.green('●')} ${chalk.bold(p.label || p.id)} ${chalk.dim('(' + p.id + ')')}`);
      if (p.baseUrl) {
        console.log(`        ${chalk.dim('endpoint:')} ${p.baseUrl}`);
      }
      if (p.defaultModel) {
        console.log(`        ${chalk.dim('default: ')} ${p.defaultModel}`);
      }
    }
  } catch (e) {
    printWarn(`无法加载 HTTP provider 列表: ${e.message}`);
  }

  // 2) CLI-subprocess adapters (commandcode, opencode, codex, claude-code)
  console.log('');
  console.log(chalk.cyan('  [CLI-subprocess adapters]'));
  const cliAdapters = [
    { id: 'commandcode', name: 'Command Code (cmdc)', detect: 'KHY_COMMANDCODE=1 + cmdcode binary in PATH' },
    { id: 'opencode', name: 'OpenCode', detect: 'opencode binary in PATH' },
    { id: 'codex', name: 'Codex', detect: 'codex binary in PATH' },
    { id: 'claude', name: 'Claude Code', detect: 'claude binary in PATH' },
  ];
  for (const a of cliAdapters) {
    console.log(`    ${chalk.green('●')} ${chalk.bold(a.name)} ${chalk.dim('(' + a.id + ')')}`);
    console.log(`        ${chalk.dim('detect: ')} ${a.detect}`);
  }
  console.log('');
}

async function _providerStatus() {
  const adapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim();
  const model = String(process.env.GATEWAY_PREFERRED_MODEL || '').trim();
  const strict = String(process.env.GATEWAY_PREFERRED_STRICT || '').trim();
  console.log('');
  console.log(chalk.bold('  khy provider status'));
  console.log(chalk.dim('  ' + '─'.repeat(40)));
  if (adapter) {
    console.log(`  ${chalk.cyan('adapter'.padEnd(14))}  ${chalk.bold(adapter)}`);
  } else {
    console.log(`  ${chalk.cyan('adapter'.padEnd(14))}  ${chalk.dim('(unset — auto)')}`);
  }
  console.log(`  ${chalk.cyan('model'.padEnd(14))}  ${model || chalk.dim('(unset — adapter default)')}`);
  console.log(`  ${chalk.cyan('strict'.padEnd(14))}  ${strict || chalk.dim('(unset)')}`);
  console.log(`  ${chalk.cyan('KHY_COMMANDCODE'.padEnd(14))}  ${process.env.KHY_COMMANDCODE || chalk.dim('(unset)')}`);

  // 检 cmdc 状态
  const auth = _readAuth(process.env);
  const authFile = _cmdcAuthFile(process.env);
  console.log('');
  console.log(chalk.cyan('  [cmdc]'));
  console.log(`  ${chalk.cyan('auth.json'.padEnd(14))}  ${auth ? chalk.green('已登录') : chalk.dim('未登录')}`);
  console.log(`  ${chalk.cyan('path'.padEnd(14))}  ${chalk.dim(authFile)}`);
  if (auth) {
    const user = auth.userName || auth.userId || '(unknown)';
    const authed = auth.authenticatedAt || '(unknown)';
    console.log(`  ${chalk.cyan('user'.padEnd(14))}  ${user}`);
    console.log(`  ${chalk.cyan('logged in'.padEnd(14))}  ${authed}`);
  }
  console.log('');
}

async function _useCmdc(opts, positional) {
  const wantReuse = opts['reuse-key'] === true || opts['reuse-key'] === 'true';
  const wantNewKey = typeof opts.key === 'string' && opts.key.trim();
  const model = positional[0] || null;

  if (wantReuse && wantNewKey) {
    printError('--reuse-key 和 --key 互斥');
    return;
  }

  // 检 cmdc binary 是否在 PATH (含便携安装路径)
  try {
    const availability = require('../../services/gateway/adapters/_commandAvailability');
    if (!availability.isAvailable('cmdc')) {
      printWarn('未检测到 `cmdcode` binary — khy 会自动尝试便携安装');
      try {
        const installer = require('../../services/gateway/adapters/portableCliInstaller');
        const r = await installer.install('commandcode');
        if (r.ok) {
          printSuccess(`已安装 cmdcode 到 ${r.packageDir}`);
        } else if (r.gated) {
          printWarn(`便携安装已关闭 (KHY_PORTABLE_CLI_INSTALL=off): ${r.error}`);
          printInfo('请手动 npm i -g command-code, 或设置 KHY_PORTABLE_CLI_INSTALL=on');
        } else {
          printWarn(`便携安装失败: ${r.error}`);
          printInfo('继续 — 假定 cmdcode 已在 PATH 中');
        }
      } catch (e) {
        printWarn(`便携安装器异常: ${e.message}`);
      }
    }
  } catch {
    /* availability module unavailable — proceed */
  }

  let auth = _readAuth(process.env);
  if (wantNewKey) {
    // 重输 key: 写 ~/.commandcode/auth.json
    const newKey = String(opts.key).trim();
    auth = {
      apiKey: newKey,
      userId: 'manual-' + Date.now(),
      userName: 'manual',
      keyName: 'khy-provider-manual',
      authenticatedAt: new Date().toISOString(),
    };
    try {
      _writeAuth(auth, process.env);
      printSuccess(`已写入新 key 到 ${_cmdcAuthFile(process.env)}`);
    } catch (e) {
      printError(`写入 auth.json 失败: ${e.message}`);
      return;
    }
  } else if (!auth) {
    // 既不复用也没新 key — 引导走 login
    printWarn('~/.commandcode/auth.json 不存在');
    printInfo('请用以下方式之一提供 cmdc 凭证:');
    printInfo('  1. khy provider use cmdc --key <user_xxx>     (重输 key)');
    printInfo('  2. khy provider login cmdc                     (走 cmdcode login)');
    return;
  }

  // 切到 cmdc — 写 GATEWAY_PREFERRED_ADAPTER=commandcode (可加 strict)
  try {
    const { persistGatewayPreference } = require('./gateway');
    persistGatewayPreference({ adapter: 'commandcode', model });
    printSuccess(`已切到 Command Code${model ? ` (model: ${model})` : ' (默认 model)'}`);
    printInfo('下次 chat 走 `cmdcode --print` 子进程, 复用上面的 auth.json key');
    printInfo('如需换 model: khy provider use cmdc <provider/model>');
  } catch (e) {
    printError(`切换失败: ${e.message}`);
  }
}

async function _loginCmdc() {
  // 1) 检测 cmdcode binary
  const cmdcode = process.platform === 'win32' ? 'cmdcode.cmd' : 'cmdcode';
  const probe = spawn(cmdcode, ['--version'], { stdio: 'ignore', shell: true });
  await new Promise((resolve) => {
    probe.on('error', () => resolve());
    probe.on('exit', () => resolve());
  });
  // 简单办法: 让用户跑 cmdcode login
  printInfo('请在外部终端运行 `cmdcode login`, 完成认证后回到 khy');
  printInfo(`完成后 khy 会自动从 ${_cmdcAuthFile(process.env)} 读取 key`);
  printInfo('');
  printInfo('或者直接用 khy provider use cmdc --key <user_xxx> 一键注入');
}

async function _logoutCmdc() {
  const file = _cmdcAuthFile(process.env);
  if (_deleteAuth(process.env)) {
    printSuccess(`已删除 ${file}`);
  } else {
    printWarn(`${file} 不存在或删除失败`);
  }
}

// ── entry ──

async function handleProviderCommand(parsed) {
  const verb = _verb(parsed);
  const rest = _rest(parsed);
  const { opts, positional } = _parseFlags(rest);
  _mergeRouterOpts(parsed, opts);

  switch (verb) {
    case 'list':
    case 'ls':
      await _listProviders();
      return;
    case 'status':
    case 'show':
      await _providerStatus();
      return;
    case 'use':
    case 'switch': {
      const target = positional[0];
      if (!target) {
        printError('用法: khy provider use <adapter> [model]  [--reuse-key | --key <user_xxx>]');
        return;
      }
      if (target.toLowerCase() === 'cmdc' || target.toLowerCase() === 'commandcode') {
        await _useCmdc(opts, positional.slice(1));
        return;
      }
      // 其它 adapter (claude / opencode / codex / api 等) 走通用路径
      try {
        const { persistGatewayPreference } = require('./gateway');
        const model = positional[1] || null;
        persistGatewayPreference({ adapter: target, model });
        printSuccess(`已切到 ${target}${model ? ` (model: ${model})` : ' (默认 model)'}`);
      } catch (e) {
        printError(`切换失败: ${e.message}`);
      }
      return;
    }
    case 'login': {
      const target = positional[0];
      if (target && (target.toLowerCase() === 'cmdc' || target.toLowerCase() === 'commandcode')) {
        await _loginCmdc();
        return;
      }
      printError('用法: khy provider login cmdc');
      return;
    }
    case 'logout': {
      const target = positional[0];
      if (target && (target.toLowerCase() === 'cmdc' || target.toLowerCase() === 'commandcode')) {
        await _logoutCmdc();
        return;
      }
      printError('用法: khy provider logout cmdc');
      return;
    }
    case 'help':
    case '':
    case undefined: {
      console.log('');
      console.log(chalk.bold('  khy provider — provider 切换 + cmdc 凭证管理'));
      console.log('');
      console.log('  用法:');
      console.log('    khy provider list                       列出所有 provider');
      console.log('    khy provider status                     当前 preferred adapter/model');
      console.log('    khy provider use <adapter> [model]      切到指定 adapter');
      console.log('    khy provider use cmdc --reuse-key        切 cmdc, 复用 ~/.commandcode/auth.json');
      console.log('    khy provider use cmdc --key <user_xxx>  切 cmdc, 重输 key');
      console.log('    khy provider login cmdc                 引导运行 cmdcode login');
      console.log('    khy provider logout cmdc                删除 ~/.commandcode/auth.json');
      console.log('');
      console.log('  cmdc 默认 KHY_COMMANDCODE=1, 启动即激活;');
      console.log('  无需手工设 env。');
      console.log('');
      return;
    }
    default:
      printError(`未知子命令: ${verb}。运行 \`khy provider help\` 查看用法。`);
  }
}

module.exports = { handleProviderCommand };
