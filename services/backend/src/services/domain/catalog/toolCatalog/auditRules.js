'use strict';

/**
 * auditRules.js — per-tool contract audit rule family (pure, deterministic, never-throws).
 *
 * The three `_audit*` routines moved verbatim from toolContract.js: they read only
 * their (tool, ctx, out) arguments + the two string utils, never call back into the
 * orchestrator. Host re-requires these and re-exports them under the same names.
 */

// 收敛到 utils 单一真源(逐字节委托,调用点不变)
const _toolKey = require('../../../../utils/normalizeAlnumKey');
const _s = require('../../../../utils/trimIfString');

function _isFn(v) {
  return typeof v === 'function';
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
  if (!name) {
    out.push({ severity: 'error', rule, tool: label, message: 'name 缺失或非字符串' });
  }
  if (!_s(tool.description)) {
    out.push({ severity: 'error', rule, tool: label, message: 'description 缺失或为空' });
  }

  const cat = _s(tool.category);
  const catKeys =
    ctx.categories && typeof ctx.categories === 'object' ? Object.keys(ctx.categories) : [];
  if (catKeys.length && !catKeys.includes(cat)) {
    out.push({
      severity: 'error',
      rule,
      tool: label,
      message: `category '${cat || '(空)'}' 不在 CATEGORIES 内`,
    });
  }
  const risk = _s(tool.risk);
  if (ctx.risks.length && !ctx.risks.includes(risk)) {
    out.push({
      severity: 'error',
      rule,
      tool: label,
      message: `risk '${risk || '(空)'}' 不在 RISK_LEVELS 内`,
    });
  }

  // 行为字段应为函数（注册表工具由 defineTool/BaseTool 挂成方法）。
  for (const fnField of [
    'toFunctionDef',
    'validate',
    'execute',
    'isReadOnly',
    'isDestructive',
    'isEnabled',
  ]) {
    if (!_isFn(tool[fnField])) {
      out.push({ severity: 'error', rule, tool: label, message: `${fnField} 应为函数` });
    }
  }

  // schema:toFunctionDef() 产出合法 function-calling 定义。
  if (_isFn(tool.toFunctionDef)) {
    let def;
    try {
      def = tool.toFunctionDef();
    } catch (e) {
      out.push({
        severity: 'error',
        rule: 'schema',
        tool: label,
        message: `toFunctionDef() 抛异常: ${e && e.message}`,
      });
      return;
    }
    if (!def || typeof def !== 'object') {
      out.push({
        severity: 'error',
        rule: 'schema',
        tool: label,
        message: 'toFunctionDef() 未返回对象',
      });
      return;
    }
    if (!_s(def.name)) {
      out.push({
        severity: 'error',
        rule: 'schema',
        tool: label,
        message: 'toFunctionDef().name 缺失',
      });
    }
    if (typeof def.description !== 'string') {
      out.push({
        severity: 'error',
        rule: 'schema',
        tool: label,
        message: 'toFunctionDef().description 非字符串',
      });
    }
    const p = def.parameters;
    if (
      !p ||
      typeof p !== 'object' ||
      p.type !== 'object' ||
      !p.properties ||
      typeof p.properties !== 'object'
    ) {
      out.push({
        severity: 'error',
        rule: 'schema',
        tool: label,
        message: "toFunctionDef().parameters 非 {type:'object', properties:{…}}",
      });
    } else if (p.required !== undefined && !Array.isArray(p.required)) {
      // required 可为 undefined（无必填参数）；若存在必须是数组。
      out.push({
        severity: 'error',
        rule: 'schema',
        tool: label,
        message: 'toFunctionDef().parameters.required 存在但非数组',
      });
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
    if (!tool || typeof tool !== 'object') {
      continue;
    }
    const name = _s(tool.name);
    if (!name) {
      continue;
    }
    const meta = { category: _s(tool.category), risk: _s(tool.risk) };
    const namesForKeys = [
      name,
      ...(Array.isArray(tool.aliases) ? tool.aliases.map(_s).filter(Boolean) : []),
    ];
    for (const n of namesForKeys) {
      const key = _toolKey(n);
      if (!key) {
        continue;
      }
      if (!owners.has(key)) {
        owners.set(key, new Map());
      }
      // 同一属主对同一键只记一次（name 与其某别名可能归一后相同）。
      const byOwner = owners.get(key);
      if (!byOwner.has(name)) {
        byOwner.set(name, meta);
      }
    }
  }

  // 确定性顺序:按归一键字母序输出。
  for (const key of Array.from(owners.keys()).sort()) {
    const byOwner = owners.get(key);
    if (byOwner.size < 2) {
      continue;
    } // 唯一属主 → 无冲突
    const entries = Array.from(byOwner.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const names = entries.map(([n]) => n);
    const cats = new Set(entries.map(([, m]) => m.category));
    const risks = new Set(entries.map(([, m]) => m.risk));
    const crossRisk = risks.size > 1;
    const crossCat = cats.size > 1;
    const severity = crossRisk || crossCat ? 'error' : 'warning';
    const why =
      crossRisk && crossCat
        ? '跨 risk 且跨 category'
        : crossRisk
          ? '跨 risk'
          : crossCat
            ? '跨 category'
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
  if (!tool || typeof tool !== 'object' || !_isFn(tool.toFunctionDef)) {
    return;
  }
  let def;
  try {
    def = tool.toFunctionDef();
  } catch {
    return;
  } // schema 抛异常已由 _auditShape 记 error
  const label = _s(tool.name) || '(unnamed)';
  const p = def && def.parameters;
  if (!p || typeof p !== 'object' || !p.properties || typeof p.properties !== 'object') {
    return;
  }
  const props = p.properties;
  const propKeys = Object.keys(props);
  const req = Array.isArray(p.required) ? p.required : [];

  for (const r of req) {
    if (!propKeys.includes(_s(r) || r)) {
      out.push({
        severity: 'error',
        rule: 'param',
        tool: label,
        message: `required '${r}' 不在 properties 中(悬垂必填 → 该 tool call 被 API 拒绝)`,
      });
    }
  }
  for (const k of propKeys) {
    const spec = props[k] && typeof props[k] === 'object' ? props[k] : {};
    const hasDesc = typeof spec.description === 'string' && spec.description.trim();
    const hasType =
      spec.type || spec.enum || spec.oneOf || spec.anyOf || spec.allOf || spec['$ref'];
    if (!hasDesc) {
      out.push({
        severity: 'warning',
        rule: 'param',
        tool: label,
        message: `参数 '${k}' 缺 description(模型难以正确填写)`,
      });
    }
    if (!hasType) {
      out.push({
        severity: 'warning',
        rule: 'param',
        tool: label,
        message: `参数 '${k}' 缺 type/enum(类型不明确)`,
      });
    }
    // required + default 矛盾:必填 → 模型每次都得给 → default 永不生效 = 死默认值 + 误导
    // 「有默认所以可选?」。要么设为可选让 default 生效,要么删掉误导性的 default。
    if (req.includes(k) && spec.default !== undefined) {
      out.push({
        severity: 'warning',
        rule: 'param',
        tool: label,
        message: `参数 '${k}' 为 required 却带 default ${JSON.stringify(spec.default)}(default 永不生效 → 应设为可选或删除 default)`,
      });
    }
    // type:'array' 却无 items → 元素类型不明,模型不知该填字符串数组还是对象数组 → 易填错元素形状。
    if (spec.type === 'array' && spec.items === undefined) {
      out.push({
        severity: 'warning',
        rule: 'param',
        tool: label,
        message: `参数 '${k}' 为 array 却无 items(元素类型不明 → 模型易填错元素形状)`,
      });
    }
  }
}

module.exports = { _auditShape, _auditCollisions, _auditParams };
