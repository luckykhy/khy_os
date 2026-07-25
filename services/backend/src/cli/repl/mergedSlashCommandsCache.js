'use strict';

/**
 * mergedSlashCommandsCache — 经典 REPL「内置命令 + 用户技能/CC 命令」合并结果的短 TTL 缓存(纯叶子)。
 *
 * 承 [[slashRankIndexMemo]] / [[slashRankResultMemo]] / [[completionKeysLazy]] /
 * [[commandCompletionIndexMemo]] 同族:斜杠补全全链的最后一处每键重复计算。
 *
 * 根因:`repl.js::_getSlashCommands()` 每次按键(每次斜杠菜单刷新)都调 `_mergeUserSkillCommands`,
 * 后者对 `~/.khy/skills`(listUserSkillCommands)与 `.claude/commands`(listCcCommands)做**同步**
 * `readdirSync` + 逐 manifest `readFileSync` + `JSON.parse`——渲染热路径里的同步磁盘 IO + 解析。
 * 且当存在任一技能/CC 命令时,`baseCmds.slice()` + push 每次产生**新数组身份**,击穿下游
 * `slashRankIndexMemo` 的 WeakMap 键(投影每键从头重建)。
 *
 * 修:按 `baseCmds` **对象身份** + **短墙钟 TTL**(默认 1000ms)缓存「发现结果 + 合并数组」。
 * 一串按键(亚秒突发)命中缓存 → 免去每键 FS+parse,并返回**同一合并数组引用**(恢复投影记忆命中)。
 * TTL 过后下次渲染重跑发现 → 新建的技能仍在 ~1s 内出现于 `/` 菜单(freshness 契约不破)。
 *
 * 纯叶子纪律:零自身 IO(发现由注入的 `discoverFn` 承担)、确定性(时钟注入)、绝不抛;
 * 门控关 / 坏输入 / 异常 → 直接跑 `discoverFn` 现算合并(逐字节回退今日行为)。
 *
 * 门控 `KHY_MERGED_SLASH_COMMANDS_CACHE` 默认开;关 → 每次现扫合并,逐字节等价历史。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_MERGED_SLASH_COMMANDS_CACHE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

const DEFAULT_TTL_MS = 1000;

// 缓存槽:进程内单例。键为 baseCmds 身份(WeakMap 防泄漏),值 { at, merged }。
const _cache = new WeakMap();

/**
 * 把发现到的技能/CC 命令合并进 baseCmds(既有命令优先,仅补位缺失 cmd)。
 * 与 repl.js::_mergeUserSkillCommands 的合并语义逐字节一致(供门控关/未命中时现算)。
 * @param {Array} baseCmds
 * @param {Array} userSkills
 * @param {Array} ccCommands
 * @returns {Array} 合并数组(无补位时返回 baseCmds 原引用,与历史行为一致)
 */
function mergeCommands(baseCmds, userSkills, ccCommands) {
  const base = Array.isArray(baseCmds) ? baseCmds : [];
  const skills = Array.isArray(userSkills) ? userSkills : [];
  const cc = Array.isArray(ccCommands) ? ccCommands : [];
  if (!skills.length && !cc.length) return base;
  const existing = new Set(base.map((sc) => sc && sc.cmd));
  const merged = base.slice();
  for (const us of skills) {
    if (us && us.cmd && !existing.has(us.cmd)) {
      merged.push(us);
      existing.add(us.cmd);
    }
  }
  for (const c of cc) {
    if (c && c.cmd && !existing.has(c.cmd)) {
      merged.push(c);
      existing.add(c.cmd);
    }
  }
  return merged;
}

/**
 * 取合并后的斜杠命令数组(短 TTL 缓存)。
 *
 * @param {Array} baseCmds 稳定的内置/路由/extras 命令数组(repl.js::_slashCommandsCache,身份稳定)
 * @param {() => { userSkills: Array, ccCommands: Array }} discoverFn 现扫发现函数(承担 FS IO)
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {() => number} [opts.nowFn] 注入时钟(测试用),默认 Date.now
 * @param {number} [opts.ttlMs] TTL 覆盖(测试用),默认 1000ms
 * @returns {Array} 合并数组(TTL 内命中 → 同一引用;门控关/未命中 → 现算)
 */
function getMergedCommands(baseCmds, discoverFn, opts = {}) {
  const o = opts || {};
  const env = o.env || process.env;
  const now = typeof o.nowFn === 'function' ? o.nowFn : Date.now;
  const ttl = Number.isFinite(o.ttlMs) && o.ttlMs > 0 ? o.ttlMs : DEFAULT_TTL_MS;

  // 现扫合并(门控关 / 未命中 / 异常 的共同回退)。
  const _computeFresh = () => {
    let d;
    try { d = discoverFn(); } catch { d = null; }
    const userSkills = d && Array.isArray(d.userSkills) ? d.userSkills : [];
    const ccCommands = d && Array.isArray(d.ccCommands) ? d.ccCommands : [];
    return mergeCommands(baseCmds, userSkills, ccCommands);
  };

  try {
    if (!isEnabled(env) || !baseCmds || typeof baseCmds !== 'object') {
      return _computeFresh();
    }
    const at = now();
    const hit = _cache.get(baseCmds);
    if (hit && (at - hit.at) < ttl && Array.isArray(hit.merged)) {
      return hit.merged; // 同一引用 → 恢复下游 WeakMap 投影记忆命中
    }
    const merged = _computeFresh();
    _cache.set(baseCmds, { at, merged });
    return merged;
  } catch {
    // 任何意外 → 现算,绝不把渲染热路径拖垮。
    try { return _computeFresh(); } catch { return Array.isArray(baseCmds) ? baseCmds : []; }
  }
}

module.exports = {
  isEnabled,
  mergeCommands,
  getMergedCommands,
  OFF_VALUES,
  DEFAULT_TTL_MS,
};
