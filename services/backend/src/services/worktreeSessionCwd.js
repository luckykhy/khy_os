'use strict';

/**
 * worktreeSessionCwd — 让**模型驱动**的 worktree 进/出真正改变工具的工作目录。
 *
 * 背景(用户报告「khy 不会真正使用工作树」):EnterWorktreeTool/ExitWorktreeTool 切换
 * worktree 时**只调 `process.chdir`**,而 khy 的文件工具、文件锁(_fileLock.resolveTargetPath)、
 * 红/绿写入 diff(_captureWriteFileDiffContext)、自动检查点全都以
 * **`process.env.KHYQUANT_CWD`** 为准(见 cli/repl/worktreeCommand.js:11-17 的说明)。于是模型
 * 调 EnterWorktree 后 `process.cwd()` 变了、但 `KHYQUANT_CWD` 没变 → 文件/git 工具仍锚在旧根,
 * worktree 隔离形同虚设。`/worktree` 斜杠命令早已用 switchCwd 同步两处,唯独两个**模型可调工具**
 * 漏了——本模块把那份「双 cwd 同步」抽成可复用、可注入、可测的单元,给两个工具补上。
 *
 * 契约:确定性、绝不抛。核心 `switchToolCwd` 的副作用(写 env、chdir)全部经注入依赖发生,
 * 故纯测无需碰真实 process。门控 KHY_WORKTREE_TOOL_CWD(默认开,仅 0/false/off/no 关):
 * 关 → 只 chdir(逐字节回退到今日行为),KHYQUANT_CWD 不动。
 *
 * @module services/worktreeSessionCwd
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控。优先 flagRegistry(集中优先级),不可用时回退本地 CANON 词表。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function worktreeToolCwdEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_WORKTREE_TOOL_CWD', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_WORKTREE_TOOL_CWD;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 把会话的工作目录切到 target,同步**两个** cwd 源(KHYQUANT_CWD + process.chdir),
 * 让文件/git 工具、锁、diff、检查点与提示一致。
 *
 * @param {string} target  目标绝对路径
 * @param {object} [opts]
 * @param {object} [opts.env]     环境对象(默认 process.env;测试注入)
 * @param {(dir:string)=>void} [opts.chdir]  目录切换(默认 process.chdir;测试注入)
 * @returns {{ switched: boolean, cwd: string|null, chdirOk: boolean, syncedEnv: boolean }}
 */
function switchToolCwd(target, opts = {}) {
  const env = (opts && opts.env) || process.env;
  const chdir = (opts && typeof opts.chdir === 'function') ? opts.chdir : ((d) => process.chdir(d));
  const dir = typeof target === 'string' ? target : '';
  if (!dir) return { switched: false, cwd: null, chdirOk: false, syncedEnv: false };

  const gateOn = worktreeToolCwdEnabled(env);
  let syncedEnv = false;
  if (gateOn) {
    // KHYQUANT_CWD 是文件/git 工具的权威 cwd 源 —— 必须同步,否则 worktree 切换对工具无效。
    try { env.KHYQUANT_CWD = dir; syncedEnv = true; } catch { syncedEnv = false; }
  }
  // chdir 两个分支都做(旧行为即只 chdir);best-effort,失败不抛。
  let chdirOk = false;
  try { chdir(dir); chdirOk = true; } catch { chdirOk = false; }

  return { switched: true, cwd: dir, chdirOk, syncedEnv };
}

module.exports = {
  worktreeToolCwdEnabled,
  switchToolCwd,
};
