'use strict';

/**
 * tomlLite — 纯叶子:零依赖、确定性、fail-soft 的 TOML 读写子集,专供外部 app 配置
 * (DeepSeek-Reasonix `~/.reasonix/config.toml`、DeepSeek-TUI `~/.deepseek/config.toml`)。
 *
 * 为什么手写而非引依赖:后端未安装任何 TOML 库(仅 root 有 js-yaml/ini),而这两个 app 的
 * 配置只用到 TOML 的一个**小而明确的子集**。与其拖入一整个 TOML 解析器,不如覆盖实测样例
 * 里出现的全部构造,并对**未知构造显式抛错**(由调用方 adapter fail-soft 接住),避免误解析
 * 出错值静默写坏用户配置。
 *
 * 覆盖的子集(实证自 Reasonix CONFIG_PATHS.md 与 DeepSeek-TUI config.example.toml):
 *   - 顶层标量:  key = "str" | key = 123 | key = true | key = 1.5
 *   - 字符串数组: key = ["a", "b"]  (也容忍数字数组)
 *   - 行内注释:  key = "v"   # comment   与整行 # comment
 *   - 具名表:    [ui]            → obj.ui = { ... }
 *   - 点分表名:  [providers.deepseek] → obj.providers.deepseek = { ... }
 *   - 表数组:    [[providers]]   → obj.providers = [ { ... }, ... ]
 *   - 行内表:    key = { a = "x", b = 1 }  (parse 支持;stringify 用多行表,不产行内表)
 *
 * 明确**不支持**(遇到即抛,不猜):多行字符串、日期时间、嵌套数组、混合类型数组、
 * 带引号的键名里含点、`+`/下划线数字字面量的完整校验。这些在目标 app 配置中不出现。
 *
 * 契约:parse/stringify 均确定性;parse 对无法识别的行抛清晰 Error;stringify 对无法表达的
 * 值抛清晰 Error。调用方负责 try/catch。round-trip 对本子集内的对象保持字段等价。
 */

// ── 值解析 ───────────────────────────────────────────────────────────────────

/** 去掉一行末尾的行内注释(但不动引号字符串内部的 #)。返回去注释后的行(未 trim 尾部)。 */
function _stripInlineComment(line) {
  let inStr = false;
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inStr) {
      if (ch === quote && line[i - 1] !== '\\') inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** 解析单个标量/数组/行内表值。抛错 = 无法识别。 */
function _parseValue(raw) {
  const s = String(raw).trim();
  if (s === '') throw new Error('tomlLite: empty value');

  // 字符串(双引号或单引号)。
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
    return _parseString(s);
  }
  // 数组。
  if (s[0] === '[') {
    if (s[s.length - 1] !== ']') throw new Error(`tomlLite: unterminated array: ${s}`);
    return _parseArray(s);
  }
  // 行内表。
  if (s[0] === '{') {
    if (s[s.length - 1] !== '}') throw new Error(`tomlLite: unterminated inline table: ${s}`);
    return _parseInlineTable(s);
  }
  // 布尔。
  if (s === 'true') return true;
  if (s === 'false') return false;
  // 数字(整数 / 浮点)。
  if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[+-]?\d*\.\d+$/.test(s)) return parseFloat(s);
  throw new Error(`tomlLite: unrecognized value: ${s}`);
}

function _parseString(s) {
  const body = s.slice(1, -1);
  if (s[0] === "'") return body; // 字面字符串:不转义
  // 基本字符串:处理常见转义。
  return body.replace(/\\(["\\ntr])/g, (_m, c) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '"': return '"';
      case '\\': return '\\';
      default: return c;
    }
  });
}

/** 拆分顶层逗号(不切引号/括号内的逗号)。用于数组与行内表。 */
function _splitTopLevel(inner) {
  const parts = [];
  let depth = 0;
  let inStr = false;
  let quote = '';
  let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inStr) {
      cur += ch;
      if (ch === quote && inner[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') { depth += 1; cur += ch; continue; }
    if (ch === ']' || ch === '}') { depth -= 1; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function _parseArray(s) {
  const inner = s.slice(1, -1).trim();
  if (inner === '') return [];
  return _splitTopLevel(inner).map((p) => _parseValue(p.trim()));
}

function _parseInlineTable(s) {
  const inner = s.slice(1, -1).trim();
  const obj = {};
  if (inner === '') return obj;
  for (const pair of _splitTopLevel(inner)) {
    const eq = _findAssignEq(pair);
    if (eq === -1) throw new Error(`tomlLite: bad inline-table entry: ${pair}`);
    const key = _parseKey(pair.slice(0, eq).trim());
    obj[key] = _parseValue(pair.slice(eq + 1).trim());
  }
  return obj;
}

/** 找到键/值分隔的 `=`(跳过引号内)。 */
function _findAssignEq(line) {
  let inStr = false;
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inStr) {
      if (ch === quote && line[i - 1] !== '\\') inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
    } else if (ch === '=') {
      return i;
    }
  }
  return -1;
}

/** 键名:裸键或带引号键。 */
function _parseKey(raw) {
  const s = String(raw).trim();
  if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) {
    return _parseString(s);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error(`tomlLite: bad key: ${s}`);
  return s;
}

/** 拆点分表名 `a.b.c` → ['a','b','c'](跳过引号内的点)。 */
function _splitDottedKey(name) {
  const parts = [];
  let inStr = false;
  let quote = '';
  let cur = '';
  for (let i = 0; i < name.length; i += 1) {
    const ch = name[i];
    if (inStr) {
      cur += ch;
      if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; cur += ch; continue; }
    if (ch === '.') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => _parseKey(p.trim()));
}

// ── parse ────────────────────────────────────────────────────────────────────

/**
 * TOML 文本 → 对象。抛错 = 遇到本子集无法识别的构造。
 * @param {string} text
 * @returns {object}
 */
function parse(text) {
  const root = {};
  let cursor = root; // 当前表(键值对落入此对象)
  const src = String(text == null ? '' : text);
  const lines = src.split(/\r?\n/);

  for (let ln = 0; ln < lines.length; ln += 1) {
    const rawLine = _stripInlineComment(lines[ln]);
    const line = rawLine.trim();
    if (line === '') continue;

    // 表数组 [[a.b]]
    if (line.startsWith('[[') && line.endsWith(']]')) {
      const name = line.slice(2, -2).trim();
      const path = _splitDottedKey(name);
      cursor = _enterArrayTable(root, path);
      continue;
    }
    // 具名表 [a.b]
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      const path = _splitDottedKey(name);
      cursor = _enterTable(root, path);
      continue;
    }
    // 键值对
    const eq = _findAssignEq(line);
    if (eq === -1) throw new Error(`tomlLite: cannot parse line ${ln + 1}: ${lines[ln]}`);
    const keyPath = _splitDottedKey(line.slice(0, eq).trim());
    const value = _parseValue(line.slice(eq + 1).trim());
    _assignDotted(cursor, keyPath, value);
  }
  return root;
}

/** 进入(必要时创建)具名表,返回该表对象。 */
function _enterTable(root, path) {
  let node = root;
  for (const key of path) {
    if (node[key] === undefined) node[key] = {};
    else if (Array.isArray(node[key])) node = node[key][node[key].length - 1]; // 落到最后一个表数组元素
    if (node[key] !== undefined && !Array.isArray(node[key])) node = node[key];
  }
  return node;
}

/** 进入(必要时创建)表数组,追加一个新元素并返回它。 */
function _enterArrayTable(root, path) {
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (node[key] === undefined) node[key] = {};
    node = Array.isArray(node[key]) ? node[key][node[key].length - 1] : node[key];
  }
  const last = path[path.length - 1];
  if (node[last] === undefined) node[last] = [];
  if (!Array.isArray(node[last])) throw new Error(`tomlLite: ${last} redefined as array-of-tables`);
  const elem = {};
  node[last].push(elem);
  return elem;
}

/** 在 cursor 里按点分键写值(点分键在表内少见但合法)。 */
function _assignDotted(cursor, keyPath, value) {
  let node = cursor;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i];
    if (node[key] === undefined) node[key] = {};
    node = node[key];
  }
  node[keyPath[keyPath.length - 1]] = value;
}

// ── stringify ────────────────────────────────────────────────────────────────

// 收敛到 utils/isPlainObject 单一真源(逐字节委托,调用点不变)
const _isPlainObject = require('../../utils/isPlainObject');

function _formatScalar(v) {
  if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new Error(`tomlLite: cannot stringify scalar: ${String(v)}`);
}

function _formatArray(arr) {
  return `[${arr.map((v) => {
    if (_isPlainObject(v) || Array.isArray(v)) throw new Error('tomlLite: nested/table arrays unsupported');
    return _formatScalar(v);
  }).join(', ')}]`;
}

/**
 * 对象 → TOML 文本。顺序:先写当前层标量/数组,再写子表([t]),再写表数组([[t]])。
 * @param {object} obj
 * @returns {string}
 */
function stringify(obj) {
  if (!_isPlainObject(obj)) throw new Error('tomlLite: stringify expects a plain object');
  return _emitTable(obj, []).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '\n');
}

function _emitTable(obj, path) {
  let out = '';
  const scalars = [];
  const subTables = [];
  const arrayTables = [];

  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (Array.isArray(v) && v.length > 0 && v.every(_isPlainObject)) {
      arrayTables.push(key);
    } else if (_isPlainObject(v)) {
      subTables.push(key);
    } else {
      scalars.push(key);
    }
  }

  for (const key of scalars) {
    const v = obj[key];
    const rhs = Array.isArray(v) ? _formatArray(v) : _formatScalar(v);
    out += `${_emitKey(key)} = ${rhs}\n`;
  }

  for (const key of subTables) {
    const childPath = path.concat(key);
    out += `\n[${childPath.map(_emitKey).join('.')}]\n`;
    out += _emitTable(obj[key], childPath);
  }

  for (const key of arrayTables) {
    const childPath = path.concat(key);
    for (const elem of obj[key]) {
      out += `\n[[${childPath.map(_emitKey).join('.')}]]\n`;
      out += _emitTable(elem, childPath);
    }
  }
  return out;
}

function _emitKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : `"${String(key).replace(/"/g, '\\"')}"`;
}

module.exports = {
  parse,
  stringify,
};
