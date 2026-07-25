'use strict';

/**
 * orphanSweep.js — 叶子:清除安装树内 pip 升级残留的 `~` 前缀损坏孤儿目录(单一真源)。
 *
 * 背景(真缺口):khy 以 pip/npm 打包分发,落到用户机器后运行于 `bundled/` 树。在 **Windows**
 * 上,`pip install --upgrade` 卸载旧版时会把每个待替换条目重命名为「首字符改成 `~` 的兄弟目录」
 * (碰撞时第二字符再变:`~~`/`~-`/`~%`/`~0`…)以绕开文件锁;若升级被 AV 锁 / 崩溃 / Ctrl-C 打断,
 * 这些 stash 就**残留**下来——`src`→`~rc`、`data`→`~ata`、`logrotate.d`→`~ogrotate.d`、
 * `kernel`→`~ernel`。每次被打断的升级累加一份完整乱名副本,最终把安装树膨胀到 GB 级。
 *
 * 现有清理(`platform/khy_platform/cli.py::_sweep_corrupt_orphans`)只做**顶层浅扫**,而 stash 深藏
 * 在嵌套层(`bundled/services/backend/src`→`~rc`),永远扫不到。本叶子补上缺失的一环:**递归**遍历
 * bundled 树,删除任意深度的 `~` 前缀目录。npm 渠道由 `sourceHealService.runStartupHeal` 接线复用;
 * pip 渠道由 cli.py 平行实现(Python 侧)。
 *
 * 安全红线(承源码自愈事故教训:极端保守,绝不误删):
 *   - **只删 `~` 前缀的目录**——合法 bundled 内容永不以 `~` 开头,这是零歧义的损坏标记。`~` 前缀
 *     **文件**一律不动(Office `~$` 锁文件等非我方产物)。
 *   - **不跟随符号链接**(Dirent.isSymbolicLink → 跳过),绝不 rmSync 穿出树外。
 *   - **不越出 root**(_isInside 二次校验);**剪枝** node_modules/.git(非 pip 管理、不会被 stash,
 *     且是遍历开销大头)。
 *   - 遇 `~` 目录整体 rm 后**不再下降**;**硬上限**兜底防失控;全程 fail-soft(绝不抛)。
 *
 * 契约(CONTRACT):IO 经**注入的 fs**(默认 `require('fs')`)以便测试;确定性(遍历顺序稳定);
 *   env 门控 `KHY_ORPHAN_SWEEP` 默认开,关 → sweepBundledOrphans 返回 skipped 的空结果(字节回退到
 *   「不做深扫」,把清理留给 cli.py 的顶层浅扫)。
 *
 * 全局门控惯例:khy 所有 KHY_* 开关读法为「仅 0/false/off/no(去空白小写)才算关」。
 */

const nodeFs = require('fs');
const path = require('path');

const _OFF = new Set(['0', 'false', 'off', 'no']);

/** 遍历中剪除的目录名(非 pip 管理、不会被 stash;也是遍历开销大头)。 */
const PRUNE_DIRS = new Set(['node_modules', '.git']);

/** 一次深扫最多删除的孤儿目录数(防失控)。真实累积样本约 1.8k 目录,留足余量。 */
const DEFAULT_MAX_SWEEP = 50000;

/** 门控:KHY_ORPHAN_SWEEP 默认开,仅 {0,false,off,no} 关。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_ORPHAN_SWEEP;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_OFF.has(v);
  } catch {
    return true;
  }
}

/** 一次深扫的删除数上限。KHY_ORPHAN_SWEEP_MAX 覆盖,非正整数/坏值 → 默认。 */
function resolveMaxSweep(env = (typeof process !== 'undefined' ? process.env : {})) {
  try {
    const raw = env && env.KHY_ORPHAN_SWEEP_MAX;
    if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MAX_SWEEP;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return DEFAULT_MAX_SWEEP;
    return n;
  } catch {
    return DEFAULT_MAX_SWEEP;
  }
}

/**
 * 损坏孤儿目录名判定:以 `~` 开头(且非 `.`/`..`)。合法 bundled 目录永不以 `~` 起头,
 * 故这是零歧义的损坏标记。纯函数、绝不抛。
 */
function isCorruptOrphanName(name) {
  try {
    if (typeof name !== 'string' || !name) return false;
    if (name === '.' || name === '..') return false;
    return name.charCodeAt(0) === 0x7e; // '~'
  } catch {
    return false;
  }
}

/** 路径包含判定:child 是否在 root 之内(含 root 自身)。防越界删除。 */
function _isInside(child, root) {
  try {
    const rel = path.relative(root, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * 递归清除 bundled 树内 `~` 前缀损坏孤儿目录。
 *
 * @param {object} opts
 * @param {string} opts.root       - 要清扫的 bundled 树根(必填)。
 * @param {boolean} [opts.apply=true] - false = dry-run(只统计不删),用于验证/预览。
 * @param {object} [opts.env]       - 门控环境(默认 process.env)。
 * @param {object} [opts.fs]        - 注入的 fs(默认真实 fs;测试可注入)。
 * @param {number} [opts.limit]     - 覆盖删除上限(默认 resolveMaxSweep)。
 * @returns {{ ok:boolean, scanned:number, removed:string[], skipped:boolean, reason:string }}
 *   fail-soft:门控关/无 root → skipped 空结果;错误 → ok:false + reason。
 */
function sweepBundledOrphans(opts = {}) {
  const result = { ok: true, scanned: 0, removed: [], skipped: false, reason: 'done' };
  try {
    const env = (opts && opts.env) || (typeof process !== 'undefined' ? process.env : {});
    if (!isEnabled(env)) {
      result.skipped = true;
      result.reason = 'gate-off';
      return result;
    }
    const rootIn = opts && opts.root;
    if (!rootIn || typeof rootIn !== 'string') {
      result.skipped = true;
      result.reason = 'no-root';
      return result;
    }
    const fsm = (opts && opts.fs) || nodeFs;
    const apply = !(opts && opts.apply === false);
    const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : resolveMaxSweep(env);

    // 规范化 root(fail-soft:realpath 不可用/不存在 → 原样使用/跳过)。
    let root = rootIn;
    try {
      if (typeof fsm.realpathSync === 'function') root = fsm.realpathSync(rootIn);
    } catch {
      result.skipped = true;
      result.reason = 'no-root';
      return result;
    }

    // 迭代式 DFS(避免深树递归爆栈)。遇 `~` 目录删后不入栈;剪枝 node_modules/.git;跳符号链接。
    const stack = [root];
    let hitLimit = false;
    while (stack.length && !hitLimit) {
      const dir = stack.pop();
      let entries;
      try {
        entries = fsm.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // 不可读目录 → 跳过(fail-soft)
      }
      for (const ent of entries) {
        if (result.removed.length >= limit) {
          result.reason = 'limit';
          hitLimit = true;
          break;
        }
        let isSymlink = false;
        let isDir = false;
        try {
          if (typeof ent.isSymbolicLink === 'function') isSymlink = ent.isSymbolicLink();
          if (typeof ent.isDirectory === 'function') isDir = ent.isDirectory();
        } catch {
          continue;
        }
        // 符号链接一律不跟随、不删除(可能指向树外)。
        if (isSymlink) continue;
        // 只关心目录;`~` 前缀**文件**不动。
        if (!isDir) continue;

        const name = ent.name;
        const full = path.join(dir, name);
        result.scanned++;

        if (isCorruptOrphanName(name)) {
          if (!_isInside(full, root)) continue; // 越界保护(理论不该发生)
          if (apply) {
            try {
              fsm.rmSync(full, { recursive: true, force: true });
            } catch {
              continue; // 删除失败 → 跳过(fail-soft,不计入 removed)
            }
          }
          result.removed.push(full);
          continue; // 整棵乱名副本一次处理,不再下降
        }

        if (PRUNE_DIRS.has(name)) continue; // 剪枝
        stack.push(full); // 干净目录 → 下降
      }
    }
  } catch (err) {
    result.ok = false;
    result.reason = 'error: ' + String((err && err.message) || err);
  }
  return result;
}

module.exports = {
  isEnabled,
  resolveMaxSweep,
  isCorruptOrphanName,
  sweepBundledOrphans,
  _isInside,
  PRUNE_DIRS,
  DEFAULT_MAX_SWEEP,
};
