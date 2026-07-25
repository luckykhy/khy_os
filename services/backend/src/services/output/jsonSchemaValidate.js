'use strict';

/**
 * jsonSchemaValidate.js — 结构化输出「按调用方 JSON Schema 校验」的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用、零依赖;只读入参,绝不读 process.env。
 *
 * 背后的逻辑(对齐 Claude Code StructuredOutput / SyntheticOutputTool 的 Ajv 校验):非交互
 * (headless `khy -p --output-format json`)模式下,调用方可给一份 JSON Schema,要求模型把
 * 最终答复**严格按该 schema** 产出;本叶子就是那把「数据 ⊨ schema?」的尺子。CC 用 ajv;为不引入新
 * 依赖(供应链面)且守住纯叶子纪律,这里实现一个**确定性递归子集校验器**(零依赖),覆盖结构化输出
 * 实务最常用的关键字。命中失败时返回带 JSON-Pointer 路径的可读错误,供模型自纠。
 *
 * 支持的关键字(子集,足够约束 LLM 结构化输出):
 *   type(string|number|integer|boolean|object|array|null,可为数组联合)、enum、const、
 *   properties、required、additionalProperties(bool 或 schema)、items(单 schema)、
 *   minLength/maxLength、pattern、minimum/maximum/exclusiveMinimum/exclusiveMaximum、
 *   minItems/maxItems、uniqueItems、anyOf/oneOf/allOf、nullable(OpenAPI 习惯)。
 * 刻意不实现:$ref/$defs 解引用、format 语义校验、dependentSchemas、if/then/else
 *   ——超出「约束最终输出」实务且引入状态/递归解析复杂度,留作诚实边界。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器误判幽灵依赖。
 */

const _MAX_DEPTH = 64; // 防御性递归深度上限(病态/自引用 schema 不致爆栈)。

function _typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // string|number|boolean|object|undefined
}

/** JSON Schema 的 type 判定(integer 与 number 区分)。 */
function _matchesType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    default: return true; // 未知 type 不约束(宽松,绝不假阳性拒)。
  }
}

function _deepEqual(a, b) {
  if (a === b) return true;
  if (_typeOf(a) !== _typeOf(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!_deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (a && typeof a === 'object') {
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k)) return false; if (!_deepEqual(a[k], b[k])) return false; }
    return true;
  }
  return false;
}

function _join(path, seg) { return `${path}/${String(seg)}`; }

/**
 * 递归校验 value 是否满足 schema,把错误推入 errors。
 * @returns {boolean} 本节点(及子树)是否全部通过
 */
function _validate(value, schema, path, errors, depth) {
  if (depth > _MAX_DEPTH) return true; // 过深则停止(诚实放行,避免栈溢出)。
  if (schema === true || schema === undefined || schema === null) return true;
  if (schema === false) { errors.push({ path, message: 'value is not allowed (schema=false)' }); return false; }
  if (typeof schema !== 'object') return true;

  let ok = true;
  const push = (message) => { ok = false; errors.push({ path, message }); };

  // nullable(OpenAPI):显式允许 null。
  if (value === null && schema.nullable === true) return true;

  // type(可为数组联合)。
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => _matchesType(value, t))) {
      push(`expected type ${types.join('|')} but got ${_typeOf(value)}`);
      return ok; // 类型不符则不再深入(避免连锁误报)。
    }
  }

  // const / enum。
  if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
    if (!_deepEqual(value, schema.const)) push(`value must equal const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => _deepEqual(value, e))) push(`value must be one of enum ${JSON.stringify(schema.enum)}`);
  }

  // 组合关键字。
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) if (!_validate(value, sub, path, errors, depth + 1)) ok = false;
  }
  if (Array.isArray(schema.anyOf)) {
    const any = schema.anyOf.some((sub) => _validate(value, sub, path, [], depth + 1));
    if (!any) push('value does not match any of the anyOf schemas');
  }
  if (Array.isArray(schema.oneOf)) {
    let matched = 0;
    for (const sub of schema.oneOf) if (_validate(value, sub, path, [], depth + 1)) matched++;
    if (matched !== 1) push(`value must match exactly one of oneOf (matched ${matched})`);
  }

  // 字符串约束。
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) push(`string shorter than minLength ${schema.minLength}`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) push(`string longer than maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === 'string') {
      let re = null; try { re = new RegExp(schema.pattern); } catch { re = null; }
      if (re && !re.test(value)) push(`string does not match pattern ${schema.pattern}`);
    }
  }

  // 数值约束。
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) push(`number below minimum ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) push(`number above maximum ${schema.maximum}`);
    if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) push(`number must be > exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) push(`number must be < exclusiveMaximum ${schema.exclusiveMaximum}`);
  }

  // 数组约束。
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) push(`array shorter than minItems ${schema.minItems}`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) push(`array longer than maxItems ${schema.maxItems}`);
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) for (let j = i + 1; j < value.length; j++) {
        if (_deepEqual(value[i], value[j])) { push(`array items must be unique (indices ${i},${j})`); i = value.length; break; }
      }
    }
    if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      for (let i = 0; i < value.length; i++) if (!_validate(value[i], schema.items, _join(path, i), errors, depth + 1)) ok = false;
    }
  }

  // 对象约束。
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) push(`missing required property "${key}"`);
      }
    }
    for (const key of Object.keys(props)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        if (!_validate(value[key], props[key], _join(path, key), errors, depth + 1)) ok = false;
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) push(`additional property "${key}" is not allowed`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          if (!_validate(value[key], schema.additionalProperties, _join(path, key), errors, depth + 1)) ok = false;
        }
      }
    }
  }

  return ok;
}

/**
 * 校验数据是否满足 JSON Schema 子集。纯函数,绝不抛。
 * @param {*} data    待校验数据
 * @param {object} schema  JSON Schema(子集)
 * @returns {{ valid:boolean, errors:Array<{path:string,message:string}> }}
 */
function validateAgainstSchema(data, schema) {
  const errors = [];
  // 布尔 schema 是合法 JSON Schema:true=放行一切、false=拒绝一切(交给 _validate 处理)。
  if (typeof schema !== 'boolean' && (!schema || typeof schema !== 'object')) {
    // 无 schema(null/undefined/非对象)→ 不约束:视为通过(pass-through,对齐 CC 基础工具无 schema 即原样返回)。
    return { valid: true, errors };
  }
  let valid = true;
  try {
    valid = _validate(data, schema, '', errors, 0);
  } catch {
    // 防御:病态 schema 不应让校验器自身抛 —— 退化为「未校验通过」并记一条诚实错误。
    return { valid: false, errors: [{ path: '', message: 'schema validation aborted (malformed schema)' }] };
  }
  return { valid: valid && errors.length === 0, errors };
}

/** 把错误数组拼成模型可读的一行(供自纠提示)。 */
function formatSchemaErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  return errors.map((e) => `${e && e.path ? e.path : 'root'}: ${e && e.message ? e.message : 'invalid'}`).join('; ');
}

module.exports = { validateAgainstSchema, formatSchemaErrors };
