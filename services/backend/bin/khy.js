#!/usr/bin/env node

/**
 * KHY Platform CLI entry point.
 *
 * Two binaries share this script (see package.json "bin"):
 *   khy                         → full khy OS mode (platform shell + app runtime)
 *   khy ai                      → lightweight AI REPL (explicit)
 *   khy ai "prompt"             → one-shot AI query (explicit)
 *   khy ai -p "prompt"          → print mode for piping (explicit)
 *   khy ai run <model> [prompt] → run with Ollama model (interactive/one-shot)
 *   khy run <model> [prompt]    → compatibility alias for `khy ai run`
 *   khyquant                    → khyquant app compatibility entry (upper-layer app/plugin)
 *   khyquant -i / --interactive → interactive REPL with AI enabled
 *   khyquant <command> [args]   → single command execution
 *   khyquant --help             → show help
 */

/**
 * 命令行入口 —— 系统的两种运行模式
 *
 * 运行模式说明：
 *   khy 模式（操作系统主入口）：
 *     - 默认进入 khy OS 平台能力（应用管理、网关、服务、诊断等）
 *     - 默认应用为 khyquant（量化模块）
 *     - 显式 AI 轻量模式：khy ai / khy --lite
 *
 *   khyquant 模式（上层应用兼容入口）：
 *     - 作为默认应用的兼容命令入口
 *     - khyquant              启动交互式 REPL
 *     - khyquant server       启动 Web 服务器
 *     - khyquant data list    浏览数据源
 *
 * 启动流程：
 *   1. normalizeArgs()    标准化命令行参数
 *   2. isInteractiveRun() 判断是否进入交互模式
 *   3. 根据模式选择：
 *      - 显式 AI 模式 → repl（统一 REPL）
 *      - 默认模式 → 完整系统启动（数据库 + 服务器 + REPL）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── V8 compile cache: reuse bytecode across launches (Node >= 22.8) ──
// The startup require graph (babel, react, ink ESM import) is dominated by
// V8 parse/compile time, not disk I/O. enableCompileCache() persists compiled
// bytecode (CJS + ESM) into Node's default on-disk cache so every launch after
// the first skips recompilation. No-op with a warning-free fallback on older
// Node versions; opt out via NODE_DISABLE_COMPILE_CACHE=1 (Node's own switch).
// Disabled: compile cache causes stale bytecode issues during development
// try {
//   const nodeModule = require('module');
//   if (typeof nodeModule.enableCompileCache === 'function') nodeModule.enableCompileCache();
// } catch { /* compile cache is a best-effort accelerator */ }

// UX5: Node.js 冷启动加载指示器 — 在重型 require 之前输出一行提示,
// 让用户知道 Node.js 正在加载而非卡死。REPL 启动后会被清掉。
if (process.stdout.isTTY && !process.env.KHY_QUIET_STARTUP) {
  process.stdout.write('  正在加载 khy 运行时...\r');
}

// ── Windows 派生黑框闪烁 + 启动慢:在任何模块 require('child_process') 并解构派生函数之前,
// 给 child_process 打一层薄包装,在 win32 上默认注入 windowsHide:true(集中修复,覆盖全部 600+
// 派生调用点)。非 win32 完全不打补丁;门控 KHY_WINDOWS_SPAWN_HIDE 关时逐字节回退。必须置于此处
try { require('../src/bootstrap/windowsSpawnHardening').installWindowsSpawnHardening(); } catch { /* best effort */ }

// ── 自愈服务:拦截 MODULE_NOT_FOUND,自动修复路径迁移后的引用
try { require('../src/services/selfHeal').install(); } catch { /* best effort */ }

// ── Fast startup: single env var to disable all optional background tasks ──
// Default-on (DESIGN-PERF-001 v1 §阶段 B): bridge server / source-heal SHA-256
// scan / task cleanup are best-effort background work that does not gate the
// REPL hot path; turning them off by default drops 200-600ms of CPU contention
// and removes bridge LAN port exposure for users who never pair a phone. Opt
// back into legacy behavior with KHY_FAST_STARTUP=0.
if (process.env.KHY_FAST_STARTUP !== '0') {
  process.env.KHY_BRIDGE_AUTOSTART = process.env.KHY_BRIDGE_AUTOSTART ?? '0';
  process.env.KHY_SOURCE_HEAL = process.env.KHY_SOURCE_HEAL ?? '0';
  process.env.KHY_TASK_CLEANUP = process.env.KHY_TASK_CLEANUP ?? '0';
}

const AI_CONTROL_SUBCOMMANDS = new Set([
  'status', 'config', 'on', 'off', 'tools', 'dangerous',
  'tech', 'owner', 'unrestricted',
]);
const IDE_ADAPTER_FLAGS = Object.freeze({
  '--kiro': 'kiro',
  '--cursor': 'cursor',
  '--claude': 'claude',
  '--codex': 'codex',
  '--warp': 'warp',
  '--trae': 'trae',
  '--windsurf': 'windsurf',
  '--vscode': 'vscode',
});

// ── 启动性能分析器：在所有逻辑之前记录入口时间点 ────────────────────────
const { checkpoint } = require('../src/bootstrap/startupProfiler');
checkpoint('entry');

// ── Shadow startup-phase FSM (observability only, zero behavior change) ──
// Fail-soft + optional: the stateMachine module must never slow down or
// break startup. Mounted on `process` so diagnostics can read it even
// though the bin/ and src/ module graphs are not otherwise connected.
let _startupFsm = null;
try { _startupFsm = require('../src/services/domain/state/stateMachine/startupPhases.js').createStartupFsm({ name: 'startup' }); } catch { /* fsm is optional */ }
try { process.__khyStartupFsm = _startupFsm; } catch { /* best effort */ }
// Optional stderr transition logger (KHY_STATE_DEBUG=1 only); fail-soft.
try { require('../src/services/domain/state/stateMachine/debugLog.js').attachDebugLog(_startupFsm, 'startup'); } catch { /* debug log optional */ }

function _isTruthy(value) {
  return value === true || ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function _isFalsy(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

/**
 * 把 winston 的控制台 transport 降到 warn —— CLI 的终端属于横幅、命令输出和 TUI。
 *
 * 共享 logger 只看 `NODE_ENV !== 'production'` 就挂 Console transport。对 `npm start` /
 * `npm run dev` 的服务器进程这是对的(它们不经过本文件),对 khy 却不是:一启动,DB Health
 * 之类的内部审计日志就以 `2026-… [info] [DB Health] …` 打进用户终端,并跟 `\r` 覆写的引导
 * 进度行抢同一行。日志一行都没丢 —— 两个 DailyRotateFile transport 照旧全量落盘,这里只
 * 关终端可见性,而且 warn/error 仍然直达用户,真出问题不会被闷掉。
 *
 * 三种情况不降音量:用户显式设过 LOG_LEVEL、显式开了 KHY_DEBUG、或本次带了
 * --verbose/--debug(与 router 的 _applyVerbosityFlag 同一意图,只是提前到日志器初始化前
 * 判定)。另有门控 KHY_CLI_QUIET_LOGS=0 可整体关掉,逐字节回退到今日行为。
 *
 * @param {string[]} args - 已标准化的命令行参数
 */
function _quietConsoleLogsForCli(args) {
  if (_isFalsy(process.env.KHY_CLI_QUIET_LOGS)) return;
  if (process.env.LOG_LEVEL || _isTruthy(process.env.KHY_DEBUG)) return;
  if (args.includes('--verbose') || args.includes('--debug')) return;
  try {
    require('../src/utils/logger').setConsoleLevel('warn');
  } catch { /* logger 不可用时不影响启动 */ }
}

let _startupUpdateCheckScheduled = false;

/**
 * Defer the startup version check until the interactive boot path is ready.
 * The version and update services are lazy-loaded so lightweight commands keep
 * their existing startup graph and timing.
 *
 * "最新版本" is decided across all three release registries (GitHub Releases + PyPI + npm),
 * not by pip alone: with a PyPI-only probe this line misreported "已是最新版本" /
 * "领先于已发布版本" whenever another channel published first.
 */
function _scheduleStartupUpdateCheck(printInfo, printError) {
  if (_startupUpdateCheckScheduled || _isFalsy(process.env.KHY_STARTUP_UPDATE_CHECK)) return;
  _startupUpdateCheckScheduled = true;
  setImmediate(async () => {
    try {
      const { checkForUpdateAll, compareVersions } = require('../src/services/versionService');
      const result = await checkForUpdateAll();
      if (!result || !result.current) return;
      const sourcesText = result.sourcesText || '';

      // 三个仓库都没答上来:诚实沉默(不谎报「已是最新」),仅调试门控下说明原因。
      if (!result.latest) {
        if (_isTruthy(process.env.KHY_STARTUP_UPDATE_DEBUG)) {
          printInfo(`检查未完成：${sourcesText || '所有发布源均不可用'}`, '版本');
        }
        return;
      }

      if (result.updateAvailable) {
        printInfo(
          `发现新版本：当前 v${result.current}，最新 v${result.latest}`
            + (result.sourceLabel ? `（来源 ${result.sourceLabel}）` : ''),
          '更新'
        );
        if (sourcesText) printInfo(sourcesText, '来源');
        if (_isFalsy(process.env.KHY_AUTO_UPDATE)) {
          printInfo('自动安装已关闭（KHY_AUTO_UPDATE=0），需手动运行 khy update。', '更新');
          return;
        }

        const { detectInstallation } = require('../src/services/updateCoordinator');
        const installation = detectInstallation();
        if (installation.type !== 'package') {
          printInfo(
            `当前安装类型为 ${installation.type || 'unknown'}，请运行 khy update apply 完成更新。`,
            '更新'
          );
          return;
        }
        // 自动安装只走 pip(pip 成功后会顺带同步 npm 渠道)。取胜源不是 PyPI 时 pip 拉不到那个版本,
        // 硬跑只会每次启动空转一遍 —— 交给 khy update 的级联更新源,并如实说明。
        if (result.source !== 'pypi' || !(installation.packages && installation.packages.pip)) {
          printInfo(
            `最新版本发布在 ${result.sourceLabel || result.source} 渠道，`
              + '请运行 khy update 从该渠道完成更新。',
            '更新'
          );
          return;
        }

        const { applyUpdate } = require('../src/services/khySelfUpdateService');
        const update = applyUpdate();
        if (update && update.success && update.changed) {
          printInfo('已完成，请重启 CLI 以使用新版本。', '更新');
        } else if (update && !update.success && update.error) {
          printError(`自动更新失败：${String(update.error).slice(0, 240)}`);
        }
        return;
      }

      const suffix = sourcesText ? `（发布源：${sourcesText}）` : '';
      if (compareVersions(result.current, result.latest) > 0) {
        printInfo(`v${result.current} 领先于已发布版本 v${result.latest}${suffix}`, '版本');
      } else {
        printInfo(`v${result.current} 已是最新版本${suffix}`, '版本');
      }
    } catch (error) {
      // Startup update checks are advisory and must never block the CLI.
      if (_isTruthy(process.env.KHY_STARTUP_UPDATE_DEBUG)) {
        printError(`版本检查失败：${String(error?.message || error).slice(0, 240)}`);
      }
    }
  });
}

function _isMachineReadableInvocation(argv = process.argv.slice(2)) {
  const args = normalizeArgs(Array.isArray(argv) ? argv : []);
  return args.includes('--json')
    || args.includes('--print')
    || args.includes('-p');
}

function _maybePrintInstallLocationNotice() {
  if (_isTruthy(process.env.KHY_INSTALL_NOTICE_PRINTED)) return;
  if (_isMachineReadableInvocation()) return;
  const always = _isTruthy(process.env.KHY_SHOW_INSTALL_PATH_ALWAYS);

  const backendDir = path.resolve(__dirname, '..');
  const installRoot = path.resolve(backendDir, '..');
  const packageJson = path.join(backendDir, 'package.json');
  const version = (() => {
    try {
      return String(JSON.parse(fs.readFileSync(packageJson, 'utf8') || '{}').version || '').trim();
    } catch {
      return '';
    }
  })();
  const mode = fs.existsSync(path.join(installRoot, '.git')) ? 'source' : 'npm/runtime';
  const key = version || `path::${backendDir}`;

  const statePath = path.join(
    require('../src/utils/dataHome').getAppHome(),
    'install_notice.json',
  );
  let state = {};
  try {
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
    }
  } catch {
    state = {};
  }
  const shown = (state && typeof state === 'object' && state.shown && typeof state.shown === 'object')
    ? state.shown
    : {};
  if (!always && shown[key]) return;

  try {
    console.error(`[khy] Install ready (version=${version || 'unknown'}, mode=${mode})`);
    console.error(`[khy] Install root: ${installRoot}`);
    console.error(`[khy] Backend dir: ${backendDir}`);
  } catch {
    return;
  }

  shown[key] = new Date().toISOString();
  state.shown = shown;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // best effort
  }
}

// Fire-and-forget: install notice is informational and already rate-limited
// by version key. Making it async removes ~50-200ms of sync fs from the
// critical startup path (including --help / --version).
Promise.resolve().then(() => _maybePrintInstallLocationNotice()).catch(() => {});

// Windows 平台强制切换到 UTF-8 编码，防止中文乱码
if (process.platform === 'win32') {
  // Spawn System32\chcp.com directly instead of going through `cmd /c chcp`
  // (skips one cmd.exe process creation: ~80ms vs ~115ms measured on the
  // critical startup path). Path comes from the SystemRoot env (no literal
  // drive/dir); on any failure fall back to the legacy cmd form.
  // windowsHide:true 让这第一个 chcp 派生也不闪黑框(patch 已覆盖,这里显式再保一层)。
  try {
    const _chcpDirect = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'chcp.com')
      : null;
    if (_chcpDirect) {
      try {
        require('child_process').execFileSync(_chcpDirect, ['65001'], { stdio: 'pipe', windowsHide: true });
      } catch {
        require('child_process').execFileSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'pipe', windowsHide: true });
      }
    } else {
      require('child_process').execFileSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'pipe', windowsHide: true });
    }
  } catch { /* ignore */ }
}

/**
 * 标准化命令行参数
 *
 * 用户经常把双横线参数写成单横线，例如 `-version` 而非 `--version`。
 * 本函数将长度超过 2 的单横线参数自动补齐为双横线格式，
 * 但保留已知的短参数（-h, -V, -v, -i, -p）不做转换。
 *
 * @param {string[]} rawArgs - 原始命令行参数数组（process.argv.slice(2)）
 * @returns {string[]} 标准化后的参数数组
 */
function normalizeArgs(rawArgs = []) {
  const knownShort = new Set(['-h', '-V', '-v', '-i', '-p']); // 已知的合法短参数，不做转换
  return rawArgs.map(a => {
    // 如果是单横线开头、不是双横线、长度>2、且不在已知短参数集合中 → 补齐为双横线
    if (a.startsWith('-') && !a.startsWith('--') && a.length > 2 && !knownShort.has(a)) {
      return '-' + a;
    }
    return a;
  });
}

/**
 * Disable relay fallback in non-interactive command mode by default.
 * This avoids silent hangs when local relay bind is blocked (e.g. EPERM on 127.0.0.1:9099).
 * Users can still explicitly re-enable via GATEWAY_RELAY_ENABLED=true.
 */
function enforceNonInteractiveGatewayGuards(args = []) {
  const normalized = normalizeArgs(args);
  const isPrintMode = normalized.includes('--print') || normalized.includes('-p') || normalized.includes('--ai');
  const isAiControlCmd = normalized[0] === 'gateway' || normalized[0] === 'ai';
  const hasPrompt = normalized.length > 0 && !normalized[0].startsWith('-');
  const nonInteractiveLike = isPrintMode || (hasPrompt && !normalized.includes('-i') && !normalized.includes('--interactive'));
  if (!nonInteractiveLike || isAiControlCmd) return;
  if (process.env.GATEWAY_RELAY_ENABLED === undefined || process.env.GATEWAY_RELAY_ENABLED === '') {
    process.env.GATEWAY_RELAY_ENABLED = 'false';
  }
}

function shouldSkipStartupAutoPreferRemote(args = []) {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0) return false;

  const command = String(normalized[0] || '').toLowerCase();
  const subCommand = String(normalized[1] || '').toLowerCase();
  if (command === 'gateway' || command === 'model' || command === 'doctor' || command === 'init') return true;
  if (command === 'run') return true;
  if (command === 'ai' && (subCommand === 'run' || AI_CONTROL_SUBCOMMANDS.has(subCommand))) return true;
  if (normalized.some(flag => Object.prototype.hasOwnProperty.call(IDE_ADAPTER_FLAGS, flag))) return true;

  return false;
}

async function maybeAutoPreferRemoteOnRestrictedLocal(args = [], { printInfo } = {}) {
  const autoSwitchEnabled = String(process.env.KHY_AUTO_PREFER_REMOTE || 'true').toLowerCase() !== 'false';
  if (!autoSwitchEnabled) return { switched: false, reason: 'disabled' };
  if (shouldSkipStartupAutoPreferRemote(args)) return { switched: false, reason: 'skip-command' };

  const preferredAdapter = String(process.env.GATEWAY_PREFERRED_ADAPTER || '').trim().toLowerCase();
  const preferredIsLocal = preferredAdapter === 'localllm' || preferredAdapter === 'ollama';
  if (!preferredIsLocal) return { switched: false, reason: 'preferred-not-local' };

  // Lightweight loopback probe: connect to a system port (53/DNS) to verify
  // loopback networking is available. This is much faster than creating a
  // net.Server (canListenLoopback uses listen + 1200ms timeout).
  // ECONNREFUSED on 127.0.0.1:53 → loopback restricted; success → available.
  const _net = require('net');
  let loopbackAvailable = true;
  try {
    loopbackAvailable = await new Promise((resolve) => {
      const socket = new _net.Socket();
      // Single finish path: clear timer + detach listeners + destroy socket,
      // so the probe never leaves dangling handles or listeners behind.
      let finished = false;
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { socket.removeAllListeners(); } catch {}
        try { socket.destroy(); } catch {}
        resolve(ok);
      };
      const timer = setTimeout(() => finish(true), 300);
      socket.connect(53, '127.0.0.1', () => finish(true));
      socket.on('error', () => finish(false));
    });
  } catch { loopbackAvailable = false; }
  if (loopbackAvailable) return { switched: false, reason: 'loopback-ok' };

  const autoProbeTimeoutMs = Math.max(
    1000,
    parseInt(process.env.KHY_AUTO_PREFER_REMOTE_TIMEOUT_MS || '3500', 10) || 3500
  );
  const autoGenerationProbeTimeoutMs = Math.max(
    autoProbeTimeoutMs,
    parseInt(process.env.KHY_AUTO_PREFER_REMOTE_GENERATION_TIMEOUT_MS || String(autoProbeTimeoutMs + 1500), 10)
      || (autoProbeTimeoutMs + 1500)
  );

  try {
    const gatewayHandlers = require('../src/cli/handlers/gateway');
    const result = await gatewayHandlers.handleGatewayPreferRemote({
      silent: true,
      probeOnlyAvailable: true,
      probeTimeoutMs: autoProbeTimeoutMs,
      probeGenerationTimeoutMs: autoGenerationProbeTimeoutMs,
    });

    if (result && result.switched && typeof printInfo === 'function' && isInteractiveRun()) {
      const selected = result.selected || {};
      printInfo(
        `检测到本地通道受限，已自动切换远端通道: ${selected.adapter || 'unknown'}${selected.model ? ` · ${selected.model}` : ''}`
      );
    }
    return result || { switched: false, reason: 'unknown-result' };
  } catch {
    return { switched: false, reason: 'prefer-remote-failed' };
  }
}

/**
 * 处理非交互模式下的路由结果
 *
 * 当用户以单条命令模式（非 REPL）执行时，某些命令是不允许的，
 * 比如 exit、menu 等交互专用命令。本函数统一拦截这些非法结果并报错退出。
 *
 * @param {*}        result     - 路由执行后的返回值（false 表示未知命令）
 * @param {object}   parsed     - 解析后的命令对象，包含 command 字段
 * @param {Function} printError - 错误信息打印函数
 * @param {Function} printHelp  - 帮助信息打印函数
 */
async function handleRouterResultForNonInteractive(result, parsed, printError, printHelp) {
  if (result === false) {
    printError(`未知命令: ${parsed.command}`);  // 路由找不到对应处理器
    printHelp();
    process.exit(1);
  }
  if (result === 'exit' || result === 'menu') {
    printError('此命令仅在交互模式下可用');  // exit/menu 只能在 REPL 中使用
    process.exit(1);
  }
  if (result === 'ai-status') {
    const { handleAiStatus } = require('../src/cli/ai');
    await handleAiStatus({ quick: true });
    return;
  }
  if (result === 'ai-config' || result === 'ai-on' || result === 'ai-off') {
    printError('AI 子命令仅在交互模式下可用，请使用 khy -i 后执行');  // AI 管理命令需要 REPL 环境
    process.exit(1);
  }
}

/**
 * 判断本次运行是否为交互模式（REPL）
 *
 * 交互模式下程序不会退出，而是进入一个循环等待用户输入的 REPL 界面。
 * 非交互模式下程序执行完单条命令后立即退出。
 *
 * 判断逻辑（按优先级）：
 *   1. 无参数 → 交互
 *   2. 带 -i / --interactive → 交互
 *   3. 显式 AI 轻量模式下（khy ai / khy --lite / khy run）：
 *      - 带 -p/--print → 非交互（管道输出）
 *      - `khy ai run <model>` 无附加 prompt → 交互
 *      - 有直接 prompt 文本 → 非交互（一次性查询）
 *   4. 纯模式选择参数（--full/--lite/--kiro 等）→ 交互
 *   5. khyquant --no-server/--cli 无其他参数 → 交互
 *
 * @returns {boolean} true 表示交互模式，false 表示单命令模式
 */
function isInteractiveRun() {
  const args = normalizeArgs(process.argv.slice(2));
  if (args.length === 0) return true;                              // 无参数 → 进入 REPL
  if (args.includes('-i') || args.includes('--interactive')) return true; // 显式指定交互模式

  // 检测当前是通过 khy 还是 khyquant 调用的
  const envInvoked = (process.env.KHYQUANT_INVOKED_AS || '').toLowerCase();
  const invoked = path.basename(process.argv[1] || '').toLowerCase();
  const isKhyBinary = envInvoked === 'khy' || /^khy(\.cmd|\.ps1|\.exe|\.js)?$/.test(invoked);       // 是否通过 khy 命令调用
  const isKhyQuantBinary = envInvoked === 'khyquant' || /^khyquant(\.cmd|\.ps1|\.exe|\.js)?$/.test(invoked); // 是否通过 khyquant 命令调用
  const forceLite = args.includes('--lite') || args.includes('--ai-lite');
  const forceFull = args.includes('--full');  // --full 强制进入完整量化模式

  const aiSubCommand = (args[1] || '').toLowerCase();
  const isAiControlCommand = args[0] === 'ai' && AI_CONTROL_SUBCOMMANDS.has(aiSubCommand);
  const isLegacyRunShortcut = isKhyBinary && args[0] === 'run';
  const liteMode = !forceFull && (forceLite || (args[0] === 'ai' && !isAiControlCommand) || isLegacyRunShortcut);
  if (liteMode) {
    let aiArgs = args.filter(a => a !== '--lite' && a !== '--ai-lite');
    if (aiArgs[0] === 'ai') aiArgs = aiArgs.slice(1);
    const pIdx = aiArgs.indexOf('--print') !== -1 ? aiArgs.indexOf('--print') : aiArgs.indexOf('-p');
    if (pIdx !== -1) return false;  // -p/--print 管道模式 → 非交互
    // `khy ai run <model>` 只指定模型不带 prompt → 进入交互聊天
    if (aiArgs[0] === 'run') {
      const runArgs = aiArgs.slice(1).filter(a => !a.startsWith('-'));
      return runArgs.length <= 1;  // 只有模型名、没有额外 prompt → 交互
    }
    const hasPrompt = aiArgs.length > 0 && !aiArgs[0].startsWith('-');
    return !hasPrompt;  // 有直接 prompt → 非交互（一次性查询）
  }

  // 纯模式选择标志（如 --full、--lite、--kiro 等）仍然属于交互启动路径
  const modeOnlyFlags = new Set(['--full', '--lite', '--ai-lite', '--kiro', '--cursor', '--claude', '--codex', '--warp', '--trae', '--windsurf', '--vscode']);
  if (args.every(a => modeOnlyFlags.has(a))) return true;

  // khyquant --no-server / --cli 且无其他命令 → 进入纯 CLI REPL
  if (isKhyQuantBinary) {
    const nonServerFiltered = args.filter(a => a !== '--no-server' && a !== '--cli');
    if (nonServerFiltered.length === 0) return true;
  }

  // khy --<IDE标志> 目前映射到一次性路由（非 REPL），按非交互处理
  if (isKhyBinary) {
    const ideFlags = new Set(['--kiro', '--cursor', '--claude', '--codex', '--warp', '--trae', '--windsurf', '--vscode']);
    const stripped = args.filter(a => !ideFlags.has(a));
    if (stripped.length > 0) return false;
  }

  return false;
}

// ── 全局异常处理 ──────────────────────────────────────────────────────
// 交互模式下：捕获异常但不退出（保持 REPL 存活，用户可以继续操作）
// 非交互模式下：捕获异常后立即退出（快速失败，便于脚本调用检测错误码）
// 始终把致命错误"喊出来"：console.error 在 stdout/stderr 被劫持或 TUI 接管
// 时可能自身抛错，那一句就被 catch 静默吞掉 —— 用户只看到一个裸 exit 1。
// _emitFatal 先走 console.error，失败再退回 fs.writeSync(fd=2) 直写内核，
// 保证非交互崩溃永远带上一行可读归因，而不是无声退出。
function _emitFatal(err) {
  let msg = `\n  ✗ ${err?.stack || err?.message || err}${err?.code ? ` (code: ${err.code})` : ''}\n`;
  // 送别礼「错误真实原因加方法」：他机首启若 node_modules 半装/未 hydrate，深层 require
  // 抛 MODULE_NOT_FOUND，今日只吐上面一行裸 stack。这里把它归因为「真实原因 + 解决方法」
  // 追加在裸 stack 之后（保留 stack 供维护者，另给使用者照抄即用的修法）。
  // 对纯叶子的 require 亦包 try/catch：崩溃现场依赖可能就缺，绝不让归因本身加重致命路径。
  // 门 KHY_STARTUP_FAILURE_EXPLAIN 关 / 无法归因 → explain 为 null → msg 逐字节回退今日行为。
  try {
    const explain = require('../src/bootstrap/startupFailureExplain')
      .explainStartupFailure(err, process.platform, process.env);
    if (explain) msg += explain;
  } catch { /* 归因叶子缺失或异常：绝不加重致命路径，回退裸 stack */ }
  try {
    console.error(msg);
    return;
  } catch { /* console 被劫持 —— 退回裸 fd 写入 */ }
  try {
    require('fs').writeSync(2, msg);
  } catch { /* 连 fd 2 都写不了：已尽力，不再制造二次异常 */ }
}
// 收敛变更（v2）：unhandledRejection / uncaughtException 的渲染全权交给
// crashRecovery.install() —— 它走 reportKhyError 自动按 severity 选面板或
// 单行，且对 fatal/config 自动 process.exit。这里不再重复 _emitFatal，
// 否则同一个异常会被打两次（[CrashRecovery] banner + ✗ stack）。
//
// _emitFatal 仍保留函数定义与导出，供外部调用方需要「绕过 crashRecovery
// 直接写 fd 2」的场景使用（命令行 --print 模式的兜底）。
process.on('unhandledRejection', (err) => {
  if (!isInteractiveRun()) {
    process.exit(1);  // 非交互模式：crashRecovery 也会 exit，这里兜底
  }
});
process.on('uncaughtException', (err) => {
  const fatalCodes = new Set(['ERR_IPC_CHANNEL_CLOSED', 'EPIPE']); // 致命错误码，必须退出
  if (!isInteractiveRun() || fatalCodes.has(err?.code)) {
    process.exit(1);  // 非交互模式或致命错误：退出进程
  }
});

// 确保全局安装时也能正确加载项目根目录下的 .env 配置文件
process.env.KHYQUANT_ROOT = path.resolve(__dirname, '..');
if (!process.env.KHY_ENV_FILE) {
  process.env.KHY_ENV_FILE = path.resolve(process.env.KHYQUANT_ROOT, '.env');
}

// 记录用户的启动目录，以便文件操作能相对于用户所在目录解析路径
process.env.KHYQUANT_CWD = process.cwd();

// ── Windows 数据目录初始化 ─────────────────────────────────────────────
// 在 Windows 上优先使用 D 盘存放数据，通过目录联接（junction）实现：
// 如果 D: 盘存在，创建 ~/.khyquant → D:\.khyquant 的联接，
// 这样所有使用 os.homedir()/.khyquant 的代码都会透明地读写 D 盘
const isPortableDeployment = Boolean(
  process.env.KHY_PORTABLE_ROOT || process.env.KHYQUANT_PORTABLE_ROOT
);
if (process.platform === 'win32' && !isPortableDeployment) {
  try {
    const fs = require('fs');
    const os = require('os');
    const homeDotKhy = path.join(os.homedir(), '.khyquant');
    const preferredDrive = String(
      process.env.KHYQUANT_WINDOWS_DATA_DRIVE || process.env.SystemDrive || 'D:'
    ).trim();
    const normalizedDrive = preferredDrive.endsWith(':') ? preferredDrive : `${preferredDrive.replace(/:$/, '')}:`;
    const driveRoot = `${normalizedDrive}\\`;
    const dDotKhy = path.win32.join(driveRoot, '.khyquant');

    // Only set up junction if D: drive exists and home dir junction doesn't already exist
    if (fs.existsSync(driveRoot)) {
      // Check if ~/.khyquant is already a junction or symlink pointing to D:
      let needsJunction = false;
      try {
        const stat = fs.lstatSync(homeDotKhy);
        if (!stat.isSymbolicLink()) {
          // It's a real directory — migrate it to D: if D: has space
          needsJunction = false; // Don't break existing data
        }
      } catch {
        // ~/.khyquant doesn't exist yet — perfect, create junction
        needsJunction = true;
      }

      if (needsJunction) {
        try {
          // Ensure D:\.khyquant exists
          fs.mkdirSync(dDotKhy, { recursive: true });
          // Create directory junction (no admin rights needed, use execFileSync to avoid injection)
          require('child_process').execFileSync('cmd', ['/c', 'mklink', '/J', homeDotKhy, dDotKhy], {
            stdio: 'pipe', timeout: 5000,
          });
        } catch { /* junction creation failed, fall back to default */ }
      }
    }
  } catch { /* non-critical: fall back to default ~/.khyquant */ }
}

// ── 延迟加载模块（加快冷启动速度）─────────────────────────────────────
// commander、inquirer、chalk、repl、router 等重量级模块
// 只在实际用到时才 require，不在启动时一次性全部加载
const pkg = require('../package.json');
const cliVersion = process.env.KHYQUANT_PKG_VERSION || pkg.version; // CLI 版本号

// ── Bootstrap init: fully deferred off the informational quick paths ──
// --version / --help (and print variants) need neither .env parsing nor env
// defaults, so the bootstrap/init module is intentionally NOT required at
// module top-level. It is lazily required inside main() only after those quick
// paths have already exited, right where _bootstrapInit() is first invoked.
// This keeps the fast path to this file + package.json only — no bootstrap/init
// module load, no .env parse, no shutdown registration.
let _initPromise = null;

// 懒加载 CLI 认证服务（单例模式，首次调用时才加载）
let _cliAuth;
function cliAuth() {
  if (!_cliAuth) _cliAuth = require('../src/services/cliAuthService');
  return _cliAuth;
}

/**
 * 交互式认证门控 —— 阻塞 CLI 使用，直到用户完成注册或登录
 *
 * 执行流程：
 *   1. 检查本地是否有有效会话 → 有则直接放行
 *   2. 检查是否已注册 → 未注册则引导首次注册（用户名 + 密码 + 密保）
 *   3. 已注册但会话过期 → 引导登录（最多 3 次尝试，失败后提供密码找回）
 *
 * @returns {Promise<boolean>} true 表示认证通过，false 表示认证失败
 */
async function ensureAuthenticated() {
  // ── Fast path: check existing session without loading heavy UI modules ──
  const auth = cliAuth();
  const session = auth.checkSession();
  if (session.loggedIn) {
    console.log(`  登录  ${session.username}`);
    return true;
  }

  // Port used by the backend server (same fallback as _serverRequest)
  const PORT = parseInt(process.env.PORT || '3000', 10);

  // ── Slow path: load UI modules only when needed ────────────────────────
  const chalkModule = require('chalk');
  const chalk = chalkModule.default || chalkModule;
  const inquirer = require('inquirer');
  const _fmt = require('../src/cli/formatters');
  const printSuccess = (...a) => _fmt.printSuccess(...a);
  const printError = (...a) => _fmt.printError(...a);
  const printInfo = (...a) => _fmt.printInfo(...a);

  const registered = auth.isRegistered();

  // ── 快速 TCP 探测：在发起任何 HTTP 登录前确认服务器可达 ──────────────
  // 避免服务器未启动时阻塞 5 秒 HTTP 超时。两个路径（注册/已注册）共用。
  let _serverQuickOk = false;
  try {
    _serverQuickOk = await isPortReady(PORT, 400);
  } catch { _serverQuickOk = false; }

  if (!registered) {
    // ── First-time: auto-login with the generated default admin (if the
    //    credentials file exists) when the server is reachable ────────────
    if (_serverQuickOk) {
      let _defaultCreds = null;
      try {
        _defaultCreds = require('../src/services/credentialGenerator').readDefaultAdminCredentials();
      } catch { _defaultCreds = null; }
      if (_defaultCreds) {
        const autoResult = await auth.login(_defaultCreds.username, _defaultCreds.password, undefined, 2000);
        if (autoResult && autoResult.success) {
          console.log(chalk.dim(`  登录  ${_defaultCreds.username} (管理员，已自动登录)`));
          return true;
        }
      }
    }
    // Fallback: manual registration
    console.log('');
    console.log(chalk.cyan.bold('  🎉 欢迎使用 KHY 平台操作系统终端!'));
    console.log(chalk.dim('  首次使用需要注册一个账号 (与网页端通用)\n'));

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'username',
        message: '用户名 (至少 2 个字符):',
        validate: v => v.trim().length >= 2 || '用户名至少 2 个字符',
      },
      {
        type: 'password',
        name: 'password',
        message: '设置密码 (至少 6 个字符):',
        mask: '*',
        validate: v => v.length >= 6 || '密码至少 6 个字符',
      },
      {
        type: 'password',
        name: 'confirmPassword',
        message: '确认密码:',
        mask: '*',
        validate: (v, ans) => v === ans.password || '两次密码不一致',
      },
      {
        type: 'input',
        name: 'email',
        message: '邮箱 (用于找回密码，可回车跳过):',
        default: '',
      },
      {
        type: 'list',
        name: 'securityQuestion',
        message: '选择密保问题 (用于忘记密码时找回):',
        choices: [
          ...auth.SECURITY_QUESTIONS,
          { name: '────────────', value: '__sep__', disabled: true },
          { name: '跳过 (不设置密保)', value: '' },
        ],
      },
    ]);

    // If they chose a security question, ask for the answer
    let securityAnswer = '';
    if (answers.securityQuestion) {
      const sqAnswer = await inquirer.prompt([{
        type: 'input',
        name: 'answer',
        message: '密保答案:',
        validate: v => v.trim().length >= 1 || '请输入密保答案',
      }]);
      securityAnswer = sqAnswer.answer;
    }

    const result = await auth.register(
      answers.username,
      answers.password,
      answers.email || undefined,
      answers.securityQuestion || undefined,
      securityAnswer || undefined,
    );

    if (result.success) {
      console.log('');
      printSuccess(`注册成功! 欢迎, ${result.username}`);
      if (result.serverSynced) {
        printInfo('账号已同步到服务器 (与网页端通用)');
      }
      printInfo('已自动登录，退出前永久有效');
      console.log('');
      return true;
    } else {
      printError(result.error);
      return false;
    }
  } else {
    // ── Existing account: try auto-login with default admin first ───────────
    // If the default-admin credentials file exists (generated on first seed),
    // attempt a silent builtin login so the user never has to type credentials
    // for the machine-local admin account.
    {
      let _defaultCreds = null;
      try {
        _defaultCreds = require('../src/services/credentialGenerator').readDefaultAdminCredentials();
      } catch { _defaultCreds = null; }
      if (_defaultCreds) {
        const autoResult = await auth.login(_defaultCreds.username, _defaultCreds.password, undefined, 2000);
        if (autoResult && autoResult.success) {
          console.log(chalk.dim(`  登录  ${_defaultCreds.username} (管理员，已自动登录)`));
          return true;
        }
      }
    }

    // ── Existing account: login with forgot-password option ──
    // Default-admin credentials file path (no plaintext password in output).
    let _credFileHint = '';
    try {
      _credFileHint = require('../src/services/credentialGenerator').getDefaultAdminCredentialsPath();
    } catch { _credFileHint = ''; }
    console.log('');
    console.log(chalk.cyan('  🔐 请登录 KHY 平台'));
    console.log(chalk.dim('  会话已过期，请重新登录'));
    if (_credFileHint) {
      console.log(chalk.dim(`  提示: 默认管理员凭据见 ${_credFileHint}\n`));
    } else {
      console.log('');
    }

    // Quick server reachability check before prompting for credentials.
    // If server is down, warn the user but still allow local builtin login.
    // The generated default admin (credentials file) authenticates locally
    // without the server.
    if (!_serverQuickOk) {
      printInfo('提示: 后端服务未运行，本地默认管理员仍可登录（凭据见上方文件）。');
    }

    // Allow up to 3 login attempts before offering recovery
    for (let attempt = 0; attempt < 3; attempt++) {
      // Auto-detect OS username for CLI auto-login
      const osUsername = (os.userInfo && os.userInfo().username) || process.env.USERNAME || process.env.USER || '';
      const defaultUsername = osUsername ? osUsername.toLowerCase().replace(/[^a-z0-9_-]/g, '') : '';

      // Try auto-login with credentials file or environment variable (first attempt only)
      if (attempt === 0 && defaultUsername && process.env.KHY_CLI_AUTO_LOGIN !== '0') {
        let autoPassword = null;
        let credentialsPath = null;

        // Try 1: Read from credentials file
        const credPath = path.join(
          require('../src/utils/dataHome').getDataHome(),
          'credentials',
          'default-admin.json'
        );
        credentialsPath = credPath;

        try {
          if (fs.existsSync(credPath)) {
            const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
            if (cred.username === defaultUsername && cred.password) {
              autoPassword = cred.password;
              printInfo(`检测到凭据文件，尝试自动登录...`);
            }
          } else {
            // Credentials file doesn't exist - try to create default admin automatically
            printInfo(`首次运行，正在创建默认管理员账号 (${defaultUsername})...`);

            try {
              // Use synchronous credential generation (no database required for CLI)
              const credGen = require('../src/services/credentialGenerator');
              const adminCreds = credGen.loadOrCreateDefaultAdminCredentials();

              if (adminCreds && adminCreds.password) {
                printSuccess(`✓ 默认管理员凭据已生成`);
                console.log(chalk.dim(`  用户名: ${adminCreds.username}`));
                console.log(chalk.dim(`  凭据文件: ${adminCreds.filePath || credPath}`));

                autoPassword = adminCreds.password;
                printInfo(`使用生成的凭据尝试登录...`);
              } else {
                printInfo(`凭据生成失败，请手动输入`);
              }
            } catch (createErr) {
              // If auto-creation fails, continue to manual login
              printInfo(`自动创建失败，将使用手动登录`);
              console.log(chalk.dim(`  错误: ${createErr.message}`));
            }
          }
        } catch (err) {
          // Ignore and try next method
        }

        // Try 2: Read from environment variable
        if (!autoPassword && process.env.KHY_DEFAULT_PASSWORD) {
          autoPassword = process.env.KHY_DEFAULT_PASSWORD;
          printInfo(`使用环境变量密码，尝试自动登录...`);
        }

        // Try auto-login if we have a password
        if (autoPassword) {
          try {
            const result = await auth.login(defaultUsername, autoPassword);
            if (result.success) {
              console.log('');
              printSuccess(`✓ 自动登录成功! 欢迎回来, ${result.username}`);
              console.log('');
              return true;
            } else {
              // Auto-login failed, try auto-register if user doesn't exist
              printInfo(`用户不存在，正在自动注册...`);
              try {
                // Add timeout to prevent hanging
                const registerPromise = auth.register(defaultUsername, autoPassword);
                const timeoutPromise = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('注册超时')), 10000)
                );

                const registerResult = await Promise.race([registerPromise, timeoutPromise]);

                if (registerResult.success) {
                  console.log('');
                  printSuccess(`✓ 自动注册并登录成功! 欢迎, ${registerResult.username}`);
                  console.log('');
                  return true;
                } else {
                  printInfo(`自动注册失败: ${registerResult.error || 'unknown'}`);
                  printInfo(`提示: 后端服务可能未运行，请先启动后端或手动登录`);
                }
              } catch (regErr) {
                printInfo(`自动注册失败: ${regErr.message || 'unknown'}`);
                printInfo(`提示: 如需使用完整功能，请先运行 'extensions/scripts/khy-installer/setup/start-all.bat' 启动后端服务`);
              }
            }
          } catch (err) {
            printInfo(`自动登录异常: ${err.message || 'unknown'}`);
          }
          console.log('');
        }
      }

      // Skip manual login prompt if we're in non-interactive mode
      if (!isInteractiveTerminal()) {
        printError('自动登录失败且非交互模式，无法继续');
        process.exit(1);
      }

      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'username',
          message: '用户名:',
          default: defaultUsername || undefined,
          validate: v => v.trim().length > 0 || '请输入用户名',
        },
        {
          type: 'password',
          name: 'password',
          message: '密码:',
          mask: '*',
          validate: v => v.length > 0 || '请输入密码',
        },
      ]);

      const result = await auth.login(answers.username, answers.password);
      if (result.success) {
        console.log('');
        printSuccess(`登录成功! 欢迎回来, ${result.username}`);
        console.log('');
        return true;
      }

      printError(result.error);

      if (attempt < 2) {
        printInfo(`还可尝试 ${2 - attempt} 次`);
      }
    }

    // 3 failed attempts — offer password recovery
    console.log('');
    printInfo('登录失败次数过多，是否需要找回密码？');

    const { recovery } = await inquirer.prompt([{
      type: 'list',
      name: 'recovery',
      message: '选择操作:',
      choices: [
        { name: '密保问题找回', value: 'security_question' },
        { name: '邮箱验证码找回', value: 'email' },
        { name: '手机验证码找回', value: 'phone' },
        { name: '────────────', value: '__sep__', disabled: true },
        { name: '退出', value: 'exit' },
      ],
    }]);

    if (recovery === 'exit') return false;

    if (recovery === 'security_question') {
      return await _recoverViaSecurityQuestion(inquirer);
    }

    if (recovery === 'email' || recovery === 'phone') {
      return await _recoverViaVerificationCode(inquirer, recovery);
    }

    return false;
  }
}

/**
 * 检查当前是否在交互式终端中运行（stdin 和 stdout 都是 TTY）
 * 非 TTY 环境（如管道、CI/CD）不支持交互式登录界面
 */
function isInteractiveTerminal() {
  return !!(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY);
}

/**
 * 通过密保问题找回密码
 * 流程：输入用户名 → 获取密保问题 → 回答 → 设置新密码 → 自动登录
 */
async function _recoverViaSecurityQuestion(inquirer) {
  const _fmt = require('../src/cli/formatters');
  const printSuccess = (...a) => _fmt.printSuccess(...a);
  const printError = (...a) => _fmt.printError(...a);
  const printInfo = (...a) => _fmt.printInfo(...a);

  const { username } = await inquirer.prompt([{
    type: 'input',
    name: 'username',
    message: '请输入用户名:',
    validate: v => v.trim().length > 0 || '请输入用户名',
  }]);

  const qResult = await cliAuth().getSecurityQuestion(username);
  if (!qResult.success) {
    printError(qResult.error);
    return false;
  }

  printInfo(`密保问题: ${qResult.question}`);

  const { answer, newPassword, confirmPassword } = await inquirer.prompt([
    { type: 'input', name: 'answer', message: '密保答案:', validate: v => v.trim().length > 0 || '请输入答案' },
    { type: 'password', name: 'newPassword', message: '设置新密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
    { type: 'password', name: 'confirmPassword', message: '确认新密码:', mask: '*', validate: (v, a) => v === a.newPassword || '两次密码不一致' },
  ]);

  const resetResult = await cliAuth().resetPasswordWithSecurityAnswer(username, answer, newPassword);
  if (resetResult.success) {
    printSuccess('密码重置成功! 已自动登录');
    return true;
  } else {
    printError(resetResult.error);
    return false;
  }
}

/**
 * 通过手机或邮箱验证码找回密码
 * 流程：输入手机号/邮箱 → 发送验证码 → 输入验证码 → 设置新密码
 */
async function _recoverViaVerificationCode(inquirer, channel) {
  const _fmt = require('../src/cli/formatters');
  const printSuccess = (...a) => _fmt.printSuccess(...a);
  const printError = (...a) => _fmt.printError(...a);
  const printInfo = (...a) => _fmt.printInfo(...a);

  const label = channel === 'phone' ? '手机号' : '邮箱';

  const { target } = await inquirer.prompt([{
    type: 'input',
    name: 'target',
    message: `请输入注册时的${label}:`,
    validate: v => v.trim().length >= 3 || `请输入有效的${label}`,
  }]);

  printInfo('正在发送验证码...');
  const sendResult = await cliAuth().requestVerificationCode(channel, target);

  if (!sendResult.success) {
    printError(sendResult.error);
    return false;
  }

  printSuccess(sendResult.message);

  const { code, newPassword, confirmPassword } = await inquirer.prompt([
    { type: 'input', name: 'code', message: '验证码:', validate: v => v.trim().length >= 4 || '请输入验证码' },
    { type: 'password', name: 'newPassword', message: '设置新密码 (至少 6 字符):', mask: '*', validate: v => v.length >= 6 || '至少 6 个字符' },
    { type: 'password', name: 'confirmPassword', message: '确认新密码:', mask: '*', validate: (v, a) => v === a.newPassword || '两次密码不一致' },
  ]);

  const resetResult = await cliAuth().resetPasswordWithVerificationCode(channel, target, code, newPassword);
  if (resetResult.success) {
    printSuccess('密码重置成功! 请重新登录');
    return false; // Re-enter login flow on next run
  } else {
    printError(resetResult.error);
    return false;
  }
}

/**
 * 启动后端服务器（后台运行）+ 显示前端访问地址 + 进入交互式 REPL
 *
 * 执行流程：
 *   1. 检查后端端口是否已被占用（已有服务在运行则跳过启动）
 *   2. 后台启动 server.js（detached 模式，不阻塞 CLI）
 *   3. 检测前端端口，显示可访问的 URL
 *   4. 自动打开浏览器访问前端页面
 *   5. 进入 REPL 交互循环
 */
async function startWithServer() {
  const chalkModule = require('chalk');
  const chalk = chalkModule.default || chalkModule;
  const net = require('net');
  const { spawn } = require('child_process');

  const PORT = parseInt(process.env.PORT || '3000', 10);
  const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || '8080', 10);

  // Check if server is already running (lightweight TCP connect)
  const serverRunning = await isPortReady(PORT, 400);

  if (!serverRunning) {
    // Start backend server in background
    try {
      const serverScript = path.resolve(__dirname, '..', 'server.js');
      const fs = require('fs');
      if (fs.existsSync(serverScript)) {
        const child = spawn(process.execPath, [serverScript], {
          cwd: path.resolve(__dirname, '..'),
          env: { ...process.env, PORT: String(PORT) },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.unref();

        // Capture startup errors for log display
        let startupLog = '';
        child.stderr.on('data', (d) => { startupLog += d.toString(); });
        child.stdout.on('data', (d) => { startupLog += d.toString(); });

        // Poll for server ready instead of fixed 1.5s delay.
        // Uses lightweight TCP connect (isPortReady) instead of creating
        // a server each tick. Detects the bound port in ~300-600ms.
        const pollStart = Date.now();
        const POLL_INTERVAL = 150;   // ms between checks
        const POLL_TIMEOUT = 10000;  // give up after 10s
        await new Promise((resolve) => {
          const tick = async () => {
            if (await isPortReady(PORT)) return resolve();
            if (Date.now() - pollStart > POLL_TIMEOUT) return resolve();
            setTimeout(tick, POLL_INTERVAL);
          };
          setTimeout(tick, 250); // small initial grace period
        });

        const nowRunning = await isPortReady(PORT, 400);
        if (nowRunning) {
          console.log(chalk.green(`  ✓ 后端服务已启动 → http://localhost:${PORT}`));
        } else {
          console.log(chalk.yellow(`  ⚠ 后端服务启动中... (端口 ${PORT})`));
          if (startupLog.trim()) {
            console.log(chalk.dim(`    ${startupLog.trim().split('\n')[0]}`));
          }
        }
      }
    } catch { /* server start is optional */ }
  } else {
    console.log(chalk.dim(`  服务  后端已在运行 (端口 ${PORT})`));
  }

  // Check/show frontend URL and auto-open in browser
  const frontendRunning = await isPortReady(FRONTEND_PORT, 400);
  let frontendUrl;
  if (frontendRunning) {
    frontendUrl = `http://localhost:${FRONTEND_PORT}`;
    console.log(chalk.green(`  ✓ 前端可访问 → `) + chalk.bold.cyan(frontendUrl));
  } else {
    // Frontend is served by backend in production mode
    frontendUrl = `http://localhost:${PORT}`;
    console.log(chalk.dim(`  前端  ${frontendUrl} (后端一体化服务)`));
  }

  // Auto-open frontend in default browser (use execFile to avoid shell injection)
  if (frontendUrl) {
    try {
      const { execFile } = require('child_process');
      const openUrl = frontendUrl;
      if (process.platform === 'win32') {
        execFile('cmd', ['/c', 'start', '', openUrl], { timeout: 5000 });
      } else if (process.platform === 'darwin') {
        execFile('open', [openUrl], { timeout: 5000 });
      } else {
        execFile('xdg-open', [openUrl], { timeout: 5000 });
      }
      console.log(chalk.dim(`  浏览  已自动打开 ${openUrl}`));
    } catch { /* non-critical: user can open manually */ }
  }

  console.log('');

  // UX5: 清除冷启动加载提示(REPL 即将接管终端)
  if (process.stdout.isTTY && !process.env.KHY_QUIET_STARTUP) {
    process.stdout.write('\x1B[2K\x1B[0G'); // 清行 + 光标移到行首
  }

  // Enter REPL
  const { startRepl } = require('../src/cli/repl');
  await startRepl();
}

/**
 * 检查指定端口是否已被占用
 * 原理：尝试在该端口创建 TCP 服务，如果报 EADDRINUSE 则说明已被占用
 * @param {number} port - 要检查的端口号
 * @returns {Promise<boolean>} true 表示端口已被占用
 */
function isPortInUse(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

/**
 * Lightweight port probe: try TCP connect instead of creating a server.
 * Used in polling loops where we check repeatedly — much lower overhead
 * than isPortInUse() which creates/destroys a net.Server each call.
 */
function isPortReady(port, timeoutMs = 500) {
  const net = require('net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    // Single finish path: clear timer + detach listeners + destroy socket.
    // This probe runs in polling loops, so every completion (success/failure/
    // timeout) must fully release its handles to avoid accumulation.
    let finished = false;
    const finish = (ready) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.removeAllListeners(); } catch {}
      try { socket.destroy(); } catch {}
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.connect(port, '127.0.0.1', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

// ── 检测调用方式：khy 还是 khyquant ─────────────────────────────────
// 两个命令名在 package.json 的 bin 字段中都指向本文件。
// khy       → khy OS 主入口（平台能力 + 应用运行时）
// khyquant  → 默认应用兼容入口（上层应用/插件）
/**
 * 检测当前是通过哪个命令名调用的
 *
 * 优先级：
 *   1. 环境变量 KHYQUANT_INVOKED_AS（Python 启动器设置）
 *   2. process.argv[1] 中的可执行文件名
 *   3. 默认回退到 khyquant（完整模式）
 *
 * @returns {'khy'|'khyquant'} 调用方式标识
 */
function getInvokedBinary() {
  // 优先级1：Python 启动器会通过环境变量告知是哪个 console_scripts 入口
  const envInvoked = (process.env.KHYQUANT_INVOKED_AS || '').toLowerCase();
  if (envInvoked === 'khy') return 'khy';
  if (envInvoked === 'khyquant') return 'khyquant';
  // 优先级2：检查 process.argv[1]（直接 node 调用或 npx 调用）
  const invoked = path.basename(process.argv[1] || '').toLowerCase();
  if (/^khy(\.cmd|\.ps1|\.exe|\.js)?$/.test(invoked)) return 'khy';
  if (/^khyquant(\.cmd|\.ps1|\.exe|\.js)?$/.test(invoked)) return 'khyquant';
  // 默认：完整模式（直接 `node bin/khy.js` 调用的情况）
  return 'khyquant';
}

/**
 * 主函数 —— 整个 CLI 的入口点
 *
 * 启动流程：
 *   1. 等待引导初始化完成（环境变量、默认配置）
 *   2. 获取命令行参数并标准化
 *   3. 检测调用方式（khy / khyquant）
 *   4. 快速路径处理（--help / --version 立即退出）
 *   5. 根据调用方式和参数分流：
 *      a. 显式 AI 模式 → 轻量 AI REPL / 一次性查询 / Ollama 模型运行
 *      b. 默认模式无参数 → 认证 → 启动服务器 → REPL
 *      c. 默认模式 + 命令 → 直接路由执行后退出
 */
async function main() {
  const rawArgs = process.argv.slice(2);
  let args = normalizeArgs(rawArgs);
  if (_startupFsm) _startupFsm.fire('advance', { step: 'args_normalized' }); // -> env_check

  // ── 启动提示：阶段进度指示器 ──────────────────────────────────────
  // 仅交互式终端下显示，管道/重定向时静默。
  // 在引导初始化的各关键节点调用 _updateBootPhase() 更新进度文本，
  // 使用 \r 覆盖同一行，让用户感知系统正在逐步就绪。
  const _isBootTty = process.stderr.isTTY && !args.includes('--help') && args[0] !== 'help';
  let _bootPhaseWrite = null; // 函数引用,在 _isBootTty 判定后才创建
  let _bootPhaseLine = null;  // 句柄:负责在别人输出前让出瞬时行,并在交棒时收尾
  if (_isBootTty) {
    // 进度行是瞬时的(\r 覆写、行尾无换行),所以它必须在任何其他输出落地前先擦掉自己,
    // 否则「ℹ 已登录」「版本通知」会从行中间续写,糊成一条永久残留的半截行。
    _bootPhaseLine = require('../src/cli/bootPhaseLine').create();
    _bootPhaseWrite = (phaseText) => _bootPhaseLine.write(phaseText);
    // 命令在进度行亮着时直接退出(自身无任何 console 输出)的兜底:退出前擦干净。
    try {
      process.once('exit', () => _bootPhaseLine.end());
    } catch { /* 注册不上不影响启动 */ }
    _bootPhaseWrite('⌛ khy 正在启动');
  }

  // ── 快速路径：在 bootstrap 之前检查，立即退出 ─────────────────────────
  // --help / --version 不需要数据库或环境初始化，直接响应
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    const { printHelp, printHelpTopic, printInfo } = require('../src/cli/formatters');
    const topic = args[0] === 'help' && args[1] ? args[1] : '';
    if (topic) {
      printHelpTopic(topic);
    } else {
      printHelp();
    }
    const _invokedAs = getInvokedBinary();
    if (_invokedAs === 'khyquant' && !topic) {
      printInfo('提示: `khyquant` 仅用于启动量化应用；系统命令请使用 `khy ...`。');
    }
    process.exit(0);
  }

  const firstArg = String(args[0] || '');
  const isVersionQuickPath = (
    (firstArg === '--version' || firstArg === '-V' || firstArg === '-v' || firstArg === 'version')
    && args.length === 1
  );
  if (isVersionQuickPath) {
    console.log(cliVersion);
    process.exit(0);
  }

  // ── 引导初始化（非快速路径才需要）──────────────────────────────────
  // Lazy require: the bootstrap/init module is pulled into the require graph
  // here, past the quick paths, so --version/--help never load it. For real
  // commands this runs before any other init, exactly as the eager require did.
  if (_bootPhaseWrite) _bootPhaseWrite('⏳ 加载环境配置');
  _quietConsoleLogsForCli(args);
  if (!_initPromise) {
    const { init: _bootstrapInit } = require('../src/bootstrap/init');
    _initPromise = _bootstrapInit({ machineReadable: _isMachineReadableInvocation(args) });
  }
  await _initPromise;
  if (_bootPhaseWrite) _bootPhaseWrite('✓ 环境就绪');
  checkpoint('main:start');
  if (_startupFsm) _startupFsm.fire('advance', { step: 'bootstrap_init_done' }); // -> modules_load

  const invokedAs = getInvokedBinary();       // 检测是 khy 还是 khyquant 调用
  process.env.KHY_RUNTIME_MODE = invokedAs === 'khy' ? 'khy' : 'khyquant';
  if (invokedAs === 'khy') {
    // Default to low-latency interactive input for khy shell.
    // Users can still opt out via env vars (e.g. KHY_INPUT_FRAME=0).
    if (process.env.KHY_LOW_LATENCY_INPUT === undefined) process.env.KHY_LOW_LATENCY_INPUT = '1';
    if (process.env.KHY_INPUT_FRAME === undefined) process.env.KHY_INPUT_FRAME = '1';
    if (process.env.KHY_SLASH_AUTOMENU === undefined) process.env.KHY_SLASH_AUTOMENU = 'false';
    if (process.env.KHY_INPUT_BATCH_MODE === undefined) process.env.KHY_INPUT_BATCH_MODE = 'off';
    if (process.env.KHY_INPUT_ESCAPE_TIMEOUT_MS === undefined) process.env.KHY_INPUT_ESCAPE_TIMEOUT_MS = '40';
    // Sidebar threshold: DO NOT override here. The single source of truth is
    // sidebarLayout.minCols (default 120) — quoted by the Ctrl+T hint and the
    // OPS-MAN-062 doc. A launcher default of 200 silently killed the sidebar on
    // real maximized terminals (DPI-scaled ≈150–160 cols never reach 200).
    // Users can still override via KHY_SIDEBAR_MIN_COLS or disable via KHY_SIDEBAR=0.
    // Fast-response defaults with minimum resilience for adapter failover.
    if (process.env.GATEWAY_MAX_TOTAL_ATTEMPTS === undefined) process.env.GATEWAY_MAX_TOTAL_ATTEMPTS = '4';
    if (process.env.GATEWAY_MAX_RETRY_DELAY_BUDGET_MS === undefined) process.env.GATEWAY_MAX_RETRY_DELAY_BUDGET_MS = '5000';
    // 网关 idle/stall 超时默认值:门控纯叶子决定 CC 量级(idle 60s/hard 180s)或逐字节回退
    // 今日写死值(idle 20s/hard 45s)。=== undefined 守卫保留 → 用户显式 env 仍最高优先。
    let _gwTo = { hardTimeoutMs: 45000, idleTimeoutMs: 20000 };
    try { _gwTo = require('../src/services/gatewayIdleTimeoutPolicy').launcherTimeoutDefaults(process.env); } catch (_e) { /* fail-soft: 保留 legacy 默认 */ }
    if (process.env.KHY_GATEWAY_TIMEOUT_MS === undefined) process.env.KHY_GATEWAY_TIMEOUT_MS = String(_gwTo.hardTimeoutMs);
    if (process.env.KHY_GATEWAY_IDLE_TIMEOUT_MS === undefined) process.env.KHY_GATEWAY_IDLE_TIMEOUT_MS = String(_gwTo.idleTimeoutMs);
    if (process.env.GATEWAY_CLAUDE_HANDSHAKE_TIMEOUT_MS === undefined) process.env.GATEWAY_CLAUDE_HANDSHAKE_TIMEOUT_MS = '12000';
    if (process.env.GATEWAY_CLAUDE_HANDSHAKE_SIMPLE_MS === undefined) process.env.GATEWAY_CLAUDE_HANDSHAKE_SIMPLE_MS = '9000';
    if (process.env.RELAY_API_RETRY_TOTAL_ATTEMPTS === undefined) process.env.RELAY_API_RETRY_TOTAL_ATTEMPTS = '3';
    if (process.env.RELAY_API_RETRY_BASE_DELAY_MS === undefined) process.env.RELAY_API_RETRY_BASE_DELAY_MS = '350';
    if (process.env.RELAY_API_RETRY_MAX_DELAY_MS === undefined) process.env.RELAY_API_RETRY_MAX_DELAY_MS = '1800';
    if (process.env.GATEWAY_COOLDOWN_SELF_HEAL_ENABLED === undefined) process.env.GATEWAY_COOLDOWN_SELF_HEAL_ENABLED = 'true';
    if (process.env.GATEWAY_COOLDOWN_SELF_HEAL_TICK_MS === undefined) process.env.GATEWAY_COOLDOWN_SELF_HEAL_TICK_MS = '3000';
    if (process.env.GATEWAY_COOLDOWN_SELF_HEAL_MIN_INTERVAL_MS === undefined) process.env.GATEWAY_COOLDOWN_SELF_HEAL_MIN_INTERVAL_MS = '7000';
    if (process.env.GATEWAY_COOLDOWN_SELF_HEAL_MIN_REMAINING_MS === undefined) process.env.GATEWAY_COOLDOWN_SELF_HEAL_MIN_REMAINING_MS = '2500';
    if (process.env.GATEWAY_COOLDOWN_SELF_HEAL_PROBE_TIMEOUT_MS === undefined) process.env.GATEWAY_COOLDOWN_SELF_HEAL_PROBE_TIMEOUT_MS = '9000';
    if (process.env.GATEWAY_COOLDOWN_SELF_HEAL_PROBE_GENERATION_TIMEOUT_MS === undefined) process.env.GATEWAY_COOLDOWN_SELF_HEAL_PROBE_GENERATION_TIMEOUT_MS = '7000';
    if (process.env.KHY_PREFLIGHT_NON_BLOCKING === undefined) process.env.KHY_PREFLIGHT_NON_BLOCKING = 'true';
    if (process.env.KHY_PREFLIGHT_MAX_MS === undefined) process.env.KHY_PREFLIGHT_MAX_MS = '1800';
    if (process.env.KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS === undefined) process.env.KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS = '900';
    if (process.env.KHY_PREFLIGHT_MAX_CANDIDATES === undefined) process.env.KHY_PREFLIGHT_MAX_CANDIDATES = '2';
    if (process.env.KHY_GATEWAY_WARMUP_ON_BOOT === undefined) process.env.KHY_GATEWAY_WARMUP_ON_BOOT = 'true';
    if (process.env.KHY_GATEWAY_FAST_RATE_LIMIT === undefined) process.env.KHY_GATEWAY_FAST_RATE_LIMIT = 'true';
    if (process.env.KHY_GATEWAY_REFRESH_NON_BLOCKING === undefined) process.env.KHY_GATEWAY_REFRESH_NON_BLOCKING = 'true';
    if (process.env.KHY_CHAT_AUTOTUNE === undefined) process.env.KHY_CHAT_AUTOTUNE = 'true';
    if (process.env.KHY_CHAT_AUTOTUNE_MIN_SAMPLES === undefined) process.env.KHY_CHAT_AUTOTUNE_MIN_SAMPLES = '12';
    if (process.env.KHY_CHAT_AUTOTUNE_MIN_INTERVAL_MS === undefined) process.env.KHY_CHAT_AUTOTUNE_MIN_INTERVAL_MS = '120000';
    if (process.env.GATEWAY_ACTIVITY_PULSE_MS === undefined) process.env.GATEWAY_ACTIVITY_PULSE_MS = '4000';
    if (process.env.GATEWAY_STATUS_DEDUP_MS === undefined) process.env.GATEWAY_STATUS_DEDUP_MS = '700';
    if (process.env.GATEWAY_RATE_LIMIT_MAX_WAIT_MS === undefined) process.env.GATEWAY_RATE_LIMIT_MAX_WAIT_MS = '2500';
    if (process.env.GATEWAY_RATE_LIMIT_JITTER_MAX_MS === undefined) process.env.GATEWAY_RATE_LIMIT_JITTER_MAX_MS = '600';
    if (process.env.GATEWAY_FAILURE_BACKOFF_BASE_MS === undefined) process.env.GATEWAY_FAILURE_BACKOFF_BASE_MS = '250';
    if (process.env.GATEWAY_FAILURE_BACKOFF_CAP_MS === undefined) process.env.GATEWAY_FAILURE_BACKOFF_CAP_MS = '1800';
    if (process.env.GATEWAY_FAILURE_BACKOFF_ON_FIRST_ATTEMPT === undefined) process.env.GATEWAY_FAILURE_BACKOFF_ON_FIRST_ATTEMPT = 'false';
    if (process.env.KHY_GATEWAY_RECOVERY_RETRIES === undefined) process.env.KHY_GATEWAY_RECOVERY_RETRIES = '0';
    if (process.env.KHY_GATEWAY_RECOVERY_RETRIES_SMALL === undefined) process.env.KHY_GATEWAY_RECOVERY_RETRIES_SMALL = '0';
    if (process.env.KHY_GATEWAY_RECOVERY_RETRIES_LARGE === undefined) process.env.KHY_GATEWAY_RECOVERY_RETRIES_LARGE = '0';
    if (process.env.KHY_GATEWAY_THROW_FALLBACK === undefined) process.env.KHY_GATEWAY_THROW_FALLBACK = 'false';
    // Keep strict-preferred reliability: process-like bridge failures should
    // auto-relax in-request and allow fallback adapters (small/large tasks).
    if (process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS === undefined) process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = 'true';
    if (process.env.KHY_HARNESS_RETRY_ATTEMPTS === undefined) process.env.KHY_HARNESS_RETRY_ATTEMPTS = '1';
    if (process.env.KHY_HARNESS_RETRY_MIN_DELAY_MS === undefined) process.env.KHY_HARNESS_RETRY_MIN_DELAY_MS = '250';
    if (process.env.KHY_HARNESS_RETRY_MAX_DELAY_MS === undefined) process.env.KHY_HARNESS_RETRY_MAX_DELAY_MS = '800';
    if (process.env.KHY_HARNESS_MAX_CONTINUATION_ROUNDS === undefined) process.env.KHY_HARNESS_MAX_CONTINUATION_ROUNDS = '0';
    if (process.env.KHY_SELF_CHECK_ENABLED === undefined) process.env.KHY_SELF_CHECK_ENABLED = 'false';
    if (process.env.KHY_PLUGIN_AUTOLOAD === undefined) process.env.KHY_PLUGIN_AUTOLOAD = 'false';
    if (process.env.KHY_TOOL_LOOP === undefined) process.env.KHY_TOOL_LOOP = 'true';
    if (process.env.KHY_TOOL_LOOP_MAX_ITERATIONS === undefined) process.env.KHY_TOOL_LOOP_MAX_ITERATIONS = '8';
    if (process.env.KHY_INTENT_LOOP_MAX_CAP === undefined) process.env.KHY_INTENT_LOOP_MAX_CAP = '16';
  }

  if (_bootPhaseWrite) _bootPhaseWrite('🔄 准备运行环境');

  // ── 参数标准化：用户常把 -version 写成单横线，自动补齐为 --version ────
  // (args already normalized at top of main() for fast-path checks)
  enforceNonInteractiveGatewayGuards(args);

  // 模式标志：
  // --full   强制完整平台模式（兼容保留）
  // --lite   显式进入轻量 AI 模式
  // --ai-lite 与 --lite 等价（兼容别名）
  const forceLite = args.includes('--lite') || args.includes('--ai-lite');
  const forceFull = args.includes('--full');
  if (forceFull || forceLite) {
    args = args.filter(a => a !== '--full' && a !== '--lite' && a !== '--ai-lite');
  }

  // ── IDE 反向代理模式：通过 --kiro/--cursor 等标志选择 AI 适配器 ──────
  // 例如 khy --cursor 会将 AI 请求转发到 Cursor IDE 的 API
  const ideFlag = args.find(a => IDE_ADAPTER_FLAGS[a]);   // 查找参数中是否包含 IDE 标志
  if (ideFlag) {
    const adapterKey = IDE_ADAPTER_FLAGS[ideFlag];
    process.env.GATEWAY_PREFERRED_ADAPTER = adapterKey; // 设置 AI 网关优先适配器
    args = args.filter(a => !IDE_ADAPTER_FLAGS[a]);     // 移除 IDE 标志以免影响后续命令解析
    // 无需回写 process.argv：本文件的 argv 读取都发生在 main() 入口（第 1208 行）之前，
    // 下游脚本的 argv 读取一律在 `require.main === module` 守卫内，进程内 require 时不执行。
  }

  // 懒加载格式化工具函数（首次调用时才 require，避免拖慢启动）
  const fmt = () => require('../src/cli/formatters');
  const printError = (...a) => fmt().printError(...a);
  const printSuccess = (...a) => fmt().printSuccess(...a);
  const printInfo = (...a) => fmt().printInfo(...a);
  const printHelp = (...a) => fmt().printHelp(...a);

  if (_startupFsm) _startupFsm.fire('advance', { step: 'gateway_auto_prefer_remote' }); // -> service_discover
  // 启动自愈：若当前优先本地通道且运行环境禁止 loopback 监听，自动切到可用远端通道
  await maybeAutoPreferRemoteOnRestrictedLocal(args, { printInfo });

  // ── 分支1：显式轻量 AI 模式（无需认证、无需服务器） ─────────────────
  // 触发条件：
  // - khy ai ...
  // - khy --lite ...
  // - 兼容快捷: khy run <model> ...
  const aiSubCommand = (args[1] || '').toLowerCase();
  const isAiControlCommand = args[0] === 'ai' && AI_CONTROL_SUBCOMMANDS.has(aiSubCommand);
  const isLegacyRunShortcut = invokedAs === 'khy' && args[0] === 'run';
  const isExplicitAi = !forceFull && (forceLite || (args[0] === 'ai' && !isAiControlCommand) || isLegacyRunShortcut);

  if (isExplicitAi) {
    process.env.KHYQUANT_AI_MODE = 'true';  // 标记当前为 AI 模式
    // 轻量模式的会话级初始化（跳过数据库和迁移，速度更快）
    try {
      const { setup } = require('../src/bootstrap/setup');
      await setup({ mode: 'khy', silent: true });
    } catch { /* 引导初始化是非关键操作 */ }
    checkpoint('khy:setup-done');
    const aiArgs = args[0] === 'ai' ? args.slice(1) : args; // 如果有 "ai" 前缀则剥离

    // ── khy ai run <model> [prompt...] / khy run <model> [prompt...] ────
    if (aiArgs[0] === 'run') {
      const runArgs = aiArgs.slice(1);
      const printIdx = runArgs.indexOf('--print') !== -1 ? runArgs.indexOf('--print') : runArgs.indexOf('-p');
      const filteredRunArgs = printIdx !== -1 ? runArgs.filter((_, i) => i !== printIdx) : runArgs;
      const modelId = (filteredRunArgs[0] || '').trim();
      const prompt = filteredRunArgs.slice(1).join(' ').trim();

      if (!modelId) {
        printError('用法: khy ai run <model-id> [prompt]');
        printInfo('兼容: khy run <model-id> [prompt]');
        printInfo('示例: khy ai run qwen3.5:4b');
        printInfo('示例: khy ai run qwen3.5:4b 你好');
        process.exit(1);
      }

      process.env.GATEWAY_PREFERRED_ADAPTER = 'ollama';
      process.env.GATEWAY_PREFERRED_STRICT = 'true';
      process.env.OLLAMA_MODEL = modelId;
      printSuccess(`已切换到 Ollama 模型: ${modelId}`);

      // Optional runtime check for clearer error before starting chat.
      try {
        const mgr = require('../src/services/ollamaModelManager');
        const ensure = await mgr.ensureOllamaRunning({ autoStart: true, waitMs: 3500 });
        if (!ensure.running) {
          printInfo(`Ollama 不可用: ${ensure.error || 'unknown'}，将自动回退到其他 AI 通道`);
        }
      } catch {
        // Non-critical: continue and let adapter return detailed errors.
      }

      if (printIdx !== -1) {
        if (!prompt) {
          printError('用法: khy ai run <model-id> -p "your question"');
          process.exit(1);
        }
        if (_startupFsm) _startupFsm.fire('skip_to_running', { step: 'ai_run_print' }); // one-shot, skips repl
        const { chat } = require('../src/cli/ai');
        const result = await chat(prompt, { onChunk: null });
        if (result && result.reply) process.stdout.write(result.reply + '\n');
        process.exit(result && result.errorType ? 2 : 0);
      }

      if (prompt) {
        if (_startupFsm) _startupFsm.fire('skip_to_running', { step: 'ai_run_oneshot' }); // one-shot, skips repl
        const { startRepl } = require('../src/cli/repl');
        await startRepl({ oneShot: true, prompt });
        process.exit(0);
      }

      if (_startupFsm) _startupFsm.fire('advance', { step: 'ai_run_repl_init' }); // -> repl_init
      if (isInteractiveTerminal()) {
        const authOk = await ensureAuthenticated();
        if (!authOk) { printError('认证失败，无法使用终端。'); process.exit(1); }
      }
      const { startRepl } = require('../src/cli/repl');
      if (_startupFsm) _startupFsm.fire('advance', { step: 'ai_run_repl_enter' }); // -> running
      await startRepl();
      return;
    }

    // ── khy -p "prompt" → 纯文本打印模式（适合管道和脚本调用）──────────
    const pIdx = aiArgs.indexOf('--print') !== -1 ? aiArgs.indexOf('--print') : aiArgs.indexOf('-p');
    if (pIdx !== -1) {
      const prompt = aiArgs.filter((_, i) => i !== pIdx).join(' ');
      if (!prompt) {
        require('../src/cli/formatters').printError('用法: khy -p "your question"');
        process.exit(1);
      }
      if (_startupFsm) _startupFsm.fire('skip_to_running', { step: 'ai_print' }); // one-shot, skips repl
      const { chat } = require('../src/cli/ai');
      const result = await chat(prompt, { onChunk: null });
      if (result && result.reply) process.stdout.write(result.reply + '\n');
      process.exit(result && result.errorType ? 2 : 0);
    }

    // ── khy ai "问题" / khy --lite "问题" → 一次性格式化查询（带美化输出后退出）──
    const hasPrompt = aiArgs.length > 0 && !aiArgs[0].startsWith('-');
    if (hasPrompt) {
      if (_startupFsm) _startupFsm.fire('skip_to_running', { step: 'ai_oneshot' }); // one-shot, skips repl
      const { startRepl } = require('../src/cli/repl');
      await startRepl({ oneShot: true, prompt: aiArgs.join(' ') });
      process.exit(0);
    }

    // ── khy ai / khy --lite（无附加参数）→ 进入 AI REPL ────────────
    if (_startupFsm) _startupFsm.fire('advance', { step: 'ai_repl_init' }); // -> repl_init
    if (isInteractiveTerminal()) {
      const authOk = await ensureAuthenticated();
      if (!authOk) { printError('认证失败，无法使用终端。'); process.exit(1); }
    }
    const { startRepl } = require('../src/cli/repl');
    if (_startupFsm) _startupFsm.fire('advance', { step: 'ai_repl_enter' }); // -> running
    await startRepl();
    return;
  }

  // ── 分支2：khy / khyquant -i / --interactive → 带 AI 功能的交互式 REPL ──
  if (args.includes('--interactive') || args.includes('-i')) {
    if (_startupFsm) _startupFsm.fire('advance', { step: 'interactive_repl_init' }); // -> repl_init
    if (!isInteractiveTerminal()) {
      printError('当前环境不支持交互登录。请在终端中运行，或使用 --print/-p 非交互模式。');
      process.exit(1);
    }
    if (invokedAs === 'khy') {
      const authOk = await ensureAuthenticated();
      if (!authOk) { printError('认证失败，无法使用终端。'); process.exit(1); }
      try {
        const { setup } = require('../src/bootstrap/setup');
        await setup({ mode: 'khy', silent: true });
      } catch { /* non-critical */ }
      checkpoint('khy:setup-done');
      const { startRepl } = require('../src/cli/repl');
      if (_startupFsm) _startupFsm.fire('advance', { step: 'interactive_khy_repl_enter' }); // -> running
      await startRepl({ mode: 'khy', enablePluginAutoload: false });
      return;
    }
    const authenticated = await ensureAuthenticated();
    if (!authenticated) {
      printError('认证失败，无法使用终端。如需重置请删除 ~/.khyquant/credentials.json');
      process.exit(1);
    }
    process.env.KHYQUANT_AI_MODE = 'true';
    const { startRepl } = require('../src/cli/repl');
    if (_startupFsm) _startupFsm.fire('advance', { step: 'interactive_repl_enter' }); // -> running
    await startRepl();
    return;
  }

  // ── 分支3：khy / khyquant -p "prompt" → 一次性打印输出（适合管道调用）──
  // Aligns with Claude Code's `claude -p`: supports --output-format
  // <text|json|stream-json> and --max-turns <n> for scripting/automation.
  const printIdx = args.indexOf('--print') !== -1 ? args.indexOf('--print') : args.indexOf('-p');
  if (printIdx !== -1) {
    const { parsePrintFlags, render, resolveExitCode } = require('../src/cli/printOutputFormat');
    // Tokens AFTER the -p/--print flag form the prompt (plus any output flags).
    const tail = args.slice(printIdx + 1);
    const { format, maxTurns, systemPrompt, appendSystemPrompt, allowedTools, disallowedTools, continueSession, resumeSessionId, outputSchema, includeTimeline, args: rest, error: flagError } = parsePrintFlags(tail);
    if (flagError) {
      printError(`参数错误: ${flagError}`);
      process.exit(1);
    }
    const prompt = rest.join(' ');
    if (!prompt) {
      printError('用法: khy --print "your question" [--output-format text|json|stream-json] [--max-turns N] [--system-prompt T] [--append-system-prompt T] [--allowedTools "Read,Write"] [--disallowedTools "Bash"]');
      process.exit(1);
    }
    // Direct AI query. --max-turns maps to the tool-loop iteration budget via the
    // existing env fallback consumed by toolUseLoop._resolveMaxIterations().
    process.env.KHYQUANT_AI_MODE = 'true';
    if (maxTurns) process.env.KHY_TOOL_LOOP_MAX_ITERATIONS = String(maxTurns);
    // Claude Code SDK alignment: --output-schema <json|@file> makes the model return
    // its final answer via the StructuredOutput tool, validated against this schema.
    // Resolve `@file` here (the only IO seam — the parser leaf stays pure) and export
    // KHY_OUTPUT_SCHEMA for StructuredOutputTool to pick up. Absent flag → no-op (byte
    // fallback to today's behaviour). Reject malformed schema early and honestly.
    if (outputSchema) {
      let raw = String(outputSchema);
      if (raw.startsWith('@')) {
        const schemaPath = raw.slice(1);
        try {
          raw = require('fs').readFileSync(require('path').resolve(schemaPath), 'utf8');
        } catch (e) {
          printError(`无法读取 --output-schema 文件 "${schemaPath}": ${e.message}`);
          process.exit(1);
        }
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') throw new Error('schema 必须是 JSON 对象');
        process.env.KHY_OUTPUT_SCHEMA = JSON.stringify(parsed);
      } catch (e) {
        printError(`--output-schema 不是合法的 JSON Schema: ${e.message}`);
        process.exit(1);
      }
    }
    // Claude Code SDK alignment: --allowedTools / --disallowedTools gate the tool
    // surface for this one-shot process at the shared getToolDefinitions() / execute
    // chokepoint, so every adapter path inherits the same allow/deny set.
    if (allowedTools || disallowedTools) {
      try {
        require('../src/services/toolAccessGateway').setToolAccessGateway({ allowed: allowedTools, disallowed: disallowedTools });
      } catch { /* best effort — gateway is additive safety */ }
    }
    if (_startupFsm) _startupFsm.fire('skip_to_running', { step: 'headless_print' }); // one-shot, skips repl
    const ai = require('../src/cli/ai');
    const { chat, getLiveSessionId } = ai;
    // Headless cross-session multi-turn (Claude Code parity for `-p --continue` /
    // `-p --resume <id>`): hydrate the prior transcript into the shared chat path
    // BEFORE running the new prompt. Both reuse the same session-load seams the
    // interactive `resume` flow uses, so future turns append to that transcript
    // rather than a fresh id. `--resume <id>` (explicit) wins over `--continue`.
    if (resumeSessionId || continueSession) {
      const restore = resumeSessionId
        ? ai.resumePersistedSession(resumeSessionId)
        : ai.resumeLastPersistedSession();
      if (!restore || !restore.success) {
        const reason = restore && restore.error ? restore.error : 'UNKNOWN';
        if (resumeSessionId) {
          printError(`无法恢复会话 "${resumeSessionId}"（${reason}）。请用 khy session 查看可恢复的会话 ID。`);
        } else {
          printError(`没有可继续的会话（${reason}）。请先发起一次对话，或改用 khy -p --resume <会话ID>。`);
        }
        process.exit(1);
      }
    }
    // Fix C(dogfood 实测):headless `-p` 走真·工具循环使工具真执行(Claude Code -p 对齐)。
    // 直接 `await chat()` 是**单次模型调用核心**,模型请求原生工具时只吐 `[模型请求执行工具: NAME]`
    // 占位串当回复、num_turns 恒 1、toolUseLoop 全部注入引导失效。门控 KHY_HEADLESS_NATIVE_LOOP
    // (default-on·CANON):开 → 经 runToolUseLoop(完全镜像 TUI useQueryBridge:1802 原生循环路径,
    // chatFn 关内层 NL 循环、外层 loop 主导工具执行);关/loop 不可用/异常 → fail-soft 逐字节回退单发。
    let result = null;
    let _useHeadlessLoop = false;
    // 墙钟计时:原生循环 loopResult 无 `elapsed` 字段 → render 的 duration_ms 会退成 0(可观测性
    // 回归)。测量整段解析耗时作 ctx.durationMs 兜底;单发路径 result.elapsed 有值仍优先(render
    // buildResultMessage:r.elapsed 有限则用之,否则用 ctx.durationMs)→ 门关路径逐字节不变。
    const _headlessT0 = Date.now();
    try {
      _useHeadlessLoop = require('../src/services/flagRegistry').isFlagEnabled('KHY_HEADLESS_NATIVE_LOOP', process.env);
    } catch { _useHeadlessLoop = false; }
    if (_useHeadlessLoop) {
      try {
        const toolUseLoop = require('../src/services/toolUseLoop');
        if (typeof toolUseLoop.runToolUseLoop === 'function' && toolUseLoop.isEnabled()) {
          // chatFn:每个模型轮次禁内层 NL 循环(disableNaturalToolLoop),因外层 runToolUseLoop
          // 主导工具执行——正是 AgentTool / TUI 驱动它的方式。
          const chatFn = (message, chatOpts = {}) => chat(message, {
            ...chatOpts,
            disableNaturalToolLoop: true,
            onChunk: null,
            systemPrompt,
            appendSystemPrompt,
          });
          // CC `-p` 对齐的人类友好进度反馈:执行中把工具调用/结果写 **stderr**(stdout 机器
          // 契约逐字节不动·pipe/重定向安全)。门控 KHY_HEADLESS_PROGRESS·auto 仅 stderr 是 TTY
          // 才发。fail-soft:进度反馈本身绝不让主流程崩。
          let _hpCallbacks = {};
          let _hpOnChunk = null;
          let _hbTimer = null;
          const _hbState = { active: null };
          try {
            const _hp = require('../src/cli/headlessProgress');
            if (_hp.shouldEmitProgress(process.env, !!(process.stderr && process.stderr.isTTY))) {
              const _hbOn = _hp.isHeartbeatEnabled(process.env);
              _hpCallbacks = {
                onToolCall: (name, params) => {
                  try { process.stderr.write(_hp.formatToolStart(name, params) + '\n'); } catch { /* best effort */ }
                  if (_hbOn) { try { _hbState.active = { name, t0: Date.now(), lastBeat: 0 }; } catch { /* best effort */ } }
                },
                onToolResult: (name, params, res, _iter, elapsed) => {
                  if (_hbOn) { _hbState.active = null; }
                  try { process.stderr.write(_hp.formatToolResult(name, res, elapsed, params) + '\n'); } catch { /* best effort */ }
                },
              };
              // 中间叙述文本(工具调用前的「说明」散文)+ 用户可见中间消息(assistant_message,
              // 如视觉路由说明「我无法识别图片,正在调用视觉模型」)。两者都经 chatOpts.onChunk 送达,
              // 写 stderr,不碰 stdout finalResponse。
              // - text:门控 KHY_HEADLESS_PROGRESS_TEXT(loop preamble 补发的散文)。
              // - assistant_message:backend 已由 KHY_VISION_INTERMEDIATE_MESSAGE 门控发射,
              //   消费端只要收到就渲染(不再叠加门控),用 💬 气泡区别于 │ 散文前缀。
              const _textOn = _hp.isTextEnabled(process.env);
              _hpOnChunk = (chunk) => {
                try {
                  if (!chunk || typeof chunk !== 'object') return;
                  if (chunk.type === 'text') {
                    if (!_textOn) return;
                    const block = _hp.formatAssistantText(chunk.text);
                    if (block) process.stderr.write(block + '\n');
                  } else if (chunk.type === 'assistant_message') {
                    const block = _hp.formatAssistantMessage(chunk.content);
                    if (block) process.stderr.write(block + '\n');
                  }
                } catch { /* best effort */ }
              };
              // 长时工具心跳(KHY_HEADLESS_PROGRESS_HEARTBEAT):unref 定时器,当有在飞工具且已运行
              // ≥HEARTBEAT_MIN_MS 时每 HEARTBEAT_INTERVAL_MS 往 stderr 补一行「运行中」。unref 不阻塞退出;
              // 工具结束(onToolResult)清 active 即停发;循环结束/异常各 clearInterval。
              if (_hbOn) {
                _hbTimer = setInterval(() => {
                  try {
                    const a = _hbState.active;
                    if (!a) return;
                    const now = Date.now();
                    const elapsed = now - a.t0;
                    if (elapsed >= _hp.HEARTBEAT_MIN_MS && (now - (a.lastBeat || a.t0)) >= _hp.HEARTBEAT_INTERVAL_MS) {
                      a.lastBeat = now;
                      const line = _hp.formatToolHeartbeat(a.name, elapsed);
                      if (line) process.stderr.write(line + '\n');
                    }
                  } catch { /* best effort */ }
                }, _hp.HEARTBEAT_INTERVAL_MS);
                if (_hbTimer && typeof _hbTimer.unref === 'function') _hbTimer.unref();
              }
            }
          } catch { _hpCallbacks = {}; _hpOnChunk = null; if (_hbTimer) { try { clearInterval(_hbTimer); } catch { /* noop */ } _hbTimer = null; } }
          let loopResult;
          try {
            loopResult = await toolUseLoop.runToolUseLoop(prompt, {
              chat: chatFn,
              chatOpts: {
                systemPrompt,
                appendSystemPrompt,
                ...(_hpOnChunk ? { onChunk: _hpOnChunk } : {}),
              },
              ..._hpCallbacks,
              ...(maxTurns ? { maxIterations: maxTurns } : {}),
            });
          } finally {
            if (_hbTimer) { try { clearInterval(_hbTimer); } catch { /* noop */ } _hbTimer = null; }
          }
          // loopResult.finalResponse → render 消费的 result.reply 契约(其余元数据透传)。
          result = {
            reply: loopResult && loopResult.finalResponse,
            provider: loopResult && loopResult.provider,
            adapter: loopResult && loopResult.adapter,
            model: loopResult && loopResult.model,
            tokenUsage: loopResult && loopResult.tokenUsage,
            toolCallLog: loopResult && loopResult.toolCallLog,
            errorType: loopResult && loopResult.errorType,
            stopReason: loopResult && loopResult.stopReason,
            elapsed: loopResult && loopResult.elapsed,
            // 循环达内部最大迭代数的权威信号——透传供 KHY_HEADLESS_EXIT_ON_LIMIT 如实反映退出码/json
            // 契约(buildResultMessage 只读白名单字段,故这两枚元数据不改 stdout json 契约)。
            maxIterationsReached: loopResult && loopResult.maxIterationsReached,
            stoppedByLimit: loopResult && loopResult.stoppedByLimit,
          };
        }
      } catch (_loopErr) {
        // 原生循环整段抛错 → 回退单发。今日静默吞掉致用户无从得知富循环被放弃;门开(默认)
        // 时先往 stderr 写一行诊断(stdout 契约不动),门关逐字节回退今日静默。
        try {
          const _hp2 = require('../src/cli/headlessProgress');
          if (_hp2.isLoopFallbackDiagEnabled(process.env)) {
            process.stderr.write(_hp2.formatLoopFallbackDiag(_loopErr) + '\n');
          }
        } catch { /* best effort */ }
        result = null; /* fall back to single-shot chat below */
      }
    }
    if (!result) {
      result = await chat(prompt, { onChunk: null, maxTurns, systemPrompt, appendSystemPrompt });
    }
    // 达迭代/步数上限时如实反映退出码与 json 契约(KHY_HEADLESS_EXIT_ON_LIMIT·opt-in 默认关)。
    // 开且 result 带 maxIterationsReached → 置 result.maxTurnsHit(使 buildResultMessage 报
    // error_max_turns/is_error:true)并让 resolveExitCode 给退出码 3(可重试·区别于硬错误 2)。
    // 关 → 不置位,退出码逐字节回退 `errorType?2:0`。
    let _exitOnLimit = false;
    try { _exitOnLimit = require('../src/services/flagRegistry').isFlagEnabled('KHY_HEADLESS_EXIT_ON_LIMIT', process.env); } catch { _exitOnLimit = false; }
    if (_exitOnLimit && result && result.maxIterationsReached === true) {
      result.maxTurnsHit = true;
    }
    let sessionId = '';
    try { sessionId = getLiveSessionId() || ''; } catch { /* best effort */ }
    const ctx = {
      sessionId,
      cwd: process.cwd(),
      model: (result && (result.model || result.adapter)) || '',
      prompt,
      maxTurns,
      durationMs: Date.now() - _headlessT0,
      // --include-timeline → result 对象附带 timeline 字段（无标志时字节不变）。
      includeTimeline,
    };
    const out = render(format, result || {}, ctx);
    if (out) process.stdout.write(out + '\n');
    process.exit(resolveExitCode(result, { limitExitEnabled: _exitOnLimit }));
  }

  // ── 分支4：khy / khyquant --ai "prompt" → 一次性 AI 查询（带格式化输出）─
  const aiIdx = args.indexOf('--ai');
  if (aiIdx !== -1) {
    const prompt = args.slice(aiIdx + 1).join(' ');
    if (!prompt) {
      printError('用法: khy --ai "your question"');
      process.exit(1);
    }
    process.env.KHYQUANT_AI_MODE = 'true';
    if (_startupFsm) _startupFsm.fire('skip_to_running', { step: 'ai_flag_oneshot' }); // one-shot, skips repl
    const { chat } = require('../src/cli/ai');
    const result = await chat(prompt, { onChunk: null });
    if (result && result.reply) {
      process.stdout.write(result.reply + '\n');
    }
    process.exit(result && result.errorType ? 2 : 0);
  }

  if (args.length === 0) {
    // ── 分支5A：khy（无参数）→ khy OS REPL（零顶层启动，不拉起默认应用）──
    if (invokedAs === 'khy') {
      if (_startupFsm) _startupFsm.fire('advance', { step: 'khy_repl_init' }); // -> repl_init
      if (!isInteractiveTerminal()) {
        printError('当前环境不支持交互终端。请使用 khy <命令> 或 khy ai -p "your question"。');
        process.exit(1);
      }
      // 强制认证后再进入 REPL
      const authOk = await ensureAuthenticated();
      if (!authOk) { printError('认证失败，无法使用终端。'); process.exit(1); }
      // khy 主入口仅做轻量平台初始化，避免触发上层默认应用启动链路
      try {
        const { setup } = require('../src/bootstrap/setup');
        await setup({ mode: 'khy', silent: true });
      } catch { /* non-critical */ }
      checkpoint('khy:setup-done');
      if (_bootPhaseWrite) _bootPhaseWrite('✓ 就绪');
      // 交棒给 TUI 前收掉瞬时进度行:横幅从干净的一行起笔,后到的版本通知也不再撞行。
      if (_bootPhaseLine) _bootPhaseLine.end();
      _scheduleStartupUpdateCheck(printInfo, printError);
      const { startRepl } = require('../src/cli/repl');
      if (_startupFsm) _startupFsm.fire('advance', { step: 'khy_repl_enter' }); // -> running
      await startRepl({ mode: 'khy', enablePluginAutoload: false });
      return;
    }

    // ── 分支5B：khyquant（无参数，完整模式）：认证 → 启动服务器 → REPL ──
    if (_startupFsm) _startupFsm.fire('advance', { step: 'khyquant_full_repl_init' }); // -> repl_init
    if (!isInteractiveTerminal()) {
      printError('当前环境不支持交互登录。请使用 --print/-p 进行非交互调用。');
      process.exit(1);
    }
    const authenticated = await ensureAuthenticated();
    if (!authenticated) {
      printError('认证失败，无法使用终端。如需重置请删除 ~/.khyquant/credentials.json');
      process.exit(1);
    }

    // ── 启动自检：SQLite 驱动子进程探针（防 better-sqlite3 段错误静默死亡）──
    // 仅本无参交互完整启动分支接入（--help 等其他分支零影响）；探针预算约 1.2s，
    // 超时/探针自身异常一律放行（checked=false），绝不阻断正常启动。
    try {
      const { runStartupSqliteProbe } = require('../src/bootstrap/startupSqliteProbe');
      const probe = runStartupSqliteProbe();
      if (probe && probe.checked && !probe.ok) {
        printError('启动自检失败：SQLite 驱动不可用（为避免原生模块段错误导致静默退出，已中止启动）。');
        printError(`原因：${probe.detail || '未知'}`);
        printError('修复指引：1) 使用 Node.js >= 23.4（内置 node:sqlite，无需编译）；2) 在项目根用与运行时相同的 Node 版本执行 npm rebuild better-sqlite3；3) 便携版可运行 khy repair 或 node scripts/portable-health-check.js 查看详情。');
        process.exit(1);
      }
      checkpoint('khyquant:sqlite-probe-done');
    } catch { /* 探针容错：自身异常不得阻断启动 */ }

    // 完整模式的会话级初始化（数据库预检查 + 数据迁移）
    try {
      const { setup } = require('../src/bootstrap/setup');
      await setup({ mode: 'khyquant' });
    } catch { /* 引导初始化是非关键操作 */ }
    checkpoint('khyquant:setup-done');
    _scheduleStartupUpdateCheck(printInfo, printError);

    // 默认流程：启动后端服务器 + 前端，然后进入 REPL
    if (_startupFsm) _startupFsm.fire('advance', { step: 'full_server_repl_enter' }); // -> running
    await startWithServer();
  } else if (args.includes('--no-server') || args.includes('--cli')) {
    // ── 分支6：khyquant --no-server / --cli → 纯 CLI 模式（不启动服务器）
    const filteredArgs = args.filter(a => a !== '--no-server' && a !== '--cli');
    if (filteredArgs.length === 0) {
      if (_startupFsm) _startupFsm.fire('advance', { step: 'cli_repl_init' }); // -> repl_init
      if (!isInteractiveTerminal()) {
        printError('当前环境不支持交互登录。请使用 --print/-p 进行非交互调用。');
        process.exit(1);
      }
      const authenticated = await ensureAuthenticated();
      if (!authenticated) {
        printError('认证失败，无法使用终端。如需重置请删除 ~/.khyquant/credentials.json');
        process.exit(1);
      }
      try {
        const { setup } = require('../src/bootstrap/setup');
        await setup({ mode: 'khyquant' });
      } catch { /* bootstrap setup is non-critical */ }
      checkpoint('khyquant:setup-done');
      _scheduleStartupUpdateCheck(printInfo, printError);
      const { startRepl } = require('../src/cli/repl');
      if (_startupFsm) _startupFsm.fire('advance', { step: 'cli_repl_enter' }); // -> running
      await startRepl();
    } else {
      // --no-server/--cli 后面还有其他参数 → 当作单条命令执行（无需认证）
      if (_startupFsm) _startupFsm.fire('skip_to_running', { step: 'cli_command' }); // one-shot, skips repl
      const { parseInput, route } = require('../src/cli/router');
      const parsed = parseInput(filteredArgs);
      if (!parsed) {
        printError('无效命令');
        process.exit(1);
      }
      try {
        const result = await route(parsed);
        await handleRouterResultForNonInteractive(result, parsed, printError, printHelp);
        process.exit(process.exitCode || 0);
      } catch (err) {
        printError(err.message);
        process.exit(1);
      }
    }
  } else {
    // ── 分支7：khyquant + 命令参数 → 单命令模式（执行后退出，无需认证）
    const { parseInput, route } = require('../src/cli/router');
    const parsed = parseInput(args);

    if (!parsed) {
      printError('无效命令');
      process.exit(1);
    }

    // ── khy resume [<会话ID>]（交互式）→ 恢复上下文后进入对话窗口 ──
    // resume 的语义是「带着历史继续对话」，必须落进 REPL/TUI 才有意义。旧行为把它
    // 当一次性命令：恢复 _messages 后立即 process.exit → 回到 shell，恢复的上下文随
    // 进程销毁而丢失，用户看到「已恢复」却没有任何对话窗口。这里改为：先恢复（复用
    // router 的 _handleResumeFlow 打印横幅 + 写入 ai._messages），再进入交互窗口，
    // 并通过 resumed 标志让 startRepl 跳过会清空历史的 clearHistory、让 TUI 回放可见
    // 对话。`resume` 经 aliases.js 归一为 history/resume。非交互终端无法进入窗口，
    // 保持旧的一次性恢复语义（下方 route() 分支）。
    if (parsed.command === 'history' && parsed.subCommand === 'resume' && isInteractiveTerminal()) {
      if (_startupFsm) _startupFsm.fire('advance', { step: 'resume_repl_init' }); // -> repl_init
      const authOk = await ensureAuthenticated();
      if (!authOk) { printError('认证失败，无法使用终端。'); process.exit(1); }
      try {
        const { setup } = require('../src/bootstrap/setup');
        await setup({ mode: 'khy', silent: true });
      } catch { /* non-critical */ }
      checkpoint('khy:resume-setup-done');
      // 先恢复上下文：router 打印「已恢复完整会话…」横幅并把历史写入 ai._messages。
      // 极少数分支（断点构建续跑）回传 { aiForward }，进窗后自动提交原始目标。
      let _resumeForward = null;
      try {
        const result = await route(parsed);
        if (result && typeof result === 'object' && result.aiForward) {
          _resumeForward = result.aiForward;
        }
      } catch (err) {
        printError(`恢复失败：${err && err.message ? err.message : err}`);
      }
      const { startRepl } = require('../src/cli/repl');
      if (_startupFsm) _startupFsm.fire('advance', { step: 'resume_repl_enter' }); // -> running
      await startRepl({
        mode: 'khy',
        enablePluginAutoload: false,
        resumed: true,
        resumeForward: _resumeForward,
      });
      return;
    }

    // ── khy os / khy khyos（无子命令，交互式）→ 直接进入裸机内核终端 ──
    // 一次性 khy os run/provision/doctor 仍走下方 route() 的 case 'os'。
    if ((parsed.command === 'os' || parsed.command === 'khyos') &&
        (!parsed.args || parsed.args.length === 0)) {
      if (!isInteractiveTerminal()) {
        printError('当前环境不支持交互终端。请使用 khy os run "<命令>" 或 khy os doctor。');
        process.exit(1);
      }
      const authOk = await ensureAuthenticated();
      if (!authOk) { printError('认证失败，无法使用终端。'); process.exit(1); }
      try {
        const { setup } = require('../src/bootstrap/setup');
        await setup({ mode: 'khy', silent: true });
      } catch { /* non-critical */ }
      checkpoint('khyos:setup-done');
      const { startRepl } = require('../src/cli/repl');
      if (_startupFsm) _startupFsm.fire('advance', { step: 'khyos_repl_init' }); // -> repl_init
      if (_startupFsm) _startupFsm.fire('advance', { step: 'khyos_repl_enter' }); // -> running
      await startRepl({ mode: 'khy', enablePluginAutoload: false, khyosDirect: true });
      return;
    }

    // ── khy mcp serve → khy 作为 MCP server 常驻(stdio/HTTP),暴露自己的原生工具 ──
    // 关键:server 是常驻循环(stdio readline / http.Server 持有事件循环),绝不能走下方
    // route() + process.exit(0)——那会在 stdin 尚开、异步回包尚未 flush 时杀死进程。改为
    // 直接启动 server 后 return,让事件循环随传输存活,直到客户端关 stdin / 进程被杀。
    // stdio 分支进入循环后 stdout 专供 JSON-RPC(诊断全走 stderr),故这里不再打印任何收尾。
    if (parsed.command === 'mcp' && parsed.subCommand === 'serve') {
      if (_startupFsm) _startupFsm.fire('skip_to_running', { step: 'mcp_serve' }); // resident server, skips repl
      try {
        const { handleMcp } = require('../src/cli/handlers/mcp');
        const code = await handleMcp('serve', parsed.args || [], parsed.options || {});
        // 门控关 / HTTP 拒启动 → handleMcp 返回非 0,此时无常驻循环,正常退出。
        if (code && code !== 0) process.exit(Number(code));
      } catch (err) {
        process.stderr.write(`khy mcp serve 启动失败:${err && err.message ? err.message : err}\n`);
        process.exit(1);
      }
      return;
    }

    if (_startupFsm) _startupFsm.fire('skip_to_running', { step: 'single_command' }); // one-shot, skips repl
    try {
      const result = await route(parsed);
      await handleRouterResultForNonInteractive(result, parsed, printError, printHelp);
      process.exit(process.exitCode || 0);
    } catch (err) {
      // Keep err.code in view: a bare err.message turns ENOENT/EACCES/etc. into
      // an unactionable one-liner upstream. When KHY_DEBUG is set, include the
      // stack so the failing frame is recoverable.
      const codeSuffix = err?.code ? ` (${err.code})` : '';
      printError(`${err?.message || err}${codeSuffix}`);
      if (process.env.KHY_DEBUG && err?.stack) {
        try { require('fs').writeSync(2, `${err.stack}\n`); } catch { /* best effort */ }
      }
      process.exit(typeof err?.exitCode === 'number' ? err.exitCode : 1);
    }
  }
}

// ── 启动入口：执行主函数 ──────────────────────────────────────────────
main().catch(err => {
  console.error(err);    // 未被捕获的致命错误，打印并退出
  process.exit(1);
}).finally(() => {
  // Shadow FSM shutdown marker (fail-soft, observability only).
  if (_startupFsm) _startupFsm.fire('shutdown', { step: 'main_settled' });
  // REPL 退出后（或命令执行完毕后），打印启动性能分析报告（如果开启了性能分析）
  try {
    const { printSummary } = require('../src/bootstrap/startupProfiler');
    printSummary();
  } catch { /* 性能分析器不可用时静默忽略 */ }
});
