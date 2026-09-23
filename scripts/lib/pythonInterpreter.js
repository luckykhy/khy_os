'use strict';

/**
 * pythonInterpreter.js — 纯叶子：为 `.py` 检查器解析一个可用的 Python 解释器。
 *
 * ## 为什么需要它
 *
 * `scripts/ruleguard/lib/wiring.js` 的 `CHECKER_SUFFIXES` 收 `.py`，
 * `scripts/ci/` 下也确有 `.py` 检查器（`check-python-syntax.py`、
 * `export-pyproject-dependencies.py`）—— 也就是说「Python 检查器」是这套体系
 * **明文支持的一类执行器**。但 `run.js` 原来一律用 `process.execPath` 拉起执行器，
 * 于是 `.py` 执行器被 node 当 JS 解析，必然失败：规则声明了执行器、门里也跑了，
 * 却永远得到一条 `checker-failure`（实测 `LAYOUT-004` → `organize.py`）。
 *
 * ## 设计约束（与 scripts/lib 下其余叶子一致）
 *
 * 零外部依赖、确定性、绝不抛、只读。
 * 唯一的外部动作是**探测解释器**，且探测函数可注入（`spawn`），
 * 于是判定逻辑本身可以在测试里完全离线验证。
 *
 * 刻意**不**复用 `scripts/ci/run-python.js`：那是给命令行用的（`process.argv` +
 * `stdio: 'inherit'` + 字符串拼接），不是模块；也不 `require`
 * `services/backend/src/tools/platformUtils` —— 那是一条跨 workspace 的深层相对
 * require，会被 `check-repo-layout.js` 的 `cross-layer-require` 计入基线。
 */

const { spawnSync } = require('child_process');

/** 候选解释器按平台排序：Windows 上 `python3` 常不存在，`py` 是官方启动器。 */
function pythonCandidates(platform = process.platform) {
  return platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];
}

/**
 * 探测单个候选是否可用。
 *
 * 必须看**退出码**而不只是「命令是否存在于 PATH」：Windows 上未安装 Python 时
 * `python` 常被 Microsoft Store 的占位程序接管，它存在、能启动，但退出码非 0。
 */
function probeCommand(command, spawn = spawnSync) {
  try {
    const result = spawn(command, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    return !result.error && result.status === 0;
  } catch (error) {
    return false;
  }
}

/** 依次探测候选，返回第一个可用的命令名；全不可用返回 null。 */
function resolvePythonCommand(options = {}) {
  const spawn = options.spawn || spawnSync;
  const platform = options.platform || process.platform;
  for (const candidate of pythonCandidates(platform)) {
    if (probeCommand(candidate, spawn)) return candidate;
  }
  return null;
}

let cached = null;

/** 记忆化包装：一次 run 内不重复探测。`options.fresh` 可绕过缓存（测试用）。 */
function pythonCommand(options = {}) {
  if (options.fresh || !cached) {
    cached = { command: resolvePythonCommand(options) };
  }
  return cached.command;
}

/** 测试用：清掉记忆化。 */
function resetCache() {
  cached = null;
}

/**
 * 给定执行器路径，返回怎么拉起它。
 *
 * @returns {{ command: string|null, reason: string }}
 *   `command` 为 null 时 `reason` 说明原因（调用方负责把它变成一条可读的失败）。
 */
function interpreterFor(scriptRel, options = {}) {
  const script = String(scriptRel || '').replace(/\\/g, '/');

  if (!/\.py$/i.test(script)) {
    return { command: process.execPath, reason: '' };
  }

  const command = pythonCommand(options);
  if (!command) {
    return {
      command: null,
      reason:
        `找不到可用的 Python 解释器（已试 ${pythonCandidates(options.platform).join(' / ')}）。`
        + `.py 执行器 ${script} 无法运行 —— 装 Python 3 并确保在 PATH 上。`,
    };
  }

  return { command, reason: '' };
}

/** 把一条执行器路径渲染成「人类可复现」的命令行前缀。 */
function runnerLabel(scriptRel) {
  const script = String(scriptRel || '').replace(/\\/g, '/');
  if (/\.py$/i.test(script)) return `${pythonCommand() || 'python'} ${script}`;
  return `node ${script}`;
}

module.exports = {
  pythonCandidates,
  probeCommand,
  resolvePythonCommand,
  pythonCommand,
  interpreterFor,
  runnerLabel,
  resetCache,
};
