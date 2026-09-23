'use strict';

/**
 * launcher.js — 把端矩阵里的一条计划真正跑起来。
 *
 * 只有三种模式，语义写在 entrypoints.json 的 `modes` 里：
 *   - attach：前台接管当前终端（REPL、flutter run）；
 *   - wait：前台等它退出（构建、打包）；
 *   - detach：后台独立运行、立即返回（dev server、窗口应用）。
 *
 * **没有任何超时**。长生命周期端不做固定时长 kill —— 工程规则 3 / RUNTIME-003
 * 的红线是「不因墙钟到期而杀死仍在推进的任务」，而 detach 模式压根不等它，
 * 从设计上就消除了这类超时。要停就用 `khy cross stop` 那套既有的停止路径。
 *
 * @module services/entrypoints/launcher
 */

const { spawn } = require('child_process');

const { resolvePlan } = require('./registry');

// Windows 上 npm / npx / yarn / pnpm 不是可执行文件，而是 .cmd 批处理壳。
// Node 从 18.20 / 20.12 起，`spawn('npm', …)`（不带 shell）在 Windows 上会 ENOENT，
// 连 `spawn('npm.cmd')` 也会被 CVE-2024-27980 的修复判为 EINVAL —— **必须走 shell**。
// 这几条命令的参数来自仓库自己的 entries.json（受版本控制、非用户输入），
// 用户唯一能注入的是 extraArgs，那部分在 buildSpawnOptions 里单独把关。
const WINDOWS_SHELL_COMMANDS = new Set(['npm', 'npx', 'yarn', 'pnpm']);

// 会改变命令结构的 shell 元字符。extraArgs 来自用户，走 shell 前必须挡住它们，
// 否则 `khy entry launch desktop "x & rm -rf y"` 就不再是"给端传个参数"了。
const SHELL_METACHARACTERS = /[&|<>^`$"\n\r;]/;

/**
 * 挡住会跨越命令边界的用户参数。
 * @param {string[]} args
 * @returns {string|null} 违规参数的说明，全部合规时返回 null
 */
function findUnsafeArg(args) {
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (SHELL_METACHARACTERS.test(arg)) {
      return (
        `参数 ${JSON.stringify(arg)} 含 shell 元字符：` +
        '本端在 Windows 上必须经 shell 启动，无法安全转义 —— ' +
        '请去掉参数里的 & | < > ^ ` $ " ; 后重试'
      );
    }
  }
  return null;
}

/**
 * 组装 spawn 选项。
 * @param {object} plan
 * @returns {{ options: object, error: string|null }}
 */
function buildSpawnOptions(plan) {
  const needsShell = Boolean(plan.shell) ||
    (process.platform === 'win32' && WINDOWS_SHELL_COMMANDS.has(plan.command));

  if (needsShell) {
    const unsafe = findUnsafeArg(plan.args);
    if (unsafe) return { options: null, error: unsafe };
  }

  return {
    options: {
      cwd: plan.cwd || undefined,
      shell: needsShell,
      stdio: plan.mode === 'detach' ? 'ignore' : 'inherit',
      detached: plan.mode === 'detach',
      windowsHide: false,
    },
    error: null,
  };
}

/**
 * 执行一条已解析的计划。
 *
 * @param {object} plan — registry.resolvePlan 的输出
 * @param {{ dryRun?: boolean, onEvent?: (event: object) => void }} [options]
 * @returns {Promise<{ ok: boolean, mode: string, pid?: number, exitCode?: number,
 *                     signal?: string|null, error?: string, plan?: object }>}
 */
function runPlan(plan, options = {}) {
  if (!plan) {
    return Promise.resolve({
      ok: false,
      mode: 'none',
      error: '没有可执行的计划：本端在当前平台没有声明启动/构建方式',
    });
  }

  if (options.dryRun) {
    return Promise.resolve({ ok: true, mode: plan.mode, plan, dryRun: true });
  }

  const built = buildSpawnOptions(plan);
  if (built.error) {
    return Promise.resolve({ ok: false, mode: plan.mode, error: built.error, plan });
  }

  const describeFailure = err =>
    `启动失败（${plan.command}）：${err.message} —— ` +
    `请确认该命令在 PATH 中可用、cwd 存在，或先跑 dry-run 核对计划（cwd=${plan.cwd || '继承当前目录'}）`;

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(plan.command, plan.args, built.options);
    } catch (err) {
      resolve({ ok: false, mode: plan.mode, error: describeFailure(err), plan });
      return;
    }

    if (plan.mode === 'detach') {
      // 不等待、不设超时：端自己活多久由端决定（工程规则 3 / RUNTIME-003）。
      //
      // 但「不等它退出」不等于「不等它启动」。必须等到 'spawn' 事件才算真的起来了：
      // spawn 是异步的，`spawn()` 返回后立刻读 `child.pid` 在失败时是 `undefined`。
      // 曾实测到 Windows 上 `spawn('npm', …)` 因 ENOENT 失败，而这里当场 resolve，
      // 于是上层打印出「已转入后台运行（PID undefined）」——**假成功**，
      // 恰好是工程规则 3 结尾禁止的「绝不假装任务成功」。
      let settled = false;
      const settle = result => {
        if (settled) return;
        settled = true;
        if (result.ok) child.unref();
        resolve(result);
      };
      child.once('spawn', () =>
        settle({ ok: true, mode: plan.mode, pid: child.pid, plan })
      );
      child.once('error', err =>
        settle({ ok: false, mode: plan.mode, error: describeFailure(err), plan })
      );
      return;
    }

    if (typeof options.onEvent === 'function') {
      options.onEvent({ type: 'started', id: plan.id, field: plan.field, pid: child.pid });
    }

    child.on('error', err => {
      resolve({ ok: false, mode: plan.mode, error: describeFailure(err), plan });
    });

    child.on('exit', (code, signal) => {
      resolve({ ok: code === 0, mode: plan.mode, exitCode: code, signal, plan });
    });
  });
}

/**
 * 按端条目 + 字段（launch / build）解析并执行。
 *
 * @param {object} entry — entrypoints.json 的原始条目
 * @param {'launch'|'build'} field
 * @param {{ appRoot?: string, platform?: string, extraArgs?: string[],
 *           dryRun?: boolean, onEvent?: (event: object) => void }} [options]
 * @returns {Promise<object>} runPlan 的结果（无计划时 ok:false + error）
 */
async function runEntry(entry, field, options = {}) {
  const plan = resolvePlan(entry, field, options);
  if (!plan) {
    const platform = options.platform || process.platform;
    const reason =
      entry && entry[field]
        ? `端 ${entry.id} 未声明 ${platform} 平台的${field === 'launch' ? '启动' : '构建'}档`
        : `端 ${entry && entry.id} 未声明${field === 'launch' ? '启动' : '构建'}方式`;
    return { ok: false, mode: 'none', error: `${reason} —— 见 entrypoints.json 的 ${field} 字段` };
  }
  return runPlan(plan, options);
}

/**
 * 把计划渲染成一行可复制的命令，用于 dry-run 与 `khy entry info`。
 * @param {object|null} plan
 * @returns {string}
 */
function formatPlan(plan) {
  if (!plan) return '（无声明）';
  const parts = [plan.command, ...plan.args].map(a =>
    /\s/.test(a) ? `"${a}"` : a
  );
  return parts.join(' ');
}

module.exports = {
  WINDOWS_SHELL_COMMANDS,
  SHELL_METACHARACTERS,
  findUnsafeArg,
  buildSpawnOptions,
  runPlan,
  runEntry,
  formatPlan,
};
