'use strict';

/**
 * dependency/installRunner.js — 隔离执行依赖安装命令。
 *
 * 安全红线：
 *   - 只执行调用方传入的 **argv 数组**（来源唯一是 registry.buildInstallPlan）；
 *     用 execFile（不经 shell）→ 杜绝注入。
 *   - 绝不自动 sudo：requiresElevation 的命令照常尝试，失败按权限不足如实回报，
 *     由人决定是否手动提权（不替用户提权）。
 *   - 带超时；捕获 stdout/stderr 尾部供回溯，绝不静默吞错。
 *
 * runner 可注入（默认真实 execFile），测试用纯内存桩，零真实进程。
 */

const DEFAULT_TIMEOUT_MS = parseInt(process.env.KHY_DEP_INSTALL_TIMEOUT_MS || '180000', 10);

/**
 * 包管理器缺失时的人类可读归因（指向官方安装页，绝不静默）。
 * key 为 registry install.manager；npm/npx 缺失 ⇒ 未装 Node.js。
 */
const MANAGER_DOCS = {
  npm: { runtime: 'Node.js (npm)', url: 'https://nodejs.org/' },
  npx: { runtime: 'Node.js (npx)', url: 'https://nodejs.org/' },
  yarn: { runtime: 'Yarn', url: 'https://yarnpkg.com/getting-started/install' },
  pnpm: { runtime: 'pnpm', url: 'https://pnpm.io/installation' },
  pip: { runtime: 'Python (pip)', url: 'https://www.python.org/downloads/' },
  os: { runtime: '系统包管理器', url: null },
  rustup: { runtime: 'rustup', url: 'https://rustup.rs/' },
};

/** 由 argv 首词推断包管理器键（用于缺失归因）。 */
function _managerOf(argv) {
  const bin = String((argv && argv[0]) || '').toLowerCase().replace(/\.(cmd|bat|exe)$/, '');
  return bin;
}

/**
 * 构造「包管理器未安装」的人类可读归因消息。
 * @param {string} manager  argv 首词（npm/npx/pip/...）
 * @returns {string}
 */
function managerMissingMessage(manager) {
  const info = MANAGER_DOCS[manager];
  if (info && info.url) {
    return `未检测到 ${info.runtime}：命令 \`${manager}\` 不在 PATH 上。请先安装：${info.url}`;
  }
  return `未检测到命令 \`${manager}\`：请先安装对应运行时/包管理器后重试。`;
}

function _tail(s, n = 2000) {
  s = String(s || '');
  return s.length > n ? s.slice(-n) : s;
}

/**
 * 把 execFile 的失败归类为稳定错误码。
 *   - ENOENT（POSIX 找不到可执行）             → manager-not-found
 *   - win32 shell 下「不是内部或外部命令 / not recognized」→ manager-not-found
 *   - 被信号杀死（超时）                         → timeout
 *   - 其余非零退出                               → exit-nonzero
 * @param {Error} err
 * @param {string} stderr
 * @param {string} manager  argv 首词
 * @returns {string}
 */
function _classifyExecError(err, stderr, manager) {
  if (err && err.code === 'ENOENT') return 'manager-not-found';
  if (err && err.killed) return 'timeout';
  const txt = String(stderr || (err && err.message) || '');
  // win32 cmd.exe: "'npm' 不是内部或外部命令" / "is not recognized as ...";
  // 部分本地化/POSIX shell: "command not found"。仅当提及该 manager 时判定缺失。
  const mentionsManager = manager && new RegExp(`\\b${manager.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(txt);
  if (mentionsManager && /(not recognized|不是内部或外部命令|command not found|未找到命令|No such file)/i.test(txt)) {
    return 'manager-not-found';
  }
  return 'exit-nonzero';
}

/**
 * 解析「该用什么可执行文件 + 哪些参数」来跑一条 argv（纯函数，便于单测）。
 *
 * win32：npm/npx/yarn 等是 .cmd 垫片，execFile 不经 shell 无法解析 → ENOENT 陷阱。
 * 故经 cmd.exe 显式调用（/d /s /c）解析 .cmd/.bat/.exe。**绝不传 shell:true**——
 * args 数组 + shell:true 会触发 Node DEP0190 弃用告警泄漏到终端；改为把 cmd.exe
 * 当作可执行文件、原 argv 作为它的参数，等价但无告警。argv 全来自 curated
 * registry，无注入面。POSIX 仍走纯 execFile（最安全，不引入 shell）。
 *
 * @param {string[]} argv
 * @param {string} platform  process.platform
 * @returns {{ exe:string, args:string[] }}  注意：**不含** shell 选项。
 */
function _buildExecInvocation(argv, platform) {
  const [bin, ...rest] = argv;
  const isWin = platform === 'win32';
  return {
    exe: isWin ? (process.env.COMSPEC || 'cmd.exe') : bin,
    args: isWin ? ['/d', '/s', '/c', bin, ...rest] : rest,
  };
}

/** 默认真实执行器：execFile 单条 argv。 */
function _realRunner(argv, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let execFile;
    try {
      ({ execFile } = require('child_process'));
    } catch {
      resolve({ ok: false, code: null, stdout: '', stderr: 'child_process unavailable', error: 'no-exec' });
      return;
    }
    const manager = _managerOf(argv);
    const { exe, args: exeArgs } = _buildExecInvocation(argv, process.platform);
    const opts = { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
    execFile(exe, exeArgs, opts, (err, stdout, stderr) => {
      if (err) {
        const code = _classifyExecError(err, stderr, manager);
        const out = {
          ok: false,
          code: typeof err.code === 'number' ? err.code : null,
          stdout: _tail(stdout),
          stderr: _tail(stderr || err.message),
          error: code,
        };
        // 缺失包管理器：附上明确归因（指向官方安装页），绝不静默失败。
        if (code === 'manager-not-found') out.hint = managerMissingMessage(manager);
        resolve(out);
      } else {
        resolve({ ok: true, code: 0, stdout: _tail(stdout), stderr: _tail(stderr) });
      }
    });
  });
}

/**
 * 执行一个安装计划（主命令 + 可选 followUp）。永不抛错。
 * @param {object} plan  buildInstallPlan 的返回
 * @param {object} [opts] { cwd, timeoutMs, runner }
 * @returns {Promise<{ ok:boolean, steps:Array, command:string }>}
 */
async function runInstall(plan, opts = {}) {
  if (!plan || !Array.isArray(plan.command) || plan.command.length === 0) {
    return { ok: false, steps: [], command: '', error: 'no-plan' };
  }
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const runner = typeof opts.runner === 'function' ? opts.runner : _realRunner;

  const steps = [];
  const sequence = [plan.command];
  if (Array.isArray(plan.followUp) && plan.followUp.length) sequence.push(plan.followUp);

  for (const argv of sequence) {
    let res;
    try {
      res = await runner(argv, { cwd, timeoutMs });
    } catch (e) {
      res = { ok: false, code: null, stdout: '', stderr: String(e && e.message || e), error: 'runner-threw' };
    }
    steps.push({ command: argv.join(' '), ...res });
    if (!res.ok) {
      const out = { ok: false, steps, command: argv.join(' '), error: res.error || 'exit-nonzero' };
      // 透传缺失包管理器的明确归因，供上层（healingLoop / 工具结果）原样回报用户。
      if (res.hint) out.hint = res.hint;
      return out;
    }
  }
  return { ok: true, steps, command: plan.command.join(' ') };
}

module.exports = {
  runInstall,
  DEFAULT_TIMEOUT_MS,
  managerMissingMessage,
  MANAGER_DOCS,
  _internal: { _realRunner, _tail, _classifyExecError, _managerOf, _buildExecInvocation },
};
