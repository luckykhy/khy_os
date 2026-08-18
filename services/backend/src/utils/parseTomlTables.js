'use strict';

/**
 * parseTomlTables.js — 容错的 TOML **子集**解析器(纯叶子:零 IO、确定性、绝不抛)。
 *
 * 为什么需要它:khy「蹭生态」要把其他 agent 已配置好的 MCP server 直接拿来用,而生态里
 * 绝大多数 agent 用 JSON/JSON5 存 `mcpServers`,**只有 Codex CLI 用 TOML**:
 *   ~/.codex/config.toml
 *     [mcp_servers.everything]
 *     command = "npx"
 *     args = ["-y", "@modelcontextprotocol/server-everything"]
 *     env = { API_KEY = "x" }
 * 仓库没有 toml 依赖(backend deps 里只有 json5 可解析),为一个只读探测引入运行时依赖不值得,
 * 因此这里实现「够用的子集」:表头 `[a.b.c]` / 表数组 `[[a.b]]` / `key = value`,值支持
 * 字符串(单双引号)、整数/浮点、布尔、数组、单行内联表,以及跨行的数组/内联表续行。
 *
 * **刻意不支持**(遇到即跳过该行,不抛):多行字符串(""" / ''')、日期时间、十六/八/二进制字面量、
 *   下划线数字分隔符、点号键(`a.b = 1` 只当作字面 key)。MCP server 配置里不出现这些形态;
 *   真出现了也只是那一行被忽略,其余键仍可用(fail-soft 优于全盘失败)。
 *
 * 契约:string in → plain object out(整体不可解析或非字符串 → null),不 mutate 入参,绝不抛。
 */

/** 去掉行尾注释:引号外的第一个 # 起截断(引号内的 # 保留)。 */
function _stripComment(line) {
  let out = '';
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === quote && line[i - 1] !== '\\') {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#') {
      break;
    }
    out += ch;
  }
  return out;
}

/** 括号/花括号是否已闭合(用于判断值是否续行)。引号内的括号不计数。 */
function _balanced(text) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
    }
  }
  return depth <= 0;
}

/** 拆表头 `a.b."c d"` → ['a','b','c d']。坏输入 → []。 */
function _splitDotted(text) {
  const parts = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = '';
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '.') {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts.every((p) => p.length > 0) ? parts : [];
}

/** 解析基本字符串字面量,返回 {value, next} 或 null。 */
function _readString(text, start) {
  const quote = text[start];
  let out = '';
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === '"' && ch === '\\') {
      const nx = text[i + 1];
      const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
      out += Object.prototype.hasOwnProperty.call(map, nx) ? map[nx] : nx || '';
      i += 1;
      continue;
    }
    if (ch === quote) {
      return { value: out, next: i + 1 };
    }
    out += ch;
  }
  return null; // 未闭合
}

/** 解析裸标量(number / bool)。无法识别 → 原样字符串(fail-soft)。 */
function _scalar(raw) {
  const t = raw.trim();
  if (t === 'true') {
    return true;
  }
  if (t === 'false') {
    return false;
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  }
  return t;
}

/**
 * 从 text 的 start 处解析一个值。返回 {value, next} 或 null(不可解析)。
 * 支持:字符串、数组、内联表、裸标量。
 */
function _readValue(text, start) {
  let i = start;
  while (i < text.length && /\s/.test(text[i])) {
    i += 1;
  }
  if (i >= text.length) {
    return null;
  }
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    return _readString(text, i);
  }
  if (ch === '[') {
    const arr = [];
    i += 1;
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) {
        i += 1;
      }
      if (i >= text.length) {
        return null;
      }
      if (text[i] === ']') {
        return { value: arr, next: i + 1 };
      }
      const item = _readValue(text, i);
      if (!item) {
        return null;
      }
      arr.push(item.value);
      i = item.next;
    }
  }
  if (ch === '{') {
    const obj = {};
    i += 1;
    for (;;) {
      while (i < text.length && /[\s,]/.test(text[i])) {
        i += 1;
      }
      if (i >= text.length) {
        return null;
      }
      if (text[i] === '}') {
        return { value: obj, next: i + 1 };
      }
      // key
      let key = '';
      if (text[i] === '"' || text[i] === "'") {
        const k = _readString(text, i);
        if (!k) {
          return null;
        }
        key = k.value;
        i = k.next;
      } else {
        const eq = text.indexOf('=', i);
        if (eq < 0) {
          return null;
        }
        key = text.slice(i, eq).trim();
        i = eq;
      }
      while (i < text.length && /\s/.test(text[i])) {
        i += 1;
      }
      if (text[i] !== '=') {
        return null;
      }
      const v = _readValue(text, i + 1);
      if (!v || !key) {
        return null;
      }
      obj[key] = v.value;
      i = v.next;
    }
  }
  // 裸标量:到下一个 , ] } 或行尾
  let end = i;
  while (end < text.length && !',]}'.includes(text[end])) {
    end += 1;
  }
  const raw = text.slice(i, end);
  if (!raw.trim()) {
    return null;
  }
  return { value: _scalar(raw), next: end };
}

/** 沿 path 下钻建对象(缺失即建);任一段非法 → null。 */
function _descend(root, segs) {
  let node = root;
  for (const seg of segs) {
    if (!seg) {
      return null;
    }
    if (!node[seg] || typeof node[seg] !== 'object') {
      node[seg] = {};
    } else if (Array.isArray(node[seg])) {
      node[seg] = node[seg][node[seg].length - 1]; // 表数组:落到最后一个元素
    }
    node = node[seg];
  }
  return node;
}

/**
 * 解析 TOML 文本为普通对象。
 *
 * @param {string} text 文件内容(壳负责 fs 读取)
 * @returns {object|null} 解析结果;入参非字符串/整体失败 → null。无法识别的单行被跳过。
 */
function parseTomlTables(text) {
  try {
    if (typeof text !== 'string' || !text.trim()) {
      return null;
    }
    const root = {};
    let current = root;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      let line = _stripComment(lines[i]).trim();
      if (!line) {
        continue;
      }
      // 表数组 [[a.b]]
      if (line.startsWith('[[') && line.endsWith(']]')) {
        const segs = _splitDotted(line.slice(2, -2).trim());
        if (!segs.length) {
          current = {}; // 坏表头:后续键写进弃用对象,不污染 root
          continue;
        }
        const parentSegs = segs.slice(0, -1);
        const leaf = segs[segs.length - 1];
        const parent = _descend(root, parentSegs);
        if (!parent) {
          current = {};
          continue;
        }
        if (!Array.isArray(parent[leaf])) {
          parent[leaf] = [];
        }
        const entry = {};
        parent[leaf].push(entry);
        current = entry;
        continue;
      }
      // 表头 [a.b]
      if (line.startsWith('[') && line.endsWith(']')) {
        const segs = _splitDotted(line.slice(1, -1).trim());
        const node = segs.length ? _descend(root, segs) : null;
        current = node || {};
        continue;
      }
      // key = value(值可能跨行:数组/内联表未闭合时并入下一行)
      const eq = line.indexOf('=');
      if (eq < 0) {
        continue;
      }
      while (!_balanced(line) && i + 1 < lines.length) {
        i += 1;
        line += ' ' + _stripComment(lines[i]).trim();
      }
      const rawKey = line.slice(0, eq).trim();
      const keySegs = _splitDotted(rawKey);
      if (!keySegs.length) {
        continue;
      }
      const parsed = _readValue(line, eq + 1);
      if (!parsed) {
        continue; // 不支持的形态(多行字符串/日期等)→ 跳过该键
      }
      const target = keySegs.length > 1 ? _descend(current, keySegs.slice(0, -1)) : current;
      if (!target) {
        continue;
      }
      target[keySegs[keySegs.length - 1]] = parsed.value;
    }
    return root;
  } catch {
    return null;
  }
}

module.exports = parseTomlTables;
