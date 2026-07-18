'use strict';

/**
 * commandOverlapAudit.js — 纯叶子:斜杠命令重叠审计 + 主命令可发现性面板(命令层的
 * **编译期收敛机制**)。
 *
 * 背景(khyos 自审报告 #7「命令过载·173 命令重叠·/schedule vs /cron、/push vs
 * /repo publish、/sandbox vs /sandbox-toggle」)。命令重叠**几乎全是有意的**——多为
 * Claude Code 名别名,route 指向 khy 既有 canonical(见 BUILTIN_SLASH_COMMANDS 各条 desc
 * 「对齐 Claude Code … → khy …」)。但「有意」只写在自由文本里,**从无机器可判的声明**:
 * 于是「这条 /cmd 是那条的别名」只能靠人肉读注释发现,新加一条撞了别人 route 也无人察觉
 * ——正是报告的「叠加式复杂度无收敛机制」。
 *
 * 本叶子与 [[directiveRegistryAudit]](收敛自审 #1 的指令层)同族,把「命令 route 碰撞」的
 * 一致性变成**可断言的纯函数**:给定完整命令 schema + 声明式别名 SSOT(COMMAND_ALIASES),
 * 返回——
 *   ① routeCollisions:多条 slash 命令映射到同一 canonical route 的分组;
 *   ② undeclaredCollisions:碰撞里**未在别名表登记**的(=意外漂移,守卫据此失败);
 *   ③ danglingAliases:别名表登记了、但 route 与真实 schema 对不上的死声明。
 * 守卫测试据此在提交期锁死:每一处 route 碰撞都必须是**显式登记的有意别名**,否则拦下。
 *
 * 另附「主命令面板」(buildPrimaryCommandPanel):把 canonical(非别名)命令按类别聚合,
 * 直面自审 #7 的方向「按频率/类别排序的 Top-N 面板 + 弃用冗余别名」——让 173 条里的
 * 真·主命令可发现,别名折叠到其 canonical 之下不再各自占位。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛。审计原语(auditCommandOverlap)**无门控**——它被
 * 守卫测试消费、不改运行时行为,故无逃生阀。面板渲染(buildPrimaryCommandPanel)经门控
 * KHY_COMMAND_PRIMARY_PANEL(默认开,仅 0/false/off/no 关;关 → 返 null 让调用方字节回退)。
 * 异常输入 → 尽力返回结构化空结果,绝不抛。
 *
 * @module services/commandOverlapAudit
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 面板门控。优先 flagRegistry(集中优先级),不可用时回退本地 CANON 词表。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function isPanelEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_COMMAND_PRIMARY_PANEL', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_COMMAND_PRIMARY_PANEL;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/** 取 schema 条目的 slash route(缺则空串)。 */
function _slashRoute(entry) {
  if (!entry || typeof entry !== 'object' || !entry.slash || typeof entry.slash !== 'object') return '';
  return String(entry.slash.route == null ? '' : entry.slash.route).trim();
}

/** 取 schema 条目的 slash cmd(含前导 /,缺则空串)。 */
function _slashCmd(entry) {
  if (!entry || typeof entry !== 'object' || !entry.slash || typeof entry.slash !== 'object') return '';
  return String(entry.slash.cmd == null ? '' : entry.slash.cmd).trim();
}

/**
 * 审计命令 schema 的 route 碰撞与别名声明一致性。
 *
 * @param {Array<object>} schema  getCommandSchema() 输出(每项含 slash:{cmd,route,...}|null)
 * @param {Object<string,string>} aliases  COMMAND_ALIASES(别名 /cmd → canonical route)
 * @returns {{
 *   routeCollisions: Array<{route:string, cmds:string[]}>,  // 同 route 的多命令分组(≥2)
 *   undeclaredCollisions: Array<{route:string, cmds:string[]}>, // 碰撞里未被别名表覆盖的漂移
 *   danglingAliases: string[],   // 别名表登记了但 route 对不上真实 schema 的死声明
 *   ok: boolean                  // undeclared + dangling 皆空 → 一致
 * }}
 */
function auditCommandOverlap(schema, aliases) {
  const list = Array.isArray(schema) ? schema : [];
  const alias = (aliases && typeof aliases === 'object') ? aliases : {};

  // route → 出现的 slash cmd 列表(仅统计有 route 的命令;route:null 是纯 flag,不参与碰撞)。
  const byRoute = new Map();
  for (const entry of list) {
    const route = _slashRoute(entry);
    const cmd = _slashCmd(entry);
    if (!route || !cmd) continue;
    if (!byRoute.has(route)) byRoute.set(route, []);
    byRoute.get(route).push(cmd);
  }

  const routeCollisions = [];
  for (const [route, cmds] of byRoute) {
    if (cmds.length > 1) routeCollisions.push({ route, cmds: cmds.slice().sort() });
  }
  routeCollisions.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));

  // 别名表覆盖判定:一个碰撞被「解释」= 该 route 上除 canonical 外的每条 cmd 都在别名表里、
  // 且别名表登记的 route 与实际一致。undeclared = 碰撞里存在**没被别名表解释**的多余命令。
  const undeclaredCollisions = [];
  for (const { route, cmds } of routeCollisions) {
    // 该 route 下,别名表声明为「别名」的 cmd 集合(其登记 route 须等于本 route)。
    const declaredHere = new Set(
      cmds.filter((c) => Object.prototype.hasOwnProperty.call(alias, c) && String(alias[c]).trim() === route),
    );
    // canonical = 碰撞里未被声明为别名的命令。有意别名应恰好剩 1 条 canonical。
    const unexplained = cmds.filter((c) => !declaredHere.has(c));
    if (unexplained.length > 1) {
      undeclaredCollisions.push({ route, cmds: unexplained.slice().sort() });
    }
  }

  // dangling:别名表登记的 route 在真实 schema 里根本不存在(死声明,应清理)。
  const realRoutes = new Set(byRoute.keys());
  const danglingAliases = [];
  for (const [aliasCmd, route] of Object.entries(alias)) {
    if (!realRoutes.has(String(route).trim())) danglingAliases.push(aliasCmd);
  }
  danglingAliases.sort();

  return {
    routeCollisions,
    undeclaredCollisions,
    danglingAliases,
    ok: undeclaredCollisions.length === 0 && danglingAliases.length === 0,
  };
}

/**
 * 主命令面板(可发现性收敛)。把 canonical(非别名)slash 命令按类别聚合,别名折叠到其
 * canonical 之下。门控关 → null(调用方字节回退到旧的全量列表)。
 *
 * @param {Array<object>} schema   getCommandSchema() 输出
 * @param {Object<string,string>} aliases  COMMAND_ALIASES
 * @param {object} [opts]  {env, capPerCategory}
 * @returns {{ categories: Array<{category:string, commands:Array<{cmd:string,label:string,aliases:string[]}>}>,
 *            aliasCount:number, primaryCount:number } | null}
 */
function buildPrimaryCommandPanel(schema, aliases, opts = {}) {
  const o = opts || {};
  if (!isPanelEnabled(o.env)) return null;
  const list = Array.isArray(schema) ? schema : [];
  const alias = (aliases && typeof aliases === 'object') ? aliases : {};
  const aliasCmds = new Set(Object.keys(alias));

  // route → 折叠到该 route 的别名 cmd 列表(供 canonical 展示「别名」)。
  const aliasByRoute = new Map();
  for (const [aliasCmd, route] of Object.entries(alias)) {
    const r = String(route).trim();
    if (!aliasByRoute.has(r)) aliasByRoute.set(r, []);
    aliasByRoute.get(r).push(aliasCmd);
  }

  const cap = Number.isFinite(o.capPerCategory) && o.capPerCategory > 0 ? o.capPerCategory : 0;
  const byCategory = new Map();
  let primaryCount = 0;
  for (const entry of list) {
    const cmd = _slashCmd(entry);
    if (!cmd || aliasCmds.has(cmd)) continue;              // 跳过别名本身,只留 canonical
    const category = String((entry.slash && entry.slash.category) || entry.category || 'system').trim() || 'system';
    const label = String((entry.slash && entry.slash.label) || '').trim();
    const route = _slashRoute(entry);
    const foldedAliases = route && aliasByRoute.has(route)
      ? aliasByRoute.get(route).slice().sort() : [];
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push({ cmd, label, aliases: foldedAliases });
    primaryCount++;
  }

  const categories = [...byCategory.keys()].sort().map((category) => {
    let commands = byCategory.get(category).slice()
      .sort((a, b) => (a.cmd < b.cmd ? -1 : a.cmd > b.cmd ? 1 : 0));
    if (cap > 0) commands = commands.slice(0, cap);
    return { category, commands };
  });

  return { categories, aliasCount: aliasCmds.size, primaryCount };
}

module.exports = {
  isPanelEnabled,
  auditCommandOverlap,
  buildPrimaryCommandPanel,
};
