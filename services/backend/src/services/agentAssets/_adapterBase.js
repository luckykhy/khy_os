'use strict';

/**
 * _adapterBase.js — 三个外部 agent 资产适配器的公共底座(薄 IO 层)。
 *
 * 只放**跨适配器复用**的确定性小工具:资产根目录探测(带「找过哪些位置」清单)、
 * markdown frontmatter 解析/序列化、有界目录遍历、原子读写、mtime 取时间戳。
 * 任何一家的私有格式知识都不在这里——那属于各自的 adapters/<id>.js。
 *
 * 文件读写刻意复用 externalApps/_shared 的 readIfExists/atomicWrite/expandHome:
 * 那三个原语已是本仓「读外部 app 配置」的既有单一真源(atomicWrite 走同目录 temp +
 * rename,避免半截文件写坏别人的配置)。agentFs/agentFsService 不适合复用——它是
 * khy **自己**的 per-agent 存储(固定 ASSET_FILES + 内建 git 快照),没有通用
 * 读写原语可借。
 *
 * fail-soft 分层:本层的每个函数要么返回值要么返回 null/空数组,绝不抛;
 * 需要区分「不存在」与「读坏了」的地方由调用方按返回值判定。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../externalApps/_shared');

/** 单次遍历的硬上界:防止某家工具的资产目录里躺着一整个 node_modules。 */
const WALK_MAX_DEPTH = 6;
const WALK_MAX_FILES = 2000;

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.cache',
  'dist',
  'build',
  '__pycache__',
  'coverage',
]);

/** 展开前导 ~(委托 externalApps/_shared 单一真源)。 */
function expandHome(p, env) {
  return S.expandHome(p, env || process.env);
}

/**
 * 资产根目录探测。env 覆盖优先级**高于**所有默认候选(硬要求),命中即返回,
 * 且无论成败都回报「找过哪些位置」——只说「未找到」的报错让用户无从下手。
 *
 * @param {object} opts
 * @param {string[]} opts.envKeys 覆盖用的环境变量名(按优先级排列,第一个命中即用)
 * @param {Array<{ path: string, why: string }>} opts.candidates 默认候选(按优先级)
 * @param {Record<string,string>} [opts.env]
 * @returns {{ ok: true, root: string, via: string, checked: Array<object> }
 *          | { ok: false, error: string, checked: Array<object> }}
 */
function probeRoot(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const envKeys = Array.isArray(o.envKeys) ? o.envKeys : [];
  const candidates = Array.isArray(o.candidates) ? o.candidates : [];
  const checked = [];

  for (const key of envKeys) {
    const raw = env && env[key];
    if (!raw) {
      checked.push({ location: `$${key}`, exists: false, why: '环境变量未设置' });
      continue;
    }
    const resolved = expandHome(String(raw).trim(), env);
    const exists = _isDir(resolved);
    checked.push({ location: resolved, exists, why: `环境变量 ${key} 覆盖` });
    if (exists) {
      return { ok: true, root: resolved, via: `env:${key}`, checked };
    }
    // 覆盖变量指了一个不存在的目录 → 明确报错,不静默回退到默认路径:
    // 用户显式指定过位置,悄悄换地方写比报错更糟。
    return {
      ok: false,
      error: `环境变量 ${key} 指向的目录不存在:${resolved}`,
      checked,
    };
  }

  for (const cand of candidates) {
    const p = expandHome(String((cand && cand.path) || '').trim(), env);
    if (!p) {
      continue;
    }
    const exists = _isDir(p);
    checked.push({ location: p, exists, why: (cand && cand.why) || '默认候选位置' });
    if (exists) {
      return { ok: true, root: p, via: 'default', checked };
    }
  }

  // 报错要说清「找了哪些位置」:目录候选与「没设的环境变量」分开列,
  // 否则把 $VAR 混进目录清单会让「已查找 N 处」这个数字失去意义。
  const dirs = checked.filter((c) => !String(c.location).startsWith('$')).map((c) => c.location);
  const unsetVars = checked
    .filter((c) => String(c.location).startsWith('$'))
    .map((c) => String(c.location).slice(1));
  const parts = [`未检测到该工具的资产目录。已查找 ${dirs.length} 处目录:${dirs.join('、') || '(无候选)'}`];
  if (unsetVars.length) {
    parts.push(`可用环境变量 ${unsetVars.join(' / ')} 显式指定资产根`);
  }
  return { ok: false, error: parts.join('；'), checked };
}

function _isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 目录是否存在(供适配器判断某个资产子目录在不在)。 */
function isDir(p) {
  return _isDir(p);
}

/** 文件是否存在。 */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 用户主目录(适配器构造默认候选用,绝不写死盘符/用户名)。 */
function homeDir(env) {
  const e = env || process.env;
  return (e && e.HOME) || os.homedir();
}

/** XDG 配置根:$XDG_CONFIG_HOME,回退 ~/.config。 */
function xdgConfigHome(env) {
  const e = env || process.env;
  return (e && e.XDG_CONFIG_HOME) || path.join(homeDir(e), '.config');
}

/** 读文本;不存在或读失败返 null。 */
function readText(file) {
  try {
    return S.readIfExists(file);
  } catch {
    return null;
  }
}

/** 读 JSON;不存在返 null,存在但解析失败返 { _parseError }。容忍 UTF-8 BOM。 */
function readJson(file) {
  const text = readText(file);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    return { _parseError: (e && e.message) || String(e) };
  }
}

/** 原子写文本(建父目录 + 同目录 temp + rename)。成功返 true。 */
function writeText(file, content) {
  try {
    S.atomicWrite(file, content);
    return true;
  } catch {
    return false;
  }
}

/** 删文件;不存在也算成功。 */
function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 递归删目录;不存在也算成功。 */
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 文件 mtime 的 ISO 串;取不到返 ''。 */
function mtimeIso(file) {
  try {
    return fs.statSync(file).mtime.toISOString();
  } catch {
    return '';
  }
}

/** 绝对路径 → 相对 root 的 POSIX 相对路径(IR 里只存相对路径)。 */
function toRelPath(root, file) {
  try {
    return path.relative(root, file).split(path.sep).join('/');
  } catch {
    return '';
  }
}

/**
 * 有界递归遍历。返回相对 root 的 POSIX 路径数组(排序,确定性)。
 * 越界(深度/文件数)时静默停在上界——适配器的 list* 是「发现」语义,不是备份工具。
 *
 * @param {string} root
 * @param {{ exts?: string[], maxDepth?: number, maxFiles?: number }} [opts]
 * @returns {string[]}
 */
function walkFiles(root, opts) {
  const o = opts || {};
  const exts = Array.isArray(o.exts) && o.exts.length ? o.exts.map((e) => e.toLowerCase()) : null;
  const maxDepth = Number.isFinite(o.maxDepth) ? o.maxDepth : WALK_MAX_DEPTH;
  const maxFiles = Number.isFinite(o.maxFiles) ? o.maxFiles : WALK_MAX_FILES;
  const out = [];

  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) {
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) {
        return;
      }
      if (entry.name.startsWith('.') && entry.isDirectory()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) {
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (exts && !exts.includes(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const rel = toRelPath(root, full);
      if (rel) {
        out.push(rel);
      }
    }
  };

  walk(root, 0);
  return out.sort();
}

// ── markdown frontmatter ────────────────────────────────────────────────
// 三家的记忆/技能都是「YAML frontmatter + markdown 正文」。这里只支持
// **标量与单行字符串数组**两种值形态——够覆盖 name/description/tags,
// 且解析不出的整块 frontmatter 会原样落进 IR 的 raw.frontmatterText,
// 序列化时优先回吐原文,故往返无损(不会因为解析器弱而丢字段)。

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * 解析 frontmatter。
 * @param {string} text
 * @returns {{ data: Record<string,any>, body: string, raw: string, parsed: boolean }}
 */
function parseFrontmatter(text) {
  const src = typeof text === 'string' ? text : '';
  const m = src.match(FRONTMATTER_RE);
  if (!m) {
    return { data: {}, body: src, raw: '', parsed: false };
  }
  const raw = m[1];
  const body = src.slice(m[0].length);
  const data = {};
  let parsed = true;

  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kv) {
      parsed = false;
      i += 1;
      continue;
    }
    const key = kv[1];
    const inline = kv[2].trim();
    if (inline) {
      data[key] = _scalar(inline);
      i += 1;
      continue;
    }
    // 块形态:紧随其后的 `- item` 视为数组;`  key: value` 视为嵌套映射。
    const items = [];
    const nested = {};
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) {
      const item = lines[j].trim();
      if (item.startsWith('- ')) {
        items.push(_scalar(item.slice(2).trim()));
      } else {
        const nkv = item.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
        if (nkv && nkv[2].trim()) {
          nested[nkv[1]] = _scalar(nkv[2].trim());
        } else {
          parsed = false;
        }
      }
      j += 1;
    }
    if (items.length) {
      data[key] = items;
    } else if (Object.keys(nested).length) {
      data[key] = nested;
    } else {
      data[key] = '';
    }
    i = j;
  }

  return { data, body, raw, parsed };
}

function _scalar(v) {
  const s = String(v).trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
    (s.startsWith("'") && s.endsWith("'") && s.length > 1)
  ) {
    return s.slice(1, -1);
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => _scalar(x))
      .filter((x) => x !== '');
  }
  return s;
}

/**
 * 序列化 frontmatter + 正文。`rawFrontmatter` 非空且 `data` 未被改动时优先回吐原文,
 * 保证「读进来没动过就写回去」逐字节等价。
 *
 * @param {Record<string,any>} data
 * @param {string} body
 * @param {string} [rawFrontmatter] 原始 frontmatter 文本(优先回吐)
 * @returns {string}
 */
function serializeFrontmatter(data, body, rawFrontmatter) {
  const text = typeof body === 'string' ? body : '';
  const raw = typeof rawFrontmatter === 'string' ? rawFrontmatter : '';
  if (raw) {
    return `---\n${raw}\n---\n${text}`;
  }
  const d = data && typeof data === 'object' ? data : {};
  const keys = Object.keys(d);
  if (!keys.length) {
    return text;
  }
  const lines = [];
  for (const key of keys) {
    const value = d[key];
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
    } else if (value && typeof value === 'object') {
      lines.push(`${key}:`);
      for (const nk of Object.keys(value)) {
        lines.push(`  ${nk}: ${value[nk]}`);
      }
    } else {
      lines.push(`${key}: ${value === undefined || value === null ? '' : value}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n${text}`;
}

module.exports = {
  WALK_MAX_DEPTH,
  WALK_MAX_FILES,
  expandHome,
  probeRoot,
  isDir,
  isFile,
  homeDir,
  xdgConfigHome,
  readText,
  readJson,
  writeText,
  removeFile,
  removeDir,
  mtimeIso,
  toRelPath,
  walkFiles,
  parseFrontmatter,
  serializeFrontmatter,
};
