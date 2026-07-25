'use strict';

/**
 * todoStateStorePaths.js — 纯叶子:兼容 `todoWrite` 的 `todo_state.json` 候选路径 SSOT。
 *
 * 病根(任务系统分裂·第 4 步):兼容 todoWrite 的**写侧**(services/toolCalling.js)与
 *   看板**读侧**(routes/largeTasks.js)各自内联候选目录清单,且两侧临时目录解析**分叉**——
 *     · 写侧 temp = `platformUtils.getTmpDir()`(TEMP || TMP || os.tmpdir())
 *     · 读侧 temp = `os.tmpdir()`
 *   在 Windows 上 TEMP/TMP 常 ≠ os.tmpdir() → 写进 `%TEMP%\khyquant\todo_state.json` 的清单
 *   读侧到 `os.tmpdir()\khyquant` 找不到 → 看板读不回兼容 todos。本叶子把两侧候选**收敛到
 *   同一份有序清单**,由调用壳注入统一的 tmpdir(getTmpDir),两侧从此不再漂移。
 *
 * 契约(CONTRACT):零 IO(仅 `require('path')`)、确定性、绝不抛(fail-soft)、
 *   env 门控 `KHY_TODO_STATE_UNIFY` 默认开。门控关时**读侧**壳注入 `os.tmpdir()` 回退到
 *   今日路径 → 与今日**字节一致**(写侧本就用 getTmpDir,两态输出相同)。
 *
 * 诚实边界:只**产候选路径清单**,不碰 IO(mkdir/read/write 由调用壳执行)。source 标签沿用
 *   读侧今日既有值(legacy_data_home / workspace / temp_runtime)以保看板 payload.source 不变。
 */

const path = require('path');

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 兼容 todo_state 文件名(读写两侧共用,历史值)。 */
const TODO_STATE_FILE_NAME = 'todo_state.json';

/** 兼容目录名(`.khyquant` 用于 home/cwd;`khyquant` 用于 tmp 下)。 */
const DOT_DIR = '.khyquant';
const TMP_SUBDIR = 'khyquant';

/** 门控:KHY_TODO_STATE_UNIFY 默认开,仅 {0,false,off,no} 关。 */
function todoStateUnifyEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_TODO_STATE_UNIFY;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

/**
 * 有序候选目录清单(home → cwd → tmp)。source 标签与读侧今日既有值一致。
 * @param {{homedir?:string, cwd?:string, tmpdir?:string}} [opts]
 * @returns {Array<{source:string, dir:string}>}
 */
function todoStateCandidateDirs(opts = {}) {
  try {
    const homedir = String(opts.homedir || '');
    const cwd = String(opts.cwd || '');
    const tmpdir = String(opts.tmpdir || '');
    return [
      { source: 'legacy_data_home', dir: path.join(homedir, DOT_DIR) },
      { source: 'workspace', dir: path.join(cwd, DOT_DIR) },
      { source: 'temp_runtime', dir: path.join(tmpdir, TMP_SUBDIR) },
    ];
  } catch {
    return [];
  }
}

/**
 * 有序候选文件清单(每个 dir 拼上 `todo_state.json`)。写侧用 `.dir` 建目录 + `.file_path`
 * 写文件;读侧遍历 `.file_path` 找第一个存在的、并回报 `.source`。
 * @param {{homedir?:string, cwd?:string, tmpdir?:string}} [opts]
 * @returns {Array<{source:string, dir:string, file_path:string}>}
 */
function todoStateCandidateFiles(opts = {}) {
  try {
    return todoStateCandidateDirs(opts).map((c) => ({
      source: c.source,
      dir: c.dir,
      file_path: path.join(c.dir, TODO_STATE_FILE_NAME),
    }));
  } catch {
    return [];
  }
}

module.exports = {
  TODO_STATE_FILE_NAME,
  DOT_DIR,
  TMP_SUBDIR,
  todoStateUnifyEnabled,
  todoStateCandidateDirs,
  todoStateCandidateFiles,
};
