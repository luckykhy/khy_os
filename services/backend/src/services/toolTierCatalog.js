'use strict';

/**
 * toolTierCatalog —— 纯叶子(pure leaf):工具**分级 + 元工具**的单一真源。
 *
 * /goal「khyos 工具有大量重复的名字;要保证工具名单一、简洁,并且给工具分级——第一级为
 * 元工具,可以用元工具组装任意工具、实现任何工具」。
 *
 * 分工(承既有基础设施,只补真正缺口):
 *   - **名字单一/简洁**:已由既有栈落地——toolRegistryDedup(把 readFile→Read 等真重复
 *     实现折叠成规范工具别名)+ toolContract._auditCollisions(归一键冲突巡检)。本叶子**不**
 *     重复折叠逻辑,只在指令里重申「每个能力只用它的单一规范名」。
 *   - **分级 + 元工具**:这是本叶子填的真缺口——此前全仓没有任何 tier / 元工具的一等概念。
 *     本叶子声明三级层级与第一级元工具集(可组装任意工具的原语),并产一段确定性指令注入
 *     coding profile,让模型知道「有哪些元工具、任何能力都能由它们组装(必要时用 createTool
 *     铸造),优先用单一规范名」。
 *
 * 契约(leaf-contract):零 IO(不碰 fs/网络/子进程/process.exit)、确定性(同输入同输出)、
 * 单一真源(TIERS / META_TOOLS 只在本文件)、env 门控 KHY_TOOL_TIER_CATALOG 默认开
 * (flagRegistry-first + 注册表关时回退本地 _off 判定,门关 → 逐字节回退:不注入、返安全空值)、
 * fail-soft 绝不抛、返回深副本(内部真源不可被外部改动污染)。
 *
 * 边界诚实:本叶子是**引导/治理层**——它把「哪些是元工具、如何组装」讲清楚,但不改工具注册表、
 * 不执行工具、不新建工具。真正「用元工具组装任意工具」的机制已存在于 createTool 工具 +
 * metaToolEngine(见 DESIGN-ARCH-017 元工具系统设计);本叶子把该机制**升格为一等分级概念**
 * 并让模型可见、可依循。
 *
 * @module services/toolTierCatalog
 */

const flagRegistry = require('./flagRegistry');

/** 关闭词表(对齐仓库既有门控约定)。注册表关时的 OFF-fallback 路径。 */
const _OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * 三级层级(单一真源,冻结)。tier 数字越小越基础:
 *   1 · 元工具  —— 原子/组合原语,可组装出任何其他工具与能力。
 *   2 · 核心工具 —— 直接落地单一能力(读写/执行/git/系统等)。
 *   3 · 领域/组合工具 —— 面向具体场景,通常由前两级组合而成。
 */
const TIERS = Object.freeze([
  Object.freeze({
    tier: 1,
    key: 'meta',
    title: '元工具',
    desc: '原子 / 组合原语——可组装出任何其他工具与能力',
  }),
  Object.freeze({
    tier: 2,
    key: 'core',
    title: '核心工具',
    desc: '直接落地单一能力(读写 / 执行 / git / 系统等)',
  }),
  Object.freeze({
    tier: 3,
    key: 'domain',
    title: '领域 / 组合工具',
    desc: '面向具体场景,通常由前两级工具组合而成',
  }),
]);

/**
 * 第一级元工具集(单一真源,冻结):**从这组原语可组装 / 铸造出任何其他工具与能力**。
 * 选型标准=「通用组合原语」——文件读写、内容检索、执行、取网、委派/编排、以及元工具铸造本身。
 * 全部使用**单一规范名**(与 toolRegistryDedup 折叠后的规范名一致:Read/Write/Edit 而非
 * readFile/…)。createTool 是「铸造任意纯计算工具」的顶点原语(需启用元工具系统方可实际铸造)。
 */
const META_TOOLS = Object.freeze([
  'Read',        // 文件读取原语
  'Write',       // 文件写入原语
  'Edit',        // 文件就地编辑原语
  'Glob',        // 文件名/路径检索原语
  'Grep',        // 内容检索原语
  'WebFetch',    // 网络取用原语
  'shellCommand',// 任意命令执行原语
  'executeCode', // 任意代码执行原语
  'Agent',       // 子代理委派原语(以委派组合能力)
  'Workflow',    // 多代理编排原语(以编排组合能力)
  'createTool',  // 元工具铸造原语——组装/铸造出任何新工具(DESIGN-ARCH-017)
]);

/** 归一化工具键——lowercase + 去非字母数字(复刻 toolContract._toolKey / toolCalling._toolKey)。 */
// 收敛到 utils/normalizeAlnumKey 单一真源(逐字节委托,调用点不变)
const _normalize = require('../utils/normalizeAlnumKey');

/** 元工具归一名集合(预计算,确定性)。 */
const _META_NORM = new Set(META_TOOLS.map(_normalize));

/**
 * 分级目录是否启用。默认开;仅当 KHY_TOOL_TIER_CATALOG 显式置关闭词才禁用。
 * 委托 flagRegistry(注册表开时);注册表关时回退本地 _off 判定 → 逐字节等价。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    if (flagRegistry.isRegistryEnabled(env)) {
      return flagRegistry.isFlagEnabled('KHY_TOOL_TIER_CATALOG', env);
    }
    const raw = String((env && env.KHY_TOOL_TIER_CATALOG) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/**
 * 是否为第一级元工具。门关 / 坏输入 → false(安全默认)。
 * @param {string} name 工具名(任意大小写 / 命名风格,内部归一匹配)
 * @param {object} [env]
 * @returns {boolean}
 */
function isMetaTool(name, env = process.env) {
  if (!isEnabled(env)) return false;
  const norm = _normalize(name);
  if (!norm) return false;
  return _META_NORM.has(norm);
}

/**
 * 判定某工具所属层级(1/2/3)。门关 → null(不分级)。
 *
 * 判定顺序(确定性):
 *   1. 命中元工具集 → 1。
 *   2. 否则按 category 归类:execution/filesystem/git/system → 2(核心);
 *      data/analysis/optimization/coordinator/mcp/custom / 未知 / 缺失 → 3(领域/组合)。
 *
 * @param {string|{name?:string, category?:string}} toolOrName 工具对象或工具名
 * @param {object} [env]
 * @returns {number|null}
 */
function classifyTier(toolOrName, env = process.env) {
  if (!isEnabled(env)) return null;
  let name = '';
  let category = '';
  if (typeof toolOrName === 'string') {
    name = toolOrName;
  } else if (toolOrName && typeof toolOrName === 'object') {
    name = typeof toolOrName.name === 'string' ? toolOrName.name : '';
    category = typeof toolOrName.category === 'string' ? toolOrName.category : '';
  }
  if (isMetaTool(name, env)) return 1;
  const cat = String(category || '').trim().toLowerCase();
  if (['execution', 'filesystem', 'git', 'system'].includes(cat)) return 2;
  return 3; // data/analysis/optimization/coordinator/mcp/custom/未知/缺失 → 领域/组合
}

/** classifyTier 的公开别名(语义:取工具层级)。 */
function getTier(toolOrName, env = process.env) {
  return classifyTier(toolOrName, env);
}

/**
 * 列出第一级元工具(规范名)。门关返 [];返回副本(改动不污染内部真源)。
 * @param {object} [env]
 * @returns {string[]}
 */
function listMetaTools(env = process.env) {
  if (!isEnabled(env)) return [];
  return META_TOOLS.slice();
}

/**
 * 列出层级定义。门关返 [];返回深副本。
 * @param {object} [env]
 * @returns {Array<{tier:number,key:string,title:string,desc:string}>}
 */
function listTiers(env = process.env) {
  if (!isEnabled(env)) return [];
  return TIERS.map((t) => ({ tier: t.tier, key: t.key, title: t.title, desc: t.desc }));
}

/**
 * 构建注入 coding profile 的分级 + 元工具指令(确定性、无随机)。门关 → ''(逐字节回退)。
 * 指令同时承载两个诉求:①工具分级 + 元工具可组装任意工具;②每个能力只用单一规范名。
 * @param {object} [env]
 * @returns {string}
 */
function buildTierDirective(env = process.env) {
  if (!isEnabled(env)) return '';
  try {
    const lines = [];
    lines.push('## 工具分级与元工具(单一规范名)');
    lines.push('');
    lines.push('khyos 的工具按能力分为三级。任何能力都能由**第一级元工具**组装 / 铸造出来——'
      + '需要现有工具没有的能力时,优先用元工具拼装,而不是新增重名 / 近重名的工具。');
    lines.push('');
    for (const t of TIERS) {
      if (t.tier === 1) {
        lines.push(`- **第 ${t.tier} 级 · ${t.title}(可组装任意工具)**:`
          + `${META_TOOLS.join(' / ')}——${t.desc}。`);
      } else {
        lines.push(`- **第 ${t.tier} 级 · ${t.title}**:${t.desc}。`);
      }
    }
    lines.push('');
    lines.push('规则:');
    lines.push('1. 每个能力只用它的**单一规范名**(如 `Read`,不要用 `readFile` / `read_file` '
      + '等重复别名);工具名保持单一、简洁、一致。');
    lines.push('2. 找不到合适工具时,优先用第一级元工具组装;可纯计算完成的新能力用 '
      + '`createTool` 铸造(需启用元工具系统),切勿新增重名 / 近重名工具。');
    return lines.join('\n');
  } catch {
    return ''; // fail-soft:任何异常都回退空串(不注入)
  }
}

module.exports = {
  TIERS,
  META_TOOLS,
  isEnabled,
  isMetaTool,
  classifyTier,
  getTier,
  listMetaTools,
  listTiers,
  buildTierDirective,
  _normalize,
};
