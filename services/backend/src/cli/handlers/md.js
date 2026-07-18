'use strict';

/**
 * md handler — `khy md …`
 *
 * MarkText(muya)所见即所得 Markdown 工作台 + 系统右键「打开方式」注册。
 *
 *   khy md <file>            用 muya 打开某 .md（等同 open）
 *   khy md open <file>       同上
 *   khy md register          把 khyosMarkdown 注册进系统「打开方式」(.md 关联)
 *   khy md unregister        移除该关联
 *
 * 底层复用 tools/khyos-markdown/：
 *   - khyos-md-bridge.js：127.0.0.1 同源桥接器（消 CORS + token 鉴权 + /vendor 静态服务）。
 *   - khyosMarkdown.html：门控加载同源本地 muya 引擎产物 vendor/，失败逐字节回退零依赖内联引擎。
 *   - register-linux.sh / register-windows.ps1：用户级关联（~/.local / HKCU，无 sudo/UAC）。
 *
 * 门控：KHY_MD_EDITOR（default-on）整体开关；KHY_MD_WYSIWYG（default-on）决定是否加载 muya。
 * 全程 fail-soft：脚本缺失/平台不支持/桥接器异常都只提示，绝不抛、绝不 500。
 */

const path = require('path');
const fs = require('fs');

function fmt() {
  return require('../formatters');
}

function flagOn(name) {
  try { return require('../../services/flagRegistry').isFlagEnabled(name); }
  catch (_) { return true; } // 保守：注册表不可用时视为开（default-on 语义）。
}

/**
 * 定位 tools/khyos-markdown 目录。dev 与 pip/npm bundled 布局中，tools/ 与 services/ 同级，
 * 故 handler 目录上溯 5 层即命中；另留环境变量覆盖与若干候选兜底。
 */
function resolveToolsDir() {
  const candidates = [];
  const envDir = process.env.KHY_MD_TOOLS_DIR;
  if (envDir) candidates.push(envDir);
  // handlers → cli → src → backend → services → <root> → tools/khyos-markdown
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', '..', 'tools', 'khyos-markdown'));
  // 兜底：再上溯一层（防个别打包层级差异）。
  candidates.push(path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'tools', 'khyos-markdown'));
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'khyos-md-bridge.js'))) return c; } catch (_) {}
  }
  return null;
}

/** 打开 muya 工作台：起桥接器（内部自开浏览器），保持进程存活直到 Ctrl+C。 */
async function openEditor(targetPath) {
  const { printInfo, printError, printWarn, printSuccess } = fmt();
  const toolsDir = resolveToolsDir();
  if (!toolsDir) {
    printError('未找到 khyosMarkdown 工具目录（tools/khyos-markdown）。');
    printInfo('可设置 KHY_MD_TOOLS_DIR 指向该目录后重试。');
    return true;
  }
  let bridge;
  try { bridge = require(path.join(toolsDir, 'khyos-md-bridge.js')); }
  catch (e) { printError('加载桥接器失败：' + e.message); return true; }

  let abs = '';
  if (targetPath) {
    const base = process.env.KHYQUANT_CWD || process.cwd();
    abs = path.resolve(base, String(targetPath));
    if (!fs.existsSync(abs)) printWarn('目标文件不存在，将以空白工作台打开：' + abs);
  }

  const wysiwyg = flagOn('KHY_MD_WYSIWYG');
  // 非 REPL 单次调用启用 autoShutdown：关浏览器标签即干净退出、释放终端，不留常驻孤儿服务；
  // REPL 模式后台复用桥接器，故禁用（由 REPL 生命周期管理）。env KHY_MD_AUTO_SHUTDOWN 可门控回退。
  const autoShutdown = process.env.KHY_REPL_ACTIVE !== '1';
  let handle;
  try {
    handle = await bridge.startBridge({ targetPath: abs || undefined, wysiwyg, autoShutdown });
  } catch (e) {
    printError('启动 Markdown 工作台失败：' + e.message);
    return true;
  }
  printSuccess('khyosMarkdown 已就绪' + (wysiwyg ? '（muya WYSIWYG）' : '（内联引擎）') + '：' + handle.url);

  // REPL 内：桥接器 socket 常驻后台，直接返回不阻塞，编辑器持续可用。
  if (process.env.KHY_REPL_ACTIVE === '1') return true;

  // 非 REPL 单次调用：监听 socket 已保活事件循环；显式阻塞 stdin 并挂 SIGINT 清理，
  // 让用户 Ctrl+C 干净关闭。
  printInfo('编辑器运行中，按 Ctrl+C 关闭。');
  const shutdown = () => {
    try { handle.server.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try { process.stdin.resume(); } catch (_) {}
  // 永不 resolve 的等待：由 SIGINT/SIGTERM 结束进程。
  await new Promise(() => {});
  return true;
}

/** 注册/注销系统「打开方式」关联（平台脚本 spawn，fail-soft）。 */
function runRegisterScript(action) {
  const { printInfo, printError, printWarn, printSuccess } = fmt();
  const toolsDir = resolveToolsDir();
  if (!toolsDir) { printError('未找到 tools/khyos-markdown。'); return true; }

  const plat = process.platform;
  let cmd, scriptArgs, scriptFile;
  if (plat === 'win32') {
    scriptFile = action === 'register' ? 'register-windows.ps1' : 'unregister-windows.ps1';
    cmd = 'powershell';
    scriptArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(toolsDir, scriptFile)];
  } else if (plat === 'linux') {
    scriptFile = action === 'register' ? 'register-linux.sh' : 'unregister-linux.sh';
    cmd = 'bash';
    scriptArgs = [path.join(toolsDir, scriptFile)];
  } else {
    // darwin 及其他：暂无脚本（既有注册脚本仅覆盖 Linux/Windows）。
    printWarn('当前平台（' + plat + '）暂不支持自动注册「打开方式」。');
    printInfo('可手动将 ' + path.join(toolsDir, 'khyos-md-bridge.js') + ' 关联到 .md 文件。');
    return true;
  }

  const scriptPath = path.join(toolsDir, scriptFile);
  if (!fs.existsSync(scriptPath)) { printError('注册脚本缺失：' + scriptPath); return true; }

  const { spawnSync } = require('child_process');
  let r;
  try {
    r = spawnSync(cmd, scriptArgs, { cwd: toolsDir, stdio: 'inherit' });
  } catch (e) {
    printError((action === 'register' ? '注册' : '注销') + '失败：' + e.message);
    return true;
  }
  if (r && r.status === 0) {
    printSuccess(action === 'register'
      ? 'khyosMarkdown 已注册到系统「打开方式」——右键 .md 即可选择。'
      : 'khyosMarkdown 关联已移除。');
  } else {
    printWarn((action === 'register' ? '注册' : '注销') + '脚本返回非零（status='
      + (r ? r.status : 'n/a') + '）；请检查上方输出。');
  }
  return true;
}

async function handleMd(parsed = {}) {
  const { printInfo, printWarn } = fmt();

  if (!flagOn('KHY_MD_EDITOR')) {
    printWarn('Markdown 工作台已禁用（KHY_MD_EDITOR=0）。');
    return true;
  }

  const rawArgs = Array.isArray(parsed.args) ? parsed.args.slice() : [];
  let sub = String(parsed.subCommand || '').toLowerCase();
  let rest = rawArgs;
  const KNOWN = new Set(['open', 'register', 'unregister']);
  if (!KNOWN.has(sub)) {
    if (rawArgs.length && KNOWN.has(String(rawArgs[0]).toLowerCase())) {
      sub = String(rawArgs[0]).toLowerCase();
      rest = rawArgs.slice(1);
    } else {
      // 裸 `khy md <file>` → open；`khy md` 无参 → 项目内嵌浏览模式。
      sub = 'open';
    }
  }

  if (sub === 'register' || sub === 'unregister') return runRegisterScript(sub);

  // open
  const file = rest.find((a) => a && !String(a).startsWith('-'));
  return await openEditor(file || '');
}

module.exports = { handleMd, resolveToolsDir };
