'use strict';

/**
 * uninstall/uninstallPlan.js — 「khy 完整卸载」的残留位置单一真源（纯叶子）。
 *
 * 目标（承 goal「khy uninstall 后可以完整地把所有历史残留版本清理干净」）：
 * 把 khy/khyquant/khyos 在**用户家目录**里历史上铺设过的所有数据家/运行时/
 * 指针/可见别名，收敛成一份**确定性、可枚举**的清单，供 handler 逐条核对存在
 * 性并清理。绝不用「黑名单」思路瞎删——这里只声明**已知由本程序生成**的位置，
 * 名单之外的一律不碰（对齐 diskCleanup/junkCatalog 的允许清单原则）。
 *
 * 契约（leaf-contract）：零 IO（不 stat/不删）、确定性、绝不抛、可注入。存在性
 * 检查与真正删除是 handler（shell 层）的职责——本叶子只回答「历史上可能在哪」。
 *
 * 覆盖的历史残留（依据 utils/dataHome.js 的解析器族 + 各服务硬编码位置）：
 *   1. ~/.khy              统一数据家默认位置（getDataHome）+ 内含指针/note
 *   2. ~/.khyquant         legacy 应用数据家（getLegacyDataHome / getAppHome）
 *   3. ~/.khyos            生态底座数据家（getBaseHome）
 *   4. ~/.khy-runtime      大任务运行时（largeTaskRuntimeStore，历史上落在家目录）
 *   5. 迁移后的异盘数据家   <drive>/.khy、<drive>/.khy-project（记录在 pointer 里）
 *   6. khy-Trajectory      数据家父目录旁的可见别名 symlink（_ensureVisibleAlias）
 *   7. ~/.khy/.location.json 指针（若选择保留数据家则单列，否则随 ~/.khy 一并删）
 *
 * 门控 KHY_UNINSTALL 默认开；关 → buildUninstallTargets 返回 []（handler 据此
 * 逐字节回退到「命令不可用」提示，不触碰任何文件）。
 */

const path = require('path');

/** 关闭词表（对齐仓库既有门控约定）。 */
const _OFF = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);

/**
 * 卸载能力是否启用。默认开；仅当 KHY_UNINSTALL 显式置为关闭词才禁用。
 * @param {object} [env]
 * @returns {boolean}
 */
function uninstallEnabled(env = process.env) {
  try {
    const raw = String((env && env.KHY_UNINSTALL) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/** 稳定化路径：非法输入 → null；否则 path.resolve（不触盘）。 */
function _norm(p) {
  if (!p || typeof p !== 'string') return null;
  try { return path.resolve(p); } catch { return null; }
}

/**
 * 目标分类常量（供 handler 分组/着色/scope 过滤）。
 *   data      真实用户数据家（删除不可逆 → 需显式确认）
 *   runtime   运行时/大任务临时（可重建）
 *   pointer   位置指针/breadcrumb（元数据）
 *   alias     可见别名 symlink（无独立数据）
 */
const KIND = {
  DATA: 'data',
  RUNTIME: 'runtime',
  POINTER: 'pointer',
  ALIAS: 'alias',
};

/**
 * 构建卸载目标清单（纯函数，零 IO）。
 *
 * @param {object} facts
 * @param {string} facts.homedir     用户家目录（os.homedir()）
 * @param {object} [facts.homes]     已解析的各数据家绝对路径（可缺省，缺省用默认位置推导）
 * @param {string} [facts.homes.dataHome]
 * @param {string} [facts.homes.appHome]
 * @param {string} [facts.homes.baseHome]
 * @param {string} [facts.homes.projectDataHome]
 * @param {string} [facts.homes.legacyAppHome]
 * @param {object|null} [facts.pointer] 解析后的指针对象（含 dataHome/projectDataHome 迁移位置）
 * @param {string} [facts.pointerFile]  指针文件绝对路径
 * @param {object} [env]
 * @returns {Array<{id,label,path,kind,reversible,note}>} 去重后的目标（存在性由调用方核对）
 */
function buildUninstallTargets(facts, env = process.env) {
  if (!uninstallEnabled(env)) return [];
  const f = facts && typeof facts === 'object' ? facts : {};
  const home = _norm(f.homedir);
  if (!home) return [];

  const homes = f.homes && typeof f.homes === 'object' ? f.homes : {};
  const pointer = f.pointer && typeof f.pointer === 'object' ? f.pointer : null;

  // 候选构造：每条 {id,label,path,kind,reversible,note}。先收集再去重（按 resolved path）。
  const out = [];
  const seen = new Set();
  const add = (id, label, p, kind, reversible, note) => {
    const abs = _norm(p);
    if (!abs) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ id, label, path: abs, kind, reversible: !!reversible, note: note || '' });
  };

  // ── 1. 家目录级历史数据家（默认位置 + 解析器实际所在，二者都要列，异盘迁移才不漏） ──
  const defaultData = path.join(home, '.khy');
  const defaultLegacy = path.join(home, '.khyquant');
  const defaultBase = path.join(home, '.khyos');

  add('data-home', 'khy 数据家 (~/.khy)',
    homes.dataHome || defaultData, KIND.DATA, false,
    '会话/记忆/数据库/缓存主目录，删除不可逆');
  // 解析器可能被 KHY_DATA_HOME 指到别处；两者都列（去重保证不重复）。
  add('data-home-default', 'khy 数据家默认位置 (~/.khy)',
    defaultData, KIND.DATA, false, '默认数据家位置');

  add('legacy-app-home', 'khyquant 遗留数据家 (~/.khyquant)',
    homes.legacyAppHome || homes.appHome || defaultLegacy, KIND.DATA, false,
    '历史对话/版本缓存/技能等遗留数据');
  add('legacy-app-home-default', 'khyquant 遗留数据家默认位置 (~/.khyquant)',
    defaultLegacy, KIND.DATA, false, '默认遗留数据家位置');

  add('base-home', 'khyos 生态底座数据家 (~/.khyos)',
    homes.baseHome || defaultBase, KIND.DATA, false,
    '底座 data/cache/models/logs');
  add('base-home-default', 'khyos 底座数据家默认位置 (~/.khyos)',
    defaultBase, KIND.DATA, false, '默认底座数据家位置');

  // ── 2. 运行时 / 大任务临时（可重建） ──
  add('runtime-home', 'khy 大任务运行时 (~/.khy-runtime)',
    path.join(home, '.khy-runtime'), KIND.RUNTIME, true,
    '大任务运行时缓存，可安全重建');

  // ── 3. 异盘迁移后的数据家（记录在 pointer；只有落在家目录之外才单列，否则已被上面覆盖） ──
  if (pointer) {
    if (pointer.dataHome) {
      add('relocated-data-home', 'khy 迁移后数据家 (指针记录)',
        pointer.dataHome, KIND.DATA, false, '曾用 storage migrate 迁到非系统盘');
    }
    if (pointer.projectDataHome) {
      add('relocated-project-home', 'khy 迁移后项目数据家 (指针记录)',
        pointer.projectDataHome, KIND.DATA, false, '迁移后的项目级会话/记忆家');
    }
  }
  // 项目数据家（解析器所在，若非默认位置）。
  if (homes.projectDataHome) {
    add('project-data-home', 'khy 项目数据家 (指针/解析)',
      homes.projectDataHome, KIND.DATA, false, '项目级会话/轨迹/记忆');
  }

  // ── 4. 可见别名 symlink（khy-Trajectory，落在各数据家父目录旁；家目录侧最常见） ──
  add('visible-alias-home', 'khy 可见别名 (~/khy-Trajectory)',
    path.join(home, 'khy-Trajectory'), KIND.ALIAS, true,
    '指向数据家的可见 symlink（本身无数据）');

  // ── 5. 指针文件：随 ~/.khy 一起删；但若用户选择保留数据家，仍应能单独清指针 ──
  const pf = _norm(f.pointerFile) || path.join(home, '.khy', '.location.json');
  add('location-pointer', 'khy 位置指针 (.location.json)',
    pf, KIND.POINTER, true, '数据家位置 breadcrumb（元数据）');

  return out;
}

module.exports = {
  uninstallEnabled,
  buildUninstallTargets,
  KIND,
};
