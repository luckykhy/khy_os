'use strict';

/**
 * toolCatalog/toolContract.js — khy 工具契约审计器（纯叶子）。
 *
 * goal「保证 khy 工具的精准可用性，每个小工具都能达到预期的目的」的单一真源:
 * 对整个工具注册表做一次**契约巡检**，把「坏工具 / 命名冲突」从静默失败变成
 * 当场可见的结构化 findings。注册表 SSOT 来自 services/backend/src/tools 的 getAll。
 *
 * 是 toolCatalog（工具目录，给人浏览）的姊妹:
 *   - toolCatalog  → 「有哪些工具」（分组浏览）
 *   - toolContract → 「这些工具是否合契约、是否互相冲突」（质量巡检）
 *
 * 契约(leaf-contract):零 IO（注入 registry + SSOT 常量）、确定性、绝不抛、门控
 * KHY_TOOL_CONTRACT 默认开（关 → 空 findings，运行时入口据此隐藏；CI 守卫直调
 * auditTools 不经此门控，恒巡检）。本叶子只**读注册表并断言不变量**，不改工具、不执行工具。
 *
 * 四类不变量（逐工具 + 全表冲突）:
 *   1. 形状:name/description 非空、category ∈ CATEGORIES、risk ∈ RISK_LEVELS、
 *      toFunctionDef/validate/execute 为函数、isReadOnly/isDestructive/isEnabled 为函数。
 *   2. schema:toFunctionDef() 产出 {name, description, parameters:{type:'object', properties, required?}}。
 *   3. 参数(子门控 KHY_TOOL_PARAM_AUDIT 默认开):悬垂 required(名不在 properties)=error;
 *      参数缺 description=warning;参数缺 type/enum=warning;required 却带 default=warning
 *      (default 永不生效);array 却无 items=warning(元素类型不明)。→「模型能否正确使用工具」成守卫契约。
 *   4. 冲突:归一化键（lowercase + strip 非字母数字，复刻 toolCalling._toolKey）
 *      被 >1 个工具（含别名）占用 → 冲突。跨 risk 或跨 category = error；
 *      同 category 同 risk（纯孪生）= warning。
 *
 * @module services/toolCatalog/toolContract
 */

/** 关闭词表(对齐仓库既有门控约定)。保留为 flagRegistry 关时的 OFF-fallback 路径。 */
const _OFF = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);
// 父→子优先级(KHY_TOOL_CONTRACT 总门控关 → 全空 findings,由 auditTools 顶层施加)现由
// flagRegistry 单一声明式真源建模;本文件两个谓词委托给它(leaf→leaf 相对 require,契约允许)。
// 注意:paramAuditEnabled 在注册表里声明了 parent:KHY_TOOL_CONTRACT,但**父门控的实际拦截仍在
// auditTools 顶层**(if(!toolContractEnabled) return empty);注册表的 parent 字段此处仅供守卫结构
// 建模与语义文档,resolver 施加的父→子布尔与原「裸子查 + 顶层父门」净等价(父关时顶层已提前返空,
// 子查结果不被消费)。故此处委托保持逐字节等价。
const flagRegistry = require('../flagRegistry');

/**
 * 契约审计是否启用。默认开;仅当 KHY_TOOL_CONTRACT 显式置关闭词才禁用。
 * 委托 flagRegistry('KHY_TOOL_CONTRACT',EXTENDED 6 词 + 归一);注册表关时回退原 _OFF 判定。
 * @param {object} [env]
 * @returns {boolean}
 */
function toolContractEnabled(env = process.env) {
  try {
    if (flagRegistry.isRegistryEnabled(env)) {
      return flagRegistry.isFlagEnabled('KHY_TOOL_CONTRACT', env);
    }
    const raw = String((env && env.KHY_TOOL_CONTRACT) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/**
 * 参数级审计(每参数 description/type + 悬垂 required)是否启用。默认开;
 * 仅当 KHY_TOOL_PARAM_AUDIT 显式置关闭词才禁用 → 逐字节回退到未加参数审计前的 finding 集。
 * 子门控独立于 KHY_TOOL_CONTRACT:总门控关 → 全空(auditTools 顶层);总门控开而本门控关 → 只出形状/schema/冲突。
 * 委托 flagRegistry('KHY_TOOL_PARAM_AUDIT',EXTENDED 6 词 + 归一);注册表关时回退原 _OFF 判定。
 * @param {object} [env]
 * @returns {boolean}
 */
function paramAuditEnabled(env = process.env) {
  try {
    if (flagRegistry.isRegistryEnabled(env)) {
      return flagRegistry.isFlagEnabled('KHY_TOOL_PARAM_AUDIT', env);
    }
    const raw = String((env && env.KHY_TOOL_PARAM_AUDIT) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/**
 * 归一化工具键——与 services/toolCalling.js:_toolKey 逐字复刻（lowercase + 去非字母数字）。
 * 内联而非 require，避免审计叶子反向依赖 toolCalling（DAG 安全）。
 * @param {string} name
 * @returns {string}
 */
// 收敛到 utils/normalizeAlnumKey 单一真源(逐字节委托,调用点不变)
const _toolKey = require('../../utils/normalizeAlnumKey');

/** 稳定字符串化(去两端空白;非字符串 → '')。 */
// 收敛到 utils/trimIfString 单一真源(逐字节委托,调用点不变)
const _s = require('../../utils/trimIfString');

function _isFn(v) {
  return typeof v === 'function';
}

/** 惰性取 SSOT 常量（可注入覆盖，测试用）。fail-soft 回退空表 → 该维度不误报。 */
function _resolveCategories(deps) {
  if (deps && deps.CATEGORIES && typeof deps.CATEGORIES === 'object') return deps.CATEGORIES;
  try { return require('../../tools/_baseTool').CATEGORIES || {}; } catch { return {}; }
}
function _resolveRiskLevels(deps) {
  if (deps && Array.isArray(deps.RISK_LEVELS)) return deps.RISK_LEVELS;
  try { return require('../../constants/riskOrder').RISK_LEVELS || []; } catch { return []; }
}

/**
 * 逐工具形状 + schema 巡检。把 finding 追加进 out。
 * @param {object} tool
 * @param {{categories:object, risks:string[]}} ctx
 * @param {Array} out
 */
function _auditShape(tool, ctx, out) {
  const rule = 'shape';
  if (!tool || typeof tool !== 'object') {
    out.push({ severity: 'error', rule, tool: '(non-object)', message: '注册表条目非对象' });
    return;
  }
  const name = _s(tool.name);
  const label = name || '(unnamed)';
  if (!name) out.push({ severity: 'error', rule, tool: label, message: 'name 缺失或非字符串' });
  if (!_s(tool.description)) out.push({ severity: 'error', rule, tool: label, message: 'description 缺失或为空' });

  const cat = _s(tool.category);
  const catKeys = ctx.categories && typeof ctx.categories === 'object' ? Object.keys(ctx.categories) : [];
  if (catKeys.length && !catKeys.includes(cat)) {
    out.push({ severity: 'error', rule, tool: label, message: `category '${cat || '(空)'}' 不在 CATEGORIES 内` });
  }
  const risk = _s(tool.risk);
  if (ctx.risks.length && !ctx.risks.includes(risk)) {
    out.push({ severity: 'error', rule, tool: label, message: `risk '${risk || '(空)'}' 不在 RISK_LEVELS 内` });
  }

  // 行为字段应为函数（注册表工具由 defineTool/BaseTool 挂成方法）。
  for (const fnField of ['toFunctionDef', 'validate', 'execute', 'isReadOnly', 'isDestructive', 'isEnabled']) {
    if (!_isFn(tool[fnField])) {
      out.push({ severity: 'error', rule, tool: label, message: `${fnField} 应为函数` });
    }
  }

  // schema:toFunctionDef() 产出合法 function-calling 定义。
  if (_isFn(tool.toFunctionDef)) {
    let def;
    try { def = tool.toFunctionDef(); } catch (e) {
      out.push({ severity: 'error', rule: 'schema', tool: label, message: `toFunctionDef() 抛异常: ${e && e.message}` });
      return;
    }
    if (!def || typeof def !== 'object') {
      out.push({ severity: 'error', rule: 'schema', tool: label, message: 'toFunctionDef() 未返回对象' });
      return;
    }
    if (!_s(def.name)) out.push({ severity: 'error', rule: 'schema', tool: label, message: 'toFunctionDef().name 缺失' });
    if (typeof def.description !== 'string') out.push({ severity: 'error', rule: 'schema', tool: label, message: 'toFunctionDef().description 非字符串' });
    const p = def.parameters;
    if (!p || typeof p !== 'object' || p.type !== 'object' || !p.properties || typeof p.properties !== 'object') {
      out.push({ severity: 'error', rule: 'schema', tool: label, message: "toFunctionDef().parameters 非 {type:'object', properties:{…}}" });
    } else if (p.required !== undefined && !Array.isArray(p.required)) {
      // required 可为 undefined（无必填参数）；若存在必须是数组。
      out.push({ severity: 'error', rule: 'schema', tool: label, message: 'toFunctionDef().parameters.required 存在但非数组' });
    }
  }
}

/**
 * 全表命名冲突巡检。构建 Map<归一键, Set<属主名>>（遍历每工具 name + aliases）；
 * 键属主 >1 → 冲突。跨 risk 或跨 category = error；同 category 同 risk = warning。
 * @param {Array<object>} tools
 * @param {Array} out
 */
function _auditCollisions(tools, out) {
  const owners = new Map(); // key -> Map<ownerName, {category, risk}>
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const name = _s(tool.name);
    if (!name) continue;
    const meta = { category: _s(tool.category), risk: _s(tool.risk) };
    const namesForKeys = [name, ...(Array.isArray(tool.aliases) ? tool.aliases.map(_s).filter(Boolean) : [])];
    for (const n of namesForKeys) {
      const key = _toolKey(n);
      if (!key) continue;
      if (!owners.has(key)) owners.set(key, new Map());
      // 同一属主对同一键只记一次（name 与其某别名可能归一后相同）。
      const byOwner = owners.get(key);
      if (!byOwner.has(name)) byOwner.set(name, meta);
    }
  }

  // 确定性顺序:按归一键字母序输出。
  for (const key of Array.from(owners.keys()).sort()) {
    const byOwner = owners.get(key);
    if (byOwner.size < 2) continue; // 唯一属主 → 无冲突
    const entries = Array.from(byOwner.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const names = entries.map(([n]) => n);
    const cats = new Set(entries.map(([, m]) => m.category));
    const risks = new Set(entries.map(([, m]) => m.risk));
    const crossRisk = risks.size > 1;
    const crossCat = cats.size > 1;
    const severity = (crossRisk || crossCat) ? 'error' : 'warning';
    const why = crossRisk && crossCat ? '跨 risk 且跨 category'
      : crossRisk ? '跨 risk'
      : crossCat ? '跨 category'
      : '同类孪生';
    out.push({
      severity,
      rule: 'collision',
      tool: names.join(' ⇄ '),
      message: `归一键 '${key}' 被 ${byOwner.size} 个工具占用（${why}）: ${names.join(', ')}`,
    });
  }
}

/**
 * 逐工具参数级巡检——「达到预期目的」的更深一层:不止 schema 结构合法,还要每个参数
 * **模型能正确填**。三类不变量:
 *   1. 悬垂 required(error):required[] 里的名不在 properties → 模型被要求发一个 schema
 *      从未声明的参数 → Anthropic/OpenAI 直接拒绝该 tool call = 工具彻底不可用。
 *   2. 参数缺 description(warning):模型不知道该填什么 → 误用 = 不精准。
 *   3. 参数缺 type/enum(warning):类型不明确 → 模型可能填错形状。
 *
 * 只巡检顶层 properties(function-calling 参数惯例为扁平对象;与探针口径一致)。绝不抛。
 *   1. 悬垂 required(error)、2. 缺 description(warning)、3. 缺 type/enum(warning)、
 *   4. required 却带 default(warning:default 永不生效 → 死默认值 + 误导模型)、
 *   5. array 却无 items(warning:元素类型不明 → 模型易填错元素形状)。
 * @param {object} tool
 * @param {Array} out
 */
function _auditParams(tool, out) {
  if (!tool || typeof tool !== 'object' || !_isFn(tool.toFunctionDef)) return;
  let def;
  try { def = tool.toFunctionDef(); } catch { return; } // schema 抛异常已由 _auditShape 记 error
  const label = _s(tool.name) || '(unnamed)';
  const p = def && def.parameters;
  if (!p || typeof p !== 'object' || !p.properties || typeof p.properties !== 'object') return;
  const props = p.properties;
  const propKeys = Object.keys(props);
  const req = Array.isArray(p.required) ? p.required : [];

  for (const r of req) {
    if (!propKeys.includes(_s(r) || r)) {
      out.push({ severity: 'error', rule: 'param', tool: label, message: `required '${r}' 不在 properties 中(悬垂必填 → 该 tool call 被 API 拒绝)` });
    }
  }
  for (const k of propKeys) {
    const spec = props[k] && typeof props[k] === 'object' ? props[k] : {};
    const hasDesc = typeof spec.description === 'string' && spec.description.trim();
    const hasType = spec.type || spec.enum || spec.oneOf || spec.anyOf || spec.allOf || spec['$ref'];
    if (!hasDesc) out.push({ severity: 'warning', rule: 'param', tool: label, message: `参数 '${k}' 缺 description(模型难以正确填写)` });
    if (!hasType) out.push({ severity: 'warning', rule: 'param', tool: label, message: `参数 '${k}' 缺 type/enum(类型不明确)` });
    // required + default 矛盾:必填 → 模型每次都得给 → default 永不生效 = 死默认值 + 误导
    // 「有默认所以可选?」。要么设为可选让 default 生效,要么删掉误导性的 default。
    if (req.includes(k) && spec.default !== undefined) {
      out.push({ severity: 'warning', rule: 'param', tool: label, message: `参数 '${k}' 为 required 却带 default ${JSON.stringify(spec.default)}(default 永不生效 → 应设为可选或删除 default)` });
    }
    // type:'array' 却无 items → 元素类型不明,模型不知该填字符串数组还是对象数组 → 易填错元素形状。
    if (spec.type === 'array' && spec.items === undefined) {
      out.push({ severity: 'warning', rule: 'param', tool: label, message: `参数 '${k}' 为 array 却无 items(元素类型不明 → 模型易填错元素形状)` });
    }
  }
}

/**
 * 审计整个工具注册表。纯函数、确定性、绝不抛。
 *
 * @param {object} [deps] 依赖注入(测试用);缺省惰性 require 注册表与 SSOT 常量。
 * @param {function} [deps.getAll] 返回 Map<name,tool>|Array（注册表 getAll）
 * @param {object}   [deps.CATEGORIES] 覆盖 CATEGORIES SSOT
 * @param {string[]} [deps.RISK_LEVELS] 覆盖 RISK_LEVELS SSOT
 * @param {object} [env]
 * @returns {{findings:Array, errors:number, warnings:number, total:number}}
 */
function auditTools(deps = {}, env = process.env) {
  const empty = { findings: [], errors: 0, warnings: 0, total: 0 };
  if (!toolContractEnabled(env)) return empty;

  let tools = [];
  try {
    const getAll = (deps && _isFn(deps.getAll)) ? deps.getAll : require('../../tools').getAll;
    const map = getAll();
    if (map && typeof map.values === 'function') tools = Array.from(map.values());
    else if (Array.isArray(map)) tools = map;
    else tools = [];
  } catch { return empty; }

  const ctx = { categories: _resolveCategories(deps), risks: _resolveRiskLevels(deps) };
  const findings = [];

  for (const tool of tools) {
    try { _auditShape(tool, ctx, findings); }
    catch (e) {
      findings.push({ severity: 'error', rule: 'shape', tool: _s(tool && tool.name) || '(unknown)', message: `审计抛异常: ${e && e.message}` });
    }
  }
  // 参数级审计(子门控 KHY_TOOL_PARAM_AUDIT 默认开;关 → 逐字节回退未加此层前的 finding 集)。
  if (paramAuditEnabled(env)) {
    for (const tool of tools) {
      try { _auditParams(tool, findings); }
      catch { /* fail-soft:参数巡检异常不阻断 */ }
    }
  }
  try { _auditCollisions(tools, findings); } catch { /* fail-soft:冲突巡检异常不阻断 */ }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { findings, errors, warnings, total: tools.length };
}

module.exports = {
  toolContractEnabled,
  paramAuditEnabled,
  auditTools,
  _toolKey,
  _auditShape,
  _auditParams,
  _auditCollisions,
};
