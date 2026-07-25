'use strict';

/**
 * gitSpawnPlan —— 决定 git 上下文采集是否走「无 shell 派生」及其 argv 分词。
 *
 * 纯叶子:零 IO、确定性、绝不抛。仅回答两件事:
 *   1) isShellFreeGitEnabled(env) —— 门控 KHY_GIT_SHELL_FREE(default-on CANON)。
 *   2) toGitArgv(cmd) —— 把 `git <cmd>` 里的子命令字符串安全分词成 argv 数组;
 *      若含 shell 元字符(引号/重定向/管道/变量替换等)无法安全分词 → 返回 null,
 *      由调用方逐字节回退到旧的 execSync 字符串路径(不冒错误分词的风险)。
 *
 * 背景:Windows 上 `execSync('git …')` 带 shell → 每次派生 cmd.exe → git 两个进程;
 * 改用 spawnSync('git', argv)(无 shell)直接派生 git.exe,去掉 cmd.exe 中介,进程数减半。
 * 本叶子只负责「能不能安全这么做」的判定,真正的派生留在 gitContextService。
 */

// CANON 口径:恰好这 4 个词视为「关」;disable/disabled 属 EXTENDED,对 CANON 门控当「开」。
const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控 KHY_GIT_SHELL_FREE:flagRegistry 优先,失败回退本地 CANON 判定。绝不抛。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isShellFreeGitEnabled(env) {
  const e = env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)) {
      return reg.isFlagEnabled('KHY_GIT_SHELL_FREE', e);
    }
  } catch {
    /* fall through to local CANON */
  }
  const raw = e.KHY_GIT_SHELL_FREE;
  if (raw === undefined || raw === null || raw === '') return true;
  return !_FALSY.has(String(raw).trim().toLowerCase());
}

// Shell 元字符:出现任一即放弃无 shell 分词(交回 execSync 保持旧语义)。
// 注意:git 上下文里的子命令都是固定字面量,正常不含这些;这是纯防御。
const _SHELL_META_RE = /[|&;<>()$`\\"'*?{}[\]~#!\n\r\t]/;

/**
 * 把 git 子命令字符串分词成 argv。仅接受由普通 token(空格分隔、无 shell 元字符)
 * 组成的命令;否则返回 null。永不抛。
 * @param {string} cmd 例如 'rev-parse --show-toplevel' 或 'log --oneline -15 --no-decorate'
 * @returns {string[]|null}
 */
function toGitArgv(cmd) {
  if (typeof cmd !== 'string') return null;
  const trimmed = cmd.trim();
  if (!trimmed) return null;
  if (_SHELL_META_RE.test(trimmed)) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts.length ? parts : null;
}

module.exports = {
  isShellFreeGitEnabled,
  toGitArgv,
  _FALSY,
  _SHELL_META_RE,
};
