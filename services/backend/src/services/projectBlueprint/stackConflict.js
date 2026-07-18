'use strict';

/**
 * stackConflict.js — 纯叶子:检测「用户明确点名的技术栈」与「唯一命中的可构建原型所绑定的
 * 技术栈」之间的**具体冲突**(零 IO、确定性、绝不抛、门控)。
 *
 * 真实缺口(2026-07-05 会话现场,agnes):用户「开发一个 spring 项目数据库使用 psql」,而全库
 * 唯一的 Spring 原型 `ssm` 绑死 `spring-boot-mybatis`(MyBatis + MySQL 8),其触发词经模板还含
 * 宽泛的 "spring boot" → `matchArchetype` 子串命中 ssm。match() 无栈感知,模型只能「先套 MySQL
 * 模板、再回头把它改造成 PostgreSQL」——模板本该是**最后兜底**,却成了领跑,且冲突到跑了一半
 * 才被模型自己发现。
 *
 * 本叶子把这类冲突提前到 match 时确定式识别:仅当用户**明确点名**某个具体数据库,且它与原型
 * `stack.persistence` 所声明的数据库**不同**时,才判冲突(dimension='persistence')。冲突信号交
 * match() 用于**降级**(kind:'none',模板不领跑)并附一条「可参考其分层/REST/测试里程碑结构、
 * 但持久层按你点名的库自建」的软指引。
 *
 * 只识别**明确点名的具体栈冲突**,不臆测:
 *   · 用户没提数据库 → 无「requested」→ 不冲突(旧行为逐字节保留:如「做个SSM项目」仍命中 ssm)。
 *   · 原型没声明具体库,或双方归一到同一库 → 不冲突。
 *   · 只认能归一到已知数据库族的词(postgres/mysql/mongo/sqlite/mssql/oracle);泛词不触发。
 *
 * 契约:零 IO、确定性、绝不抛。env 门控 KHY_BLUEPRINT_STACK_CONFLICT_GUARD(默认开,仅显式
 * 0/false/off/no 关);关 / 无冲突 / 异常 → { conflict:false },调用方逐字节回退(旧 match 行为)。
 * 门控经 flagRegistry 集中判定(CANON),fail-soft 回退本地 CANON。
 *
 * @module services/projectBlueprint/stackConflict
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控判定:flagRegistry 优先,回退本地 CANON。默认开。 */
function stackConflictEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_BLUEPRINT_STACK_CONFLICT_GUARD', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_BLUEPRINT_STACK_CONFLICT_GUARD;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 数据库族识别:每族一组「词 + 归一族名 + 展示名」。词按串包含(大小写不敏感)匹配。
 * 顺序无关(冲突只看两侧归一族名是否不同);但每族的词要足够专指,避免误伤(如 "pg" 太短会
 * 命中 "pgadmin"/"npg" 之外的噪声,故只收 postgres/postgresql/psql 这类专指词 + 边界受控的 "pg")。
 */
const _DB_FAMILIES = [
  { family: 'postgresql', display: 'PostgreSQL', words: ['postgresql', 'postgres', 'psql', 'postgre', 'pgsql'] },
  { family: 'mysql', display: 'MySQL', words: ['mysql', 'mariadb'] },
  { family: 'mongodb', display: 'MongoDB', words: ['mongodb', 'mongo'] },
  { family: 'sqlite', display: 'SQLite', words: ['sqlite'] },
  { family: 'sqlserver', display: 'SQL Server', words: ['sqlserver', 'sql server', 'mssql'] },
  { family: 'oracle', display: 'Oracle', words: ['oracle'] },
];

// 独立词边界匹配 "pg"(如 "use pg"/"pg 数据库"),避免命中 "pgadmin"、"npgsql" 等子串噪声。
const _PG_WORD_RE = /(^|[^a-z0-9])pg([^a-z0-9]|$)/i;

/**
 * 把一段文本归一到**至多一个**数据库族名。命中多个族返回第一个命中的(_DB_FAMILIES 顺序);
 * 无命中返回 null。纯串匹配,不抛。
 * @param {string} text
 * @returns {{family:string, display:string}|null}
 */
function _classifyDb(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  for (const fam of _DB_FAMILIES) {
    for (const w of fam.words) {
      if (lower.includes(w)) return { family: fam.family, display: fam.display };
    }
  }
  if (_PG_WORD_RE.test(lower)) return { family: 'postgresql', display: 'PostgreSQL' };
  return null;
}

/**
 * 检测 goal 点名的数据库与原型持久层数据库是否冲突。
 * @param {string} goalText   用户目标文本
 * @param {object} archetype  命中的原型(含 stack.persistence)
 * @param {object} [env]
 * @returns {{conflict:boolean, requested?:string, archetypeHas?:string, dimension?:string, guidance?:string}}
 */
function detectStackConflict(goalText, archetype, env) {
  try {
    if (!stackConflictEnabled(env)) return { conflict: false };
    if (!archetype || typeof archetype !== 'object') return { conflict: false };

    const persistence = archetype.stack && archetype.stack.persistence;
    const requested = _classifyDb(goalText);
    const archetypeDb = _classifyDb(persistence);

    // 只有「用户明确点名一个库」且「原型也声明了一个具体库」且「两者不同」才算冲突。
    if (!requested || !archetypeDb) return { conflict: false };
    if (requested.family === archetypeDb.family) return { conflict: false };

    const label = archetype.label || archetype.id || '该原型';
    const guidance =
      `你点名了 ${requested.display},但最接近的可构建原型「${label}」用的是 ${archetypeDb.display}。` +
      `别整体套用它的持久层——它的分层(Controller→Service→数据访问)、REST 端点与测试里程碑仍可作` +
      `**结构参考**,但持久层(驱动依赖、连接配置/方言、schema DDL、数据访问代码)请按 ${requested.display} 自建。`;

    return {
      conflict: true,
      requested: requested.display,
      archetypeHas: archetypeDb.display,
      dimension: 'persistence',
      guidance,
    };
  } catch {
    return { conflict: false }; // 绝不抛:任何意外 → 无冲突,调用方走旧路径
  }
}

module.exports = {
  detectStackConflict,
  stackConflictEnabled,
  // 供测试
  _classifyDb,
};
