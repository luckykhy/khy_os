'use strict';

/**
 * tomlLiteFormat — 纯叶子:tomlLite 的**写入侧**(对象 → TOML 文本)。
 *
 * 从 tomlLite.js 行为保真抽出的 stringify/emit 族。与读取侧(parse/value 解析)
 * 零共享:本文件只依赖 utils/isPlainObject 与自身函数,不引用 tomlLite.js 的
 * 任何符号,故无反向边、不成环。tomlLite.js 重新 require 并再导出 `stringify`,
 * 公共面(parse/stringify)与抽取前逐字节一致。
 *
 * 覆盖/不支持的子集见 tomlLite.js 顶部契约注释;此处仅为其写入侧实现。
 */

// 收敛到 utils/isPlainObject 单一真源(逐字节委托,调用点不变)
const _isPlainObject = require('../../../../utils/isPlainObject');

function _formatScalar(v) {
  if (typeof v === 'string') {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v);
  }
  throw new Error(`tomlLite: cannot stringify scalar: ${String(v)}`);
}

function _formatArray(arr) {
  return `[${arr
    .map((v) => {
      if (_isPlainObject(v) || Array.isArray(v)) {
        throw new Error('tomlLite: nested/table arrays unsupported');
      }
      return _formatScalar(v);
    })
    .join(', ')}]`;
}

/**
 * 对象 → TOML 文本。顺序:先写当前层标量/数组,再写子表([t]),再写表数组([[t]])。
 * @param {object} obj
 * @returns {string}
 */
function stringify(obj) {
  if (!_isPlainObject(obj)) {
    throw new Error('tomlLite: stringify expects a plain object');
  }
  return _emitTable(obj, [])
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
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
  stringify,
};
