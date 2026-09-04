'use strict';

/**
 * memoryEngine/vectorStore.js — 记忆向量的持久化侧车（薄壳：本模块是唯一碰 fs 的一层）。
 *
 * 立法背景（记忆 RAG 铁律 F3：不引入外部向量库，SQLite 与纯文件二选一）。
 * 阶段二方案对比结论：**选纯文件 JSON 侧车**，三条理由：
 *
 *   1. **记忆量级是 10¹–10²**。memdir 记忆是人手写的结构化条目，极端几百条。
 *      SQLite 在这个场景不带来查询优势 —— 没有 ANN 索引，余弦相似度一样是全表扫描；
 *      200 条 × 768 维 ≈ 15 万次乘加，在 JS 里是微秒级。
 *   2. **pip 是命脉**（AGENTS.md 铁事实）。better-sqlite3 是原生模块；
 *      `sessionSearchIndex.js` 之所以要经 `@khy/shared/config/sqlite-adapter` 双驱动包装，
 *      正是为了规避这层风险。既然此处不需要 SQLite 的能力，就不引入它的风险。
 *   3. **与记忆目录同生命周期**。侧车就放在记忆目录里，跟着记忆一起备份/迁移；
 *      `KHY_MEMORY_DIR` 一换就自动隔离，与现有测试（换 KHY_MEMORY_DIR + paths._resetCache）
 *      零摩擦，也不需要连接管理 / WAL checkpoint / shutdown hook。
 *
 * 何时该升级到 SQLite：记忆条数超过约 2000 条，或需要跨项目共享向量。
 * 届时切 `KHY_MEMORY_VECTOR_STORE=sqlite`（开关位已预留，本轮只实现 `file`）。
 *
 * 失效判据（避免陈旧向量污染检索）：
 *   - 逐条：`hash = sha256(name \n description \n body)`。记忆内容改了 ⇒ hash 变 ⇒ 该条重嵌。
 *   - 整表：`model` 或 `dim` 与当前配置不符 ⇒ 整表作废重建（不同模型的向量空间不可比）。
 *
 * `hits` / `lastHitAt` 本轮**只写不读**：衰减立法第 3 档（冷落降权）明确不实施 ——
 * 没有真实命中数据前任何冷落降权都会压低「用得少但关键」的记忆，而那恰是 permanent
 * 记忆的典型形态。字段先留着积累数据。
 *
 * 全部 IO try/catch 静默降级：侧车损坏/不可写只意味着「每次重嵌」，绝不让记忆功能中断（F4）。
 *
 * @module memoryEngine/vectorStore
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const memdir = require('../../../../memdir/memdir');
const memdirPaths = require('../../../../memdir/paths');

/** 侧车文件名。放在记忆目录内，以 `.` 开头以免被 listMemories 的 `*.md` 过滤器看见。 */
const SIDECAR_NAME = '.vectors.json';

/** 侧车 schema 版本。结构变更时 +1，旧版本整表作废。 */
const SCHEMA_VERSION = 1;

function _envInt(name, def, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) {
    return def;
  }
  let r = n;
  if (typeof min === 'number') {
    r = Math.max(min, r);
  }
  if (typeof max === 'number') {
    r = Math.min(max, r);
  }
  return r;
}

/**
 * 存储后端。本轮只实现 `file`；`sqlite` 为预留值，命中时同样走 file
 * （不静默假装成功，但也不因为一个未实现的开关值就让记忆失效）。
 */
function backend() {
  const v = String(process.env.KHY_MEMORY_VECTOR_STORE || '')
    .trim()
    .toLowerCase();
  return v === 'sqlite' ? 'sqlite' : 'file';
}

/**
 * 向量落盘精度（小数位）。768 维 float 原样 JSON 化约 6KB/条；截到 6 位
 * 对余弦相似度的影响在 1e-6 量级（远小于任何有意义的排序差），却能显著缩小文件。
 */
function _precision() {
  return _envInt('KHY_MEMORY_VECTOR_PRECISION', 6, 2, 17);
}

/** 侧车文件字节上限。超限即拒写（有界原则），并在下次读取时整表作废重建。 */
function maxBytes() {
  return _envInt('KHY_MEMORY_VECTOR_MAX_BYTES', 32 * 1024 * 1024, 64 * 1024, 512 * 1024 * 1024);
}

/** 侧车绝对路径（跟随 memdir 的记忆目录解析，含 portable 安装）。 */
function sidecarPath() {
  return path.join(memdirPaths.getMemoryDir(), SIDECAR_NAME);
}

/**
 * 一条记忆的内容指纹。只取参与嵌入的三个字段 —— 改标题/摘要/正文都要重嵌，
 * 但仅 mtime 变化（比如被 touch 过）不该触发重嵌。
 *
 * @param {object} frontmatter
 * @param {string} body
 * @returns {string} sha256 hex
 */
function contentHash(frontmatter, body) {
  const fm = frontmatter || {};
  const material = [
    String(fm.name || ''),
    String(fm.description || ''),
    String(body || ''),
  ].join('\n');
  return crypto.createHash('sha256').update(material, 'utf-8').digest('hex');
}

function _emptyTable(model, dim) {
  return {
    version: SCHEMA_VERSION,
    model: String(model || ''),
    dim: Number.isFinite(dim) && dim > 0 ? dim : 0,
    entries: {},
  };
}

/**
 * 读侧车。任何一处不匹配就返回一张空表（作废重建），绝不返回半可信的数据。
 *
 * @param {object} [opts]
 * @param {string} [opts.model] - 期望的 embedding 模型；不符则整表作废
 * @returns {{version:number, model:string, dim:number, entries:object}}
 */
function load(opts = {}) {
  const wantModel = opts.model == null ? null : String(opts.model);
  const fresh = _emptyTable(wantModel, 0);
  let raw;
  try {
    const p = sidecarPath();
    const stat = fs.statSync(p);
    if (!stat.isFile() || stat.size > maxBytes()) {
      return fresh;
    }
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return fresh; // 不存在 / 不可读 ⇒ 空表
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return fresh; // 损坏 ⇒ 作废重建
  }
  if (!json || typeof json !== 'object' || json.version !== SCHEMA_VERSION) {
    return fresh;
  }
  if (wantModel != null && String(json.model || '') !== wantModel) {
    return fresh; // 换了 embedding 模型 ⇒ 向量空间不可比 ⇒ 整表作废
  }
  if (!json.entries || typeof json.entries !== 'object') {
    return fresh;
  }
  return {
    version: SCHEMA_VERSION,
    model: String(json.model || ''),
    dim: Number(json.dim) || 0,
    entries: json.entries,
  };
}

/**
 * 写侧车（经 memdir 的原子写 SSOT：temp 文件 + rename + 回读校验）。
 * 超过字节上限即拒写并返回 false —— 有界，不让侧车无限长大。
 *
 * @param {object} table
 * @returns {boolean} 是否真的落盘
 */
function save(table) {
  if (!table || typeof table !== 'object') {
    return false;
  }
  try {
    memdirPaths.ensureMemoryDirExists();
  } catch {
    return false;
  }
  let payload;
  try {
    payload = JSON.stringify({
      version: SCHEMA_VERSION,
      model: String(table.model || ''),
      dim: Number(table.dim) || 0,
      entries: table.entries || {},
    });
  } catch {
    return false;
  }
  if (Buffer.byteLength(payload, 'utf-8') > maxBytes()) {
    return false;
  }
  try {
    memdir._safeWriteFileSync(sidecarPath(), payload);
    return true;
  } catch {
    return false;
  }
}

/** 按精度收缩一个向量，供落盘用。 */
function _quantize(vec, digits) {
  const f = Math.pow(10, digits);
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = Math.round((Number(vec[i]) || 0) * f) / f;
  }
  return out;
}

/**
 * 取一条记忆的缓存向量。hash 不符（记忆改过）或 dim 不符即视为未命中。
 *
 * @param {object} table - load() 的返回值
 * @param {string} filename
 * @param {string} hash
 * @returns {number[]|null}
 */
function get(table, filename, hash) {
  if (!table || !table.entries) {
    return null;
  }
  const e = table.entries[filename];
  if (!e || String(e.hash) !== String(hash) || !Array.isArray(e.vec) || e.vec.length === 0) {
    return null;
  }
  if (table.dim > 0 && e.vec.length !== table.dim) {
    return null;
  }
  return e.vec;
}

/**
 * 把新嵌好的向量写进表（内存中；调用方决定何时 save）。
 * 首条向量的维度确立整表的 `dim`；维度不一致的后续向量被拒（同一模型不该产生变长向量，
 * 出现即说明端点串了，宁可不缓存）。
 *
 * @param {object} table
 * @param {Array<{filename:string, hash:string, vec:number[]}>} items
 * @param {number} [nowMs]
 * @returns {number} 实际写入条数
 */
function put(table, items, nowMs) {
  if (!table || !Array.isArray(items) || items.length === 0) {
    return 0;
  }
  if (!table.entries) {
    table.entries = {};
  }
  const digits = _precision();
  const stamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  let n = 0;
  for (const it of items) {
    if (!it || !it.filename || !Array.isArray(it.vec) || it.vec.length === 0) {
      continue;
    }
    if (!table.dim) {
      table.dim = it.vec.length;
    }
    if (it.vec.length !== table.dim) {
      continue;
    }
    const prev = table.entries[it.filename];
    table.entries[it.filename] = {
      hash: String(it.hash || ''),
      vec: _quantize(it.vec, digits),
      embeddedAt: stamp,
      // 命中计数跨重嵌保留（内容改了不代表这条记忆变冷了）。
      hits: prev && Number.isFinite(prev.hits) ? prev.hits : 0,
      lastHitAt: prev && Number.isFinite(prev.lastHitAt) ? prev.lastHitAt : null,
    };
    n++;
  }
  return n;
}

/**
 * 记一次命中（只写不读 —— 见模块头对衰减第 3 档的说明）。
 *
 * @param {object} table
 * @param {string[]} filenames
 * @param {number} [nowMs]
 * @returns {number} 实际更新条数
 */
function recordHits(table, filenames, nowMs) {
  if (!table || !table.entries || !Array.isArray(filenames)) {
    return 0;
  }
  const stamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  let n = 0;
  for (const fn of filenames) {
    const e = table.entries[fn];
    if (!e) {
      continue;
    }
    e.hits = (Number.isFinite(e.hits) ? e.hits : 0) + 1;
    e.lastHitAt = stamp;
    n++;
  }
  return n;
}

/**
 * 清掉已删除记忆的向量（记忆文件没了，向量留着只是占地方并且可能被误召回）。
 *
 * @param {object} table
 * @param {Iterable<string>} liveFilenames
 * @returns {number} 清掉的条数
 */
function prune(table, liveFilenames) {
  if (!table || !table.entries) {
    return 0;
  }
  const live = liveFilenames instanceof Set ? liveFilenames : new Set(liveFilenames || []);
  let n = 0;
  for (const fn of Object.keys(table.entries)) {
    if (!live.has(fn)) {
      delete table.entries[fn];
      n++;
    }
  }
  return n;
}

/**
 * 侧车统计（给 `khy memory` 之类的自检命令用）。
 *
 * @returns {{exists:boolean, path:string, backend:string, model:string, dim:number, count:number, bytes:number}}
 */
function stats() {
  const p = sidecarPath();
  let bytes = 0;
  let exists = false;
  try {
    const st = fs.statSync(p);
    exists = st.isFile();
    bytes = st.size;
  } catch {
    /* 不存在 */
  }
  const table = load();
  return {
    exists,
    path: p,
    backend: backend(),
    model: table.model,
    dim: table.dim,
    count: Object.keys(table.entries || {}).length,
    bytes,
  };
}

module.exports = {
  SIDECAR_NAME,
  SCHEMA_VERSION,
  backend,
  maxBytes,
  sidecarPath,
  contentHash,
  load,
  save,
  get,
  put,
  recordHits,
  prune,
  stats,
  _internals: { _quantize, _emptyTable, _precision },
};
